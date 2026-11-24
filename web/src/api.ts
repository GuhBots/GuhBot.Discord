/**
 * The website's calls to its own server. Paths are relative to the base
 * path the server put in the page's <base> tag, such as /archivist. Errors
 * arrive as `{code, message, details}` and become `ApiError`s.
 */

export type { ArchiveDetails } from "../../src/archivist/archives.js";
export type { ArtifactDetails } from "../../src/archivist/artifacts.js";
export type { GapCard } from "../../src/archivist/board.js";
export type {
  CharacterSummary,
  CharacterView,
  EntityView,
  PlaceSummary,
} from "../../src/archivist/entity-views.js";
export type { EventDetails } from "../../src/archivist/events.js";
export type { HistoryEntry, Picture } from "../../src/archivist/history.js";
export type { ArtifactPage, ArtifactSummary, EventPage } from "../../src/archivist/queries.js";
export type { RequestDetails } from "../../src/archivist/requests.js";
export type {
  DayCounts,
  GraphView,
  TimelineLane,
  TimelineView,
} from "../../src/archivist/views.js";

/** The path the website lives under, without a trailing slash, such as `/archivist` or an empty string. */
export const BASE = new URL(document.baseURI).pathname.replace(/\/+$/, "");

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type QueryValue =
  string | number | boolean | null | undefined | readonly (string | number)[];

/** A query string from values; empty values and empty lists are left out, lists repeat the name. */
export function query(values: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(name, String(item));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export interface CallOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  json?: unknown;
  form?: FormData;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: CallOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.form) {
    body = options.form;
  }
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
      credentials: "same-origin",
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ApiError(
      0,
      "offline",
      "The website could not be reached. Check that it is still running.",
      {},
    );
  }
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => null)) as {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  } | null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.code ?? "unknown",
      data?.message ?? `The website answered ${response.status}.`,
      data?.details ?? {},
    );
  }
  return data as T;
}

/** Where an archive's file streams from. Previews exist only for still images. */
export function mediaUrl(archiveId: string, mediaId: string, preview = false): string {
  return `${BASE}/api/archives/${archiveId}/media/${mediaId}${preview ? "/preview" : ""}`;
}

export const signInUrl = `${BASE}/auth/discord`;
