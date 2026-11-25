import { config } from "../config.js";
import { ArchivistError, isErrorCode } from "./archivist-errors.js";

/**
 * The bot's client for the Archivist service's JSON API. The service owns the
 * archives and their rules. The bot sends the shared service token and names
 * the Discord user who ran the command, and the service checks that user's
 * access on every request. See docs/design/bot-api.md in GuhBot.Archivist.
 *
 * Reads are retried a couple of times when the service is briefly
 * unreachable. Changes are never retried, because a change that timed out
 * may have been saved. Redirects are refused so the token never reaches
 * another address. There is no fallback: when the service is down, commands
 * say so and nothing is saved anywhere else.
 */

export type Fetch = typeof fetch;
export type QueryValue =
  string | number | boolean | null | undefined | readonly (string | number)[];
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Deadlines for one request. Uploads include the service fetching a Drive file, up to five minutes. */
const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 6 * 60_000;
const READ_RETRY_DELAYS_MS = [500, 1_500];
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

export interface ArchivistApiOptions {
  /** The service's base address, including any path such as `/archivist`. */
  baseUrl: string;
  /** The shared service token, `ARCHIVIST_SERVICE_TOKEN`. */
  token: string;
  /** Replaced in tests. */
  fetch?: Fetch;
  /** Replaced in tests, so retries do not wait. */
  sleep?(ms: number): Promise<void>;
}

interface Call {
  method: Method;
  path: string;
  /** The Discord user the request acts for. Null for the bot's own routes. */
  userId: string | null;
  query?: Record<string, QueryValue>;
  json?: unknown;
  form?: FormData;
  timeoutMs: number;
}

/** A path under an archive, with each part encoded. */
export function archivePath(archiveId: string, ...parts: string[]): string {
  return ["", "api", "archives", archiveId, ...parts].map(encodeURIComponent).join("/");
}

function queryString(values: Record<string, QueryValue> = {}): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(name, String(item));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function unreachable(reason: string, message: string): ArchivistError {
  return new ArchivistError("dependency_unavailable", message, { reason });
}

