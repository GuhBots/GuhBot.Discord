import type Database from "better-sqlite3";
import { type ArtifactDetails, readArtifact } from "./artifacts.js";
import type { Actor, ArchivistContext } from "./context.js";
import { calendarDay } from "./dates.js";
import { ArchivistError } from "./errors.js";
import { type EventDetails, readEvent } from "./events.js";
import { openForActor } from "./records.js";
import { FOLD_FUNCTION, foldText } from "./search.js";

/**
 * Paged, filtered lists for the website: artifacts (the album and lists),
 * and events. Filters follow the plan's shared search: every chosen category
 * must match, and any chosen value within a category matches. Cursors are
 * opaque and follow a stable order, so a page never repeats or skips a
 * record because of how it was sorted.
 */

export const MEDIA_KINDS = ["image", "video", "audio"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export const BASES = ["exact", "estimated", "file", "undated"] as const;
export type Basis = (typeof BASES)[number];
export const ARTIFACT_SORTS = ["oldest", "newest", "added"] as const;
export type ArtifactSort = (typeof ARTIFACT_SORTS)[number];

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
/** More values than this in one filter category are refused. */
const MAX_FILTER_VALUES = 100;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ArtifactFilters {
  characters: string[];
  accounts: string[];
  servers: string[];
  channels: string[];
  events: string[];
  media: MediaKind[];
  bases: Basis[];
  unidentified: boolean;
  query: string;
  fromDay: string | null;
  toDay: string | null;
}

function invalid(field: string, message: string): ArchivistError {
  return new ArchivistError("invalid_input", message, { field });
}

/** A query value that may be repeated, as `?character=a&character=b`. */
function many(value: unknown): unknown[] {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function ids(field: string, value: unknown): string[] {
  const list = many(value);
  if (list.length > MAX_FILTER_VALUES) throw invalid(field, `Choose at most ${MAX_FILTER_VALUES}.`);
  for (const item of list) {
    if (typeof item !== "string" || !ID.test(item)) throw invalid(field, "Use full record IDs.");
  }
  return [...new Set(list as string[])];
}

function choices<T extends string>(field: string, value: unknown, allowed: readonly T[]): T[] {
  const list = many(value);
  for (const item of list) {
    if (!allowed.includes(item as T)) throw invalid(field, `Choose from ${allowed.join(", ")}.`);
  }
  return [...new Set(list as T[])];
}

function optionalDay(field: string, value: unknown): string | null {
  return value === undefined || value === null || value === "" ? null : calendarDay(field, value);
}

/** Reads the shared filters from query values. Unknown IDs simply match nothing. */
export function readFilters(input: Record<string, unknown>): ArtifactFilters {
  const query = input.q === undefined ? "" : String(input.q).trim();
  if (query.length > 200) throw invalid("q", "Search for at most 200 characters.");
  const unidentified = input.unidentified;
  if (
    unidentified !== undefined &&
    !["true", "false", true, false].includes(unidentified as string)
  ) {
    throw invalid("unidentified", "Use true or false.");
  }
  const fromDay = optionalDay("fromDay", input.fromDay);
  const toDay = optionalDay("toDay", input.toDay);
  if (fromDay && toDay && toDay < fromDay)
    throw invalid("toDay", "The end day comes before the start day.");
  return {
    characters: ids("character", input.character),
    accounts: ids("account", input.account),
    servers: ids("server", input.server),
    channels: ids("channel", input.channel),
    events: ids("event", input.event),
    media: choices("media", input.media, MEDIA_KINDS),
    bases: choices("basis", input.basis, BASES),
    unidentified: unidentified === true || unidentified === "true",
    query,
    fromDay,
    toDay,
  };
}

export function readLimit(value: unknown): number {
  if (value === undefined || value === "") return DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw invalid("limit", `Use a limit from 1 to ${MAX_LIMIT}.`);
  }
  return limit;
}

export function readSort(value: unknown): ArtifactSort {
  if (value === undefined || value === "") return "oldest";
  if (!ARTIFACT_SORTS.includes(value as ArtifactSort)) {
    throw invalid("sort", `Sort by ${ARTIFACT_SORTS.join(", ")}.`);
  }
  return value as ArtifactSort;
}

/* Artifacts */

const BASIS_SQL = `CASE
  WHEN a.selected_date_id IS NULL THEN 'undated'
  WHEN a.selected_date_id = a.exact_date_id THEN 'exact'
  WHEN a.selected_date_id = a.estimated_date_id THEN 'estimated'
  ELSE 'file' END`;

const MEDIA_SQL = `CASE
  WHEN m.mime_type LIKE 'image/%' THEN 'image'
  WHEN m.mime_type LIKE 'video/%' THEN 'video'
  ELSE 'audio' END`;

/** The WHERE clause for the filters, with values passed as JSON arrays. */
function artifactWhere(filters: ArtifactFilters): { sql: string; params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  const link = (name: keyof ArtifactFilters, table: string, column: string) => {
    const values = filters[name] as string[];
    if (!values.length) return;
    params[name] = JSON.stringify(values);
    clauses.push(
      `EXISTS (SELECT 1 FROM ${table} x WHERE x.artifact_id = a.id AND x.${column} IN (SELECT value FROM json_each(@${name})))`,
    );
  };
  link("characters", "artifact_characters", "character_id");
  link("accounts", "artifact_accounts", "account_id");
  link("events", "artifact_events", "event_id");
  if (filters.servers.length) {
    // A record in one of a server's channels belongs to that server too.
    params.servers = JSON.stringify(filters.servers);
    clauses.push(`(EXISTS (SELECT 1 FROM artifact_servers x WHERE x.artifact_id = a.id AND x.server_id IN (SELECT value FROM json_each(@servers)))
      OR EXISTS (SELECT 1 FROM artifact_channels x JOIN channels c ON c.id = x.channel_id
        WHERE x.artifact_id = a.id AND c.server_id IN (SELECT value FROM json_each(@servers))))`);
  }
  if (filters.channels.length) {
    // A channel includes its threads.
    params.channels = JSON.stringify(filters.channels);
    clauses.push(`EXISTS (SELECT 1 FROM artifact_channels x JOIN channels c ON c.id = x.channel_id
      WHERE x.artifact_id = a.id AND (c.id IN (SELECT value FROM json_each(@channels)) OR c.parent_channel_id IN (SELECT value FROM json_each(@channels))))`);
  }
  if (filters.media.length) {
    params.media = JSON.stringify(filters.media);
    clauses.push(`${MEDIA_SQL} IN (SELECT value FROM json_each(@media))`);
  }
  if (filters.bases.length) {
    params.bases = JSON.stringify(filters.bases);
    clauses.push(`${BASIS_SQL} IN (SELECT value FROM json_each(@bases))`);
  }
  if (filters.unidentified) clauses.push("a.unidentified_characters = 1");
  if (filters.query) {
    params.query = foldText(filters.query);
    clauses.push(`instr(${FOLD_FUNCTION}(a.description), @query) > 0`);
  }
  if (filters.fromDay) {
    params.fromDay = filters.fromDay;
    clauses.push("d.archive_day >= @fromDay");
  }
  if (filters.toDay) {
    params.toDay = filters.toDay;
    clauses.push("d.archive_day <= @toDay");
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/** Sort keys, in order, with their direction. The last key is always the unique ID. */
const SORT_KEYS: Record<ArtifactSort, { expr: string; desc: boolean }[]> = {
  oldest: [
    { expr: "(a.selected_date_id IS NULL)", desc: false },
    { expr: "coalesce(d.archive_day, '')", desc: false },
    { expr: "a.created_at", desc: false },
    { expr: "a.id", desc: false },
  ],
  newest: [
    { expr: "(a.selected_date_id IS NULL)", desc: false },
    { expr: "coalesce(d.archive_day, '')", desc: true },
    { expr: "a.created_at", desc: true },
    { expr: "a.id", desc: true },
  ],
  added: [
    { expr: "a.created_at", desc: true },
    { expr: "a.id", desc: true },
  ],
};

type CursorValues = (string | number)[];

function encodeCursor(values: CursorValues): string {
  return Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
}

function decodeCursor(cursor: unknown, length: number): CursorValues | null {
  if (cursor === undefined || cursor === "") return null;
  try {
    const values = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8")) as unknown;
    if (
      Array.isArray(values) &&
      values.length === length &&
      values.every((v) => typeof v === "string" || typeof v === "number")
    ) {
      return values as CursorValues;
    }
  } catch {
    // Reported below.
  }
  throw invalid("cursor", "That page link is not valid. Start from the first page.");
}

/** `(k1, k2, ...) > (v1, v2, ...)` in each key's own direction. */
function afterCursor(
  keys: { expr: string; desc: boolean }[],
  params: Record<string, unknown>,
  values: CursorValues,
): string {
  const parts: string[] = [];
  keys.forEach((key, i) => {
    params[`c${i}`] = values[i];
    const equal = keys.slice(0, i).map((k, j) => `${k.expr} = @c${j}`);
    parts.push(`(${[...equal, `${key.expr} ${key.desc ? "<" : ">"} @c${i}`].join(" AND ")})`);
  });
  return `(${parts.join(" OR ")})`;
}

/** One artifact in a list: enough for a tile, a dot, or a row. */
export interface ArtifactSummary {
  id: string;
  version: number;
  description: string;
  /** The archive day of the selected date, or null when undated. */
  day: string | null;
  basis: Basis;
  media: {
    id: string;
    kind: MediaKind;
    mimeType: string;
    filename: string;
    hasPreview: boolean;
    readable: boolean;
  };
  characterIds: string[];
  eventIds: string[];
  /** The timeline lanes it belongs to: server IDs and group chat IDs, or `unassigned`. */
  lanes: string[];
  channelIds: string[];
  unidentifiedCharacters: boolean;
  createdAt: string;
}

/** The lanes an artifact appears on: its servers, its channels' servers, and its group chats. */
export function artifactLanes(
  db: Database.Database,
  details: Pick<ArtifactDetails, "links">,
): string[] {
  const lanes = new Set(details.links.servers);
  for (const channelId of details.links.channels) {
    const channel = db
      .prepare("SELECT kind, server_id AS serverId FROM channels WHERE id = ?")
      .get(channelId) as { kind: string; serverId: string | null } | undefined;
    if (channel?.serverId) lanes.add(channel.serverId);
    else if (channel?.kind === "group_chat") lanes.add(channelId);
  }
  return lanes.size ? [...lanes].sort() : ["unassigned"];
}

export function summarizeArtifact(
  db: Database.Database,
  details: ArtifactDetails,
): ArtifactSummary {
  const selected = details.dates.selected;
  const mime = details.media.mimeType;
  return {
    id: details.id,
    version: details.version,
    description: details.description,
    day: selected?.date.archiveDay ?? null,
    basis: selected?.basis ?? "undated",
    media: {
      id: details.media.id,
      kind: mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "audio",
      mimeType: mime,
      filename: details.media.originalFilename,
      hasPreview: details.media.hasPreview,
      readable: details.media.readable,
    },
    characterIds: details.links.characters,
    eventIds: details.links.events,
    lanes: artifactLanes(db, details),
    channelIds: details.links.channels,
    unidentifiedCharacters: details.unidentifiedCharacters,
    createdAt: details.createdAt,
  };
}

export interface ArtifactPage {
  items: ArtifactSummary[];
  /** The cursor for the next page, or null on the last page. */
  next: string | null;
  /** How many artifacts match the filters in all. */
  total: number;
}

export function listArtifacts(
  context: ArchivistContext,
  actor: Actor,
  input: {
    archiveId: unknown;
    filters: ArtifactFilters;
    sort?: ArtifactSort;
    limit?: number;
    cursor?: unknown;
  },
): ArtifactPage {
  const { store } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  const sort = input.sort ?? "oldest";
  const limit = input.limit ?? DEFAULT_LIMIT;
  const keys = SORT_KEYS[sort];
  const { sql: where, params } = artifactWhere(input.filters);
  const from =
    "FROM artifacts a JOIN media m ON m.id = a.media_id LEFT JOIN date_values d ON d.id = a.selected_date_id";
  const total = (db.prepare(`SELECT count(*) AS n ${from} ${where}`).get(params) as { n: number })
    .n;
  const cursor = decodeCursor(input.cursor, keys.length);
  const pageParams = { ...params, limit: limit + 1 };
  const conditions = [where.replace(/^WHERE /, "")].filter(Boolean);
  if (cursor) conditions.push(afterCursor(keys, pageParams, cursor));
  const rows = db
    .prepare(
      `SELECT a.id, ${keys.map((k, i) => `${k.expr} AS k${i}`).join(", ")} ${from}
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY ${keys.map((k) => `${k.expr} ${k.desc ? "DESC" : "ASC"}`).join(", ")}
       LIMIT @limit`,
    )
    .all(pageParams) as Record<string, string | number>[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => summarizeArtifact(db, readArtifact(db, row.id as string)!)),
    next: rows.length > limit && last ? encodeCursor(keys.map((_, i) => last[`k${i}`]!)) : null,
    total,
  };
}

/* Events */

export interface EventFilters {
  characters: string[];
  servers: string[];
  channels: string[];
  query: string;
  fromDay: string | null;
  toDay: string | null;
}

export function readEventFilters(input: Record<string, unknown>): EventFilters {
  const shared = readFilters(input);
  return {
    characters: shared.characters,
    servers: shared.servers,
    channels: shared.channels,
    query: shared.query,
    fromDay: shared.fromDay,
    toDay: shared.toDay,
  };
}

export interface EventPage {
  items: EventDetails[];
  next: string | null;
  total: number;
}

/**
 * Events in order of their start, then ID. A date range keeps events whose
 * span overlaps it, so a duration or occurrence window that crosses the
 * range is included.
 */
export function listEvents(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; filters: EventFilters; limit?: number; cursor?: unknown },
): EventPage {
  const { store } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const { filters } = input;
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.characters.length) {
    params.characters = JSON.stringify(filters.characters);
    clauses.push(
      "EXISTS (SELECT 1 FROM event_characters x WHERE x.event_id = e.id AND x.character_id IN (SELECT value FROM json_each(@characters)))",
    );
  }
  if (filters.servers.length) {
    params.servers = JSON.stringify(filters.servers);
    clauses.push(`(EXISTS (SELECT 1 FROM event_servers x WHERE x.event_id = e.id AND x.server_id IN (SELECT value FROM json_each(@servers)))
      OR EXISTS (SELECT 1 FROM event_channels x JOIN channels c ON c.id = x.channel_id
        WHERE x.event_id = e.id AND c.server_id IN (SELECT value FROM json_each(@servers))))`);
  }
  if (filters.channels.length) {
    params.channels = JSON.stringify(filters.channels);
    clauses.push(`EXISTS (SELECT 1 FROM event_channels x JOIN channels c ON c.id = x.channel_id
      WHERE x.event_id = e.id AND (c.id IN (SELECT value FROM json_each(@channels)) OR c.parent_channel_id IN (SELECT value FROM json_each(@channels))))`);
  }
  if (filters.query) {
    params.query = foldText(filters.query);
    clauses.push(
      `(instr(${FOLD_FUNCTION}(e.title), @query) > 0 OR instr(${FOLD_FUNCTION}(e.description), @query) > 0)`,
    );
  }
  if (filters.toDay) {
    params.toDay = filters.toDay;
    clauses.push("s.archive_day <= @toDay");
  }
  if (filters.fromDay) {
    params.fromDay = filters.fromDay;
    clauses.push("coalesce(f.archive_day, s.archive_day) >= @fromDay");
  }
  const from = `FROM events e JOIN date_values s ON s.id = e.start_date_id LEFT JOIN date_values f ON f.id = e.end_date_id`;
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT count(*) AS n ${from} ${where}`).get(params) as { n: number })
    .n;
  const keys = [
    { expr: "s.archive_day", desc: false },
    { expr: "e.id", desc: false },
  ];
  const cursor = decodeCursor(input.cursor, keys.length);
  const pageParams: Record<string, unknown> = { ...params, limit: limit + 1 };
  const conditions = [...clauses];
  if (cursor) conditions.push(afterCursor(keys, pageParams, cursor));
  const rows = db
    .prepare(
      `SELECT e.id, s.archive_day AS k0, e.id AS k1 ${from}
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY s.archive_day, e.id LIMIT @limit`,
    )
    .all(pageParams) as { id: string; k0: string; k1: string }[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => readEvent(db, row.id)!),
    next: rows.length > limit && last ? encodeCursor([last.k0, last.k1]) : null,
    total,
  };
}
