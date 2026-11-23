import { closeSync, fsyncSync, openSync, rmSync, writeSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { ArchivistError } from "./errors.js";
import { MAX_MEDIA_BYTES } from "./media.js";

/**
 * Bounded downloads of original files into a staging folder. A source gets
 * 30 seconds without progress and five minutes overall. Transient failures,
 * such as network errors, rate limits, and server errors, are retried at most
 * twice, after one and three seconds or a longer delay the source asks for,
 * within the overall limit. Permanent failures are not retried. A failed
 * download leaves no file behind.
 */

export type Fetch = typeof fetch;

export interface DownloadLimits {
  maxBytes: number;
  stallMs: number;
  totalMs: number;
  retryDelaysMs: readonly number[];
}

export const DOWNLOAD_LIMITS: DownloadLimits = {
  maxBytes: MAX_MEDIA_BYTES,
  stallMs: 30_000,
  totalMs: 5 * 60_000,
  retryDelaysMs: [1_000, 3_000],
};

const MAX_REDIRECTS = 3;

/** A failure worth retrying. `rateLimited` reports a 429 if retries run out. */
export class TransientDownloadError extends Error {
  constructor(
    message: string,
    readonly rateLimited = false,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/** Reads a Retry-After header given in seconds or as a date. */
export function retryAfterMs(response: Response, now = Date.now()): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** Turns an unsuccessful status into a transient error when retrying could help. */
export function transientFor(response: Response): TransientDownloadError | null {
  if (response.status === 429) {
    return new TransientDownloadError("rate limited", true, retryAfterMs(response));
  }
  if (response.status >= 500) {
    return new TransientDownloadError(
      `server error ${response.status}`,
      false,
      retryAfterMs(response),
    );
  }
  return null;
}

/**
 * Fetches a URL, following redirects only to HTTPS hosts on the allow list,
 * so a source can never point the bot at an arbitrary server.
 */
export async function fetchFromAllowedHosts(
  fetchImpl: Fetch,
  url: URL,
  init: RequestInit,
  allowedHost: (host: string) => boolean,
): Promise<Response> {
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (target.protocol !== "https:" || !allowedHost(target.hostname)) {
      throw new ArchivistError(
        "invalid_input",
        "The file is hosted somewhere Archivist does not download from.",
        {
          field: "source",
        },
      );
    }
    let response: Response;
    try {
      response = await fetchImpl(target, { ...init, redirect: "manual" });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new TransientDownloadError("network error");
    }
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) return response;
    target = new URL(location, target);
  }
  throw new ArchivistError("invalid_input", "The file link redirects too many times.", {
    field: "source",
  });
}

/**
 * Writes a response body to `file`, enforcing the size limit while reading.
 * The caller's abort controller is aborted if no data arrives within
 * `stallMs`, which ends the request.
 */
export async function writeBody(
  response: Response,
  file: string,
  limits: DownloadLimits,
  controller: AbortController,
): Promise<number> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limits.maxBytes) {
    await response.body?.cancel();
    throw new ArchivistError("media_too_large", "Files can be at most 100 MiB.", { field: "file" });
  }
  if (!response.body) throw new TransientDownloadError("empty response");

  const fd = openSync(file, "w");
  const reader = response.body.getReader();
  let bytes = 0;
  let stalled = false;
  // Aborting the request does not always end a body that is already
  // streaming, so the reader is cancelled too. A pending read then finishes.
  const stop = () => void reader.cancel().catch(() => {});
  controller.signal.addEventListener("abort", stop, { once: true });
  const armStallTimer = () =>
    setTimeout(() => {
      stalled = true;
      controller.abort();
    }, limits.stallMs);
  let timer = armStallTimer();
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (stalled) throw new TransientDownloadError("stalled");
        if (controller.signal.aborted) throw error;
        throw new TransientDownloadError("connection dropped");
      }
      if (stalled) throw new TransientDownloadError("stalled");
      if (controller.signal.aborted) throw new Error("Download aborted");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limits.maxBytes) {
        await reader.cancel();
        throw new ArchivistError("media_too_large", "Files can be at most 100 MiB.", {
          field: "file",
        });
      }
      writeSync(fd, chunk.value);
      clearTimeout(timer);
      timer = armStallTimer();
    }
    fsyncSync(fd);
    return bytes;
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", stop);
    closeSync(fd);
  }
}

/**
 * Runs `attempt` with the retry rules above. Each attempt gets its own abort
 * controller, which is also aborted when the overall time runs out.
 */
export async function withRetries<T>(
  limits: DownloadLimits,
  attempt: (controller: AbortController) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + limits.totalMs;
  for (let tries = 0; ; tries++) {
    const controller = new AbortController();
    const overall = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    try {
      return await attempt(controller);
    } catch (error) {
      const timedOut = Date.now() >= deadline;
      const transient = error instanceof TransientDownloadError ? error : null;
      if (!transient && !timedOut) throw error;
      const delay = Math.max(limits.retryDelaysMs[tries] ?? Infinity, transient?.retryAfterMs ?? 0);
      if (timedOut || tries >= limits.retryDelaysMs.length || Date.now() + delay >= deadline) {
        if (transient?.rateLimited) {
          throw new ArchivistError(
            "upstream_rate_limited",
            "The file host is limiting downloads right now. Try again in a few minutes.",
          );
        }
        throw new ArchivistError(
          "dependency_unavailable",
          timedOut || transient?.message === "stalled"
            ? "The download took too long. Try again, or attach the file instead."
            : "The file host could not be reached. Try again, or attach the file instead.",
        );
      }
      await sleep(delay);
    } finally {
      clearTimeout(overall);
    }
  }
}

/** Discord's attachment hosts. */
export function isDiscordCdn(host: string): boolean {
  return host === "cdn.discordapp.com" || host === "media.discordapp.net";
}

/** Downloads a Discord attachment into `file`. */
export async function downloadDiscordAttachment(
  url: string,
  file: string,
  options: { fetch?: Fetch; limits?: DownloadLimits } = {},
): Promise<number> {
  const fetchImpl = options.fetch ?? fetch;
  const limits = options.limits ?? DOWNLOAD_LIMITS;
  return withRetries(limits, async (controller) => {
    const response = await fetchFromAllowedHosts(
      fetchImpl,
      new URL(url),
      { signal: controller.signal },
      isDiscordCdn,
    );
    const transient = transientFor(response);
    if (transient) throw transient;
    if (!response.ok) {
      throw new ArchivistError(
        "invalid_input",
        "Discord would not provide that attachment. Upload it again.",
        { field: "file" },
      );
    }
    return writeBody(response, file, limits, controller);
  });
}