export class ArchivistApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: Fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ArchivistApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get<T>(userId: string, path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.send({ method: "GET", path, userId, query, timeoutMs: READ_TIMEOUT_MS });
  }

  post<T>(userId: string, path: string, json?: unknown): Promise<T> {
    return this.send({ method: "POST", path, userId, json, timeoutMs: WRITE_TIMEOUT_MS });
  }

  put<T>(userId: string, path: string, json?: unknown): Promise<T> {
    return this.send({ method: "PUT", path, userId, json, timeoutMs: WRITE_TIMEOUT_MS });
  }

  patch<T>(userId: string, path: string, json?: unknown): Promise<T> {
    return this.send({ method: "PATCH", path, userId, json, timeoutMs: WRITE_TIMEOUT_MS });
  }

  delete<T>(userId: string, path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.send({ method: "DELETE", path, userId, query, timeoutMs: WRITE_TIMEOUT_MS });
  }

  /** Sends a multipart form, such as an artifact with its file. Put the file last. */
  upload<T>(userId: string, path: string, form: FormData): Promise<T> {
    return this.send({ method: "POST", path, userId, form, timeoutMs: UPLOAD_TIMEOUT_MS });
  }

  /** A route of the bot's own that acts for no contributor, such as claiming announcements. */
  service<T>(method: "GET" | "POST", path: string, json?: unknown): Promise<T> {
    return this.send({ method, path, userId: null, json, timeoutMs: WRITE_TIMEOUT_MS });
  }

  /** Downloads bytes, such as a preview image, as the user or as the bot itself. */
  async bytes(userId: string | null, path: string): Promise<Buffer> {
    const response = await this.fetchWithRetries({
      method: "GET",
      path,
      userId,
      timeoutMs: READ_TIMEOUT_MS,
    });
    if (!response.ok) throw await this.failure(response);
    return Buffer.from(await response.arrayBuffer());
  }

  private async send<T>(call: Call): Promise<T> {
    const response = await this.fetchWithRetries(call);
    if (!response.ok) throw await this.failure(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async fetchWithRetries(call: Call): Promise<Response> {
    const delays = call.method === "GET" ? READ_RETRY_DELAYS_MS : [];
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.fetchOnce(call);
        if (attempt < delays.length && RETRYABLE_STATUSES.has(response.status)) {
          await response.body?.cancel();
          await this.sleep(delays[attempt]!);
          continue;
        }
        return response;
      } catch (error) {
        if (error instanceof ArchivistError) throw error;
        if (attempt < delays.length) {
          await this.sleep(delays[attempt]!);
          continue;
        }
        const timedOut = (error as Error | null)?.name === "TimeoutError";
        if (call.method === "GET") {
          throw unreachable(
            timedOut ? "service_timeout" : "service_unreachable",
            "Archivist is not reachable right now. Try again in a moment.",
          );
        }
        // The service may have saved the change before the connection failed.
        throw unreachable(
          timedOut ? "service_timeout" : "service_unreachable",
          "Archivist did not answer, so your change may or may not have been saved. Check before trying again.",
        );
      }
    }
  }

  private async fetchOnce(call: Call): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.options.token}`,
    };
    if (call.userId !== null) headers["x-archivist-user"] = call.userId;
    let body: FormData | string | undefined;
    if (call.form) {
      body = call.form;
    } else if (call.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(call.json);
    }
    const response = await this.fetchImpl(`${this.baseUrl}${call.path}${queryString(call.query)}`, {
      method: call.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(call.timeoutMs),
    });
    if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
      await response.body?.cancel();
      throw unreachable(
        "redirected",
        "Archivist answered with a redirect, which the bot does not follow. Check ARCHIVIST_API_URL.",
      );
    }
    return response;
  }

  private async failure(response: Response): Promise<ArchivistError> {
    if (response.status === 401) {
      await response.body?.cancel();
      // The bot never holds a browser session, so a 401 means the token is wrong.
      // That is the operator's problem, not the contributor's.
      return new ArchivistError(
        "dependency_unavailable",
        "The bot could not authenticate with Archivist. Tell the bot owner to check ARCHIVIST_SERVICE_TOKEN.",
        { reason: "service_auth" },
        401,
      );
    }
    const body = (await response.json().catch(() => null)) as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
    } | null;
    const details =
      body?.details && typeof body.details === "object"
        ? (body.details as Record<string, unknown>)
        : {};
    if (body && isErrorCode(body.code) && typeof body.message === "string") {
      return new ArchivistError(body.code, body.message, details, response.status);
    }
    return new ArchivistError(
      response.status >= 500 ? "internal_error" : "dependency_unavailable",
      "Archivist could not finish that. Nothing was half-saved. Try again, and tell the bot owner if it keeps happening.",
      { status: response.status },
      response.status,
    );
  }
}

let client: ArchivistApi | undefined;

/**
 * The client for the configured service. The Archivist module needs both
 * `ARCHIVIST_API_URL` and `ARCHIVIST_SERVICE_TOKEN`.
 */
export function archivistApi(): ArchivistApi {
  if (!client) {
    const { url, token } = config.archivistApi;
    if (!url || !token) {
      throw new Error(
        "Set ARCHIVIST_API_URL and ARCHIVIST_SERVICE_TOKEN to use the Archivist module, or remove it from MODULES.",
      );
    }
    let address: URL;
    try {
      address = new URL(url);
    } catch {
      throw new Error(
        `ARCHIVIST_API_URL must be a full address, such as https://example.com/archivist.`,
      );
    }
    if (!["http:", "https:"].includes(address.protocol) || address.search || address.hash) {
      throw new Error("ARCHIVIST_API_URL must be an http or https address with no query.");
    }
    client = new ArchivistApi({ baseUrl: url, token });
  }
  return client;
}
