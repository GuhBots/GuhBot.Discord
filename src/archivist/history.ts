import type Database from "better-sqlite3";
import type { Actor, ArchivistContext } from "./context.js";
import { archiveDay, type DateValue, parseDateInput } from "./dates.js";
import { insertDate, pruneDates, readDate, type StoredDate } from "./date-store.js";
import type { FieldChange } from "./edit-log.js";
import type { EntityKind } from "./entities.js";
import { ArchivistError } from "./errors.js";
import { newId, optionalText, requiredText, TEXT_LIMITS, timestamp } from "./fields.js";
import {
  insertMediaRow,
  isImage,
  mediaPaths,
  placeStagedMedia,
  type StagedMedia,
} from "./media.js";
import { commitMutation, type VersionedTable } from "./mutations.js";
import { resolveShortId } from "./lookup.js";
import { getDateOrder, inputTimeZone } from "./preferences.js";
import { logEntry, notFoundRecord, openForActor } from "./records.js";
import { expectedVersionValue, staleVersion } from "./versions.js";

/**
 * Dated history that belongs to a character, account, server, or channel:
 * aliases, names, avatars, icons, main accounts, ownership, bot owners,
 * memberships, server owners, and introductions. Adding or removing an
 * entry is an edit of its parent record, with the parent's version and log
 * identity, as the plan requires. The owner decided on 2026-11-23 that this
 * history is edited on the website only.
 *
 * Historical display uses the latest dated observation at or before the
 * chosen day. Without a day, the latest known observation is used, then an
 * undated one. Callers show a clearly marked fallback when there is none.
 */

export type HistoryKind =
  | "alias"
  | "main_account"
  | "account_name"
  | "avatar"
  | "ownership"
  | "bot_owner"
  | "membership"
  | "server_name"
  | "server_icon"
  | "server_owner"
  | "channel_name"
  | "introduction";

interface Spec {
  table: string;
  parent: EntityKind;
  parentColumn: string;
  /** The single observation date, or the start and end of an interval. */
  date?: string;
  start?: string;
  end?: string;
  /** The column holding a related record, and that record's kind. */
  target?: { column: string; kind: EntityKind };
}

const SPECS: Record<HistoryKind, Spec> = {
  alias: {
    table: "character_aliases",
    parent: "character",
    parentColumn: "character_id",
    date: "observed_date_id",
  },
  main_account: {
    table: "character_main_accounts",
    parent: "character",
    parentColumn: "character_id",
    date: "observed_date_id",
    target: { column: "account_id", kind: "account" },
  },
  account_name: {
    table: "account_names",
    parent: "account",
    parentColumn: "account_id",
    date: "observed_date_id",
  },
  avatar: {
    table: "account_avatars",
    parent: "account",
    parentColumn: "account_id",
    date: "observed_date_id",
  },
  ownership: {
    table: "account_ownerships",
    parent: "account",
    parentColumn: "account_id",
    start: "start_date_id",
    end: "end_date_id",
    target: { column: "character_id", kind: "character" },
  },
  bot_owner: {
    table: "bot_owners",
    parent: "account",
    parentColumn: "account_id",
    target: { column: "character_id", kind: "character" },
  },
  membership: {
    table: "memberships",
    parent: "account",
    parentColumn: "account_id",
    start: "joined_date_id",
    end: "left_date_id",
    target: { column: "server_id", kind: "server" },
  },
  server_name: {
    table: "server_names",
    parent: "server",
    parentColumn: "server_id",
    date: "observed_date_id",
  },
  server_icon: {
    table: "server_icons",
    parent: "server",
    parentColumn: "server_id",
    date: "observed_date_id",
  },
  server_owner: {
    table: "server_owners",
    parent: "server",
    parentColumn: "server_id",
    date: "observed_date_id",
    target: { column: "character_id", kind: "character" },
  },
  channel_name: {
    table: "channel_names",
    parent: "channel",
    parentColumn: "channel_id",
    date: "observed_date_id",
  },
  introduction: {
    table: "introductions",
    parent: "character",
    parentColumn: "introduced_id",
    date: "date_id",
    target: { column: "introducer_id", kind: "character" },
  },
};

const TABLES: Record<
  EntityKind,
  VersionedTable & ("characters" | "accounts" | "servers" | "channels")
> = {
  character: "characters",
  account: "accounts",
  server: "servers",
  channel: "channels",
};

const HISTORY_KINDS = Object.keys(SPECS) as HistoryKind[];

function historyKindValue(value: unknown): HistoryKind {
  if (typeof value === "string" && (HISTORY_KINDS as string[]).includes(value)) {
    return value as HistoryKind;
  }
  throw new ArchivistError(
    "invalid_input",
    `History kind must be one of ${HISTORY_KINDS.join(", ")}.`,
    {
      field: "kind",
    },
  );
}

function invalid(field: string, message: string): ArchivistError {
  return new ArchivistError("invalid_input", message, { field });
}

/** One history entry as shown on a record's page. */
export interface HistoryEntry {
  kind: HistoryKind;
  /** The entry's ID. A bot owner is identified by the owning character. */
  id: string;
  name: string | null;
  discriminator: string | null;
  targetId: string | null;
  targetName: string | null;
  mediaId: string | null;
  date: StoredDate | null;
  start: StoredDate | null;
  end: StoredDate | null;
}

export interface AddHistoryInput {
  archiveId: unknown;
  kind: unknown;
  /** The character, account, server, or channel the entry belongs to. */
  parentId: unknown;
  /** The parent's version as the contributor saw it. */
  expectedVersion: unknown;
  /** Aliases and names. */
  name?: unknown;
  /** Account names from before Discord dropped discriminators, such as `1234`. */
  discriminator?: unknown;
  /**
   * The related record: the account for a main account, the character for
   * ownership, bot owners, and server owners, the server for a membership,
   * and the introducer for an introduction.
   */
  targetId?: unknown;
  /** When it was observed, for single-date entries. Empty means unknown. */
  date?: unknown;
  /** Interval bounds for ownership and memberships. Empty means unknown or ongoing. */
  start?: unknown;
  end?: unknown;
  /** The image for an avatar or server icon. */
  media?: StagedMedia;
}

interface ParentRow {
  version: number;
  kind?: string;
  character_id?: string | null;
}

function nameOf(db: Database.Database, kind: EntityKind, id: string | null): string | null {
  if (!id) return null;
  const column = kind === "character" ? "known_name" : "label";
  const row = db.prepare(`SELECT ${column} AS name FROM ${TABLES[kind]} WHERE id = ?`).get(id) as
    { name: string } | undefined;
  return row?.name ?? null;
}

/** Whether `a` is later than `b`, comparing instants when both have one and archive days otherwise. */
function isLater(a: DateValue, b: DateValue, timezone: string): boolean {
  if (a.kind === "instant" && b.kind === "instant") return a.instantMs > b.instantMs;
  return archiveDay(a, timezone) > archiveDay(b, timezone);
}

/**
 * Adds a history entry to a record. The record's version increases and its
 * log gains one entry naming what was added.
 */
export function addHistory(
  context: ArchivistContext,
  actor: Actor,
  input: AddHistoryInput,
): HistoryEntry {
  const session = openForActor(context, actor, input.archiveId);
  const { store } = session;
  const db = store.db;
  const kind = historyKindValue(input.kind);
  const spec = SPECS[kind];
  const parentTable = TABLES[spec.parent];
  const parentId = resolveShortId(db, parentTable, input.parentId, spec.parent);
  const expectedVersion = expectedVersionValue(input.expectedVersion);
  const parent = db.prepare(`SELECT * FROM ${parentTable} WHERE id = ?`).get(parentId) as
    ParentRow | undefined;
  if (!parent) throw notFoundRecord(spec.parent);

  const zone = inputTimeZone(context, actor, session.details.timezone);
  const order = getDateOrder(context, actor);
  const dateValue = (field: string, value: unknown): DateValue | null =>
    value === undefined || value === null || value === ""
      ? null
      : parseDateInput(field, value, zone, order);

  let name: string | null = null;
  let discriminator: string | null = null;
  if (
    kind === "alias" ||
    kind === "server_name" ||
    kind === "channel_name" ||
    kind === "account_name"
  ) {
    name = requiredText("name", input.name, TEXT_LIMITS.name);
  }
  if (kind === "account_name") {
    discriminator = optionalText("discriminator", input.discriminator, 4);
    if (discriminator !== null && !/^\d{1,4}$/.test(discriminator)) {
      throw invalid("discriminator", "A discriminator is up to four digits, such as 1234.");
    }
  }

  let targetId: string | null = null;
  if (spec.target) {
    targetId = resolveShortId(db, TABLES[spec.target.kind], input.targetId, spec.target.kind);
  }
  if (kind === "main_account") {
    const account = db
      .prepare("SELECT kind, character_id FROM accounts WHERE id = ?")
      .get(targetId) as {
      kind: string;
      character_id: string | null;
    };
    const owned =
      account.character_id === parentId ||
      db
        .prepare("SELECT 1 FROM account_ownerships WHERE account_id = ? AND character_id = ?")
        .get(targetId, parentId) !== undefined;
    if (account.kind !== "human" || !owned) {
      throw invalid(
        "targetId",
        "A main account must be a human account this character owns or owned. Link the account first.",
      );
    }
  }
  if (
    (kind === "ownership" && parent.kind !== "human") ||
    (kind === "bot_owner" && parent.kind !== "bot")
  ) {
    throw invalid(
      "kind",
      kind === "ownership"
        ? "Bot accounts record owners, not ownership periods."
        : "Only bot accounts have owners.",
    );
  }
  if (
    kind === "bot_owner" &&
    db
      .prepare("SELECT 1 FROM bot_owners WHERE account_id = ? AND character_id = ?")
      .get(parentId, targetId)
  ) {
    throw invalid("targetId", "That character is already an owner of this bot.");
  }
  if (kind === "introduction" && targetId === parentId) {
    throw invalid("targetId", "Someone cannot introduce themselves.");
  }

  let media: StagedMedia | undefined;
  if (kind === "avatar" || kind === "server_icon") {
    media = input.media;
    if (!media) throw invalid("media", "Add the image for this avatar or icon.");
    if (!isImage(media)) throw invalid("media", "Avatars and icons must be images.");
  }

  const date = spec.date ? dateValue("date", input.date) : null;
  const start = spec.start ? dateValue("start", input.start) : null;
  const end = spec.end ? dateValue("end", input.end) : null;
  const timezone = session.details.timezone;
  if (start && end && isLater(start, end, timezone)) {
    throw invalid("end", "The end comes before the start.");
  }
  if (kind === "alias") {
    const duplicate = db
      .prepare(
        "SELECT 1 FROM character_aliases a LEFT JOIN date_values d ON d.id = a.observed_date_id WHERE a.character_id = ? AND a.name = ? AND d.archive_day IS ?",
      )
      .get(parentId, name, date ? archiveDay(date, timezone) : null);
    if (duplicate) throw invalid("name", "That alias is already recorded for this day.");
  }

  if (parent.version !== expectedVersion)
    throw staleVersion(spec.parent, parentId, parent.version, {});

  const entryId = kind === "bot_owner" ? targetId! : newId();
  const mediaId = media ? newId() : null;
  const paths = media ? mediaPaths(mediaId!, media.extension, media.previewFile !== null) : null;
  const now = timestamp(context.now());
  const logValue = compact({
    name,
    discriminator,
    [spec.target?.column.replace(/_id$/, "") ?? "target"]: targetId
      ? `${nameOf(db, spec.target!.kind, targetId)} (${targetId})`
      : undefined,
    media: mediaId ?? undefined,
    date: date?.originalText,
    start: start?.originalText,
    end: end?.originalText,
  });

  commitMutation(store, {
    expectations: [{ table: parentTable, id: parentId, version: parent.version + 1 }],
    newFiles: paths ? [paths.original, ...(paths.preview ? [paths.preview] : [])] : undefined,
    placeFiles: media && paths ? () => placeStagedMedia(store.folder, media, paths) : undefined,
    apply(target) {
      if (media && paths) insertMediaRow(target, mediaId!, paths, media, now);
      const values: Record<string, unknown> = { [spec.parentColumn]: parentId };
      if (kind !== "bot_owner") values.id = entryId;
      if (spec.date) values[spec.date] = date ? insertDate(target, date, timezone) : null;
      if (spec.start) values[spec.start] = start ? insertDate(target, start, timezone) : null;
      if (spec.end) values[spec.end] = end ? insertDate(target, end, timezone) : null;
      if (spec.target) values[spec.target.column] = targetId;
      if (name !== null) values[kind === "account_name" ? "username" : "name"] = name;
      if (kind === "account_name") values.discriminator = discriminator;
      if (mediaId) values.media_id = mediaId;
      const columns = Object.keys(values);
      target
        .prepare(
          `INSERT INTO ${spec.table} (${columns.join(", ")}) VALUES (${columns.map((c) => `@${c}`).join(", ")})`,
        )
        .run(values);
      bumpParent(target, parentTable, parentId, parent.version, now);
    },
    append: [
      logEntry(context, actor, spec.parent, parentId, { [kind]: { old: null, new: logValue } }),
    ],
  });
  return listHistory(db, spec.parent, parentId).find(
    (entry) => entry.kind === kind && entry.id === entryId,
  )!;
}

/** Removes a history entry. The parent's version increases and its log records what was removed. */
export function removeHistory(
  context: ArchivistContext,
  actor: Actor,
  input: {
    archiveId: unknown;
    kind: unknown;
    parentId: unknown;
    entryId: unknown;
    expectedVersion: unknown;
  },
): void {
  const { store } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  const kind = historyKindValue(input.kind);
  const spec = SPECS[kind];
  const parentTable = TABLES[spec.parent];
  const parentId = resolveShortId(db, parentTable, input.parentId, spec.parent);
  const expectedVersion = expectedVersionValue(input.expectedVersion);
  const parent = db.prepare(`SELECT version FROM ${parentTable} WHERE id = ?`).get(parentId) as
    { version: number } | undefined;
  if (!parent) throw notFoundRecord(spec.parent);
  const entryId = String(input.entryId ?? "");
  const entry = listHistory(db, spec.parent, parentId).find(
    (item) => item.kind === kind && item.id === entryId,
  );
  if (!entry) throw notFoundRecord("history entry");
  if (parent.version !== expectedVersion)
    throw staleVersion(spec.parent, parentId, parent.version, {});
  const now = timestamp(context.now());
  const removed: FieldChange = {
    old: compact({
      name: entry.name,
      discriminator: entry.discriminator,
      target: entry.targetId ? `${entry.targetName} (${entry.targetId})` : undefined,
      media: entry.mediaId ?? undefined,
      date: entry.date?.originalText,
      start: entry.start?.originalText,
      end: entry.end?.originalText,
    }),
    new: null,
  };
  commitMutation(store, {
    expectations: [{ table: parentTable, id: parentId, version: parent.version + 1 }],
    apply(target) {
      if (kind === "bot_owner") {
        target
          .prepare("DELETE FROM bot_owners WHERE account_id = ? AND character_id = ?")
          .run(parentId, entryId);
      } else {
        target.prepare(`DELETE FROM ${spec.table} WHERE id = ?`).run(entryId);
      }
      bumpParent(target, parentTable, parentId, parent.version, now);
      pruneDates(target);
    },
    append: [logEntry(context, actor, spec.parent, parentId, { [kind]: removed })],
  });
}

function bumpParent(
  db: Database.Database,
  table: string,
  id: string,
  version: number,
  now: string,
): void {
  db.prepare(
    `UPDATE ${table} SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
  ).run(now, id, version);
}

function compact(values: Record<string, string | null | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string] => entry[1] !== null && entry[1] !== undefined,
    ),
  );
}

/** Every history entry of a record, ordered by date with undated entries last. */
export function listHistory(
  db: Database.Database,
  parentKind: EntityKind,
  parentId: string,
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const kind of HISTORY_KINDS) {
    const spec = SPECS[kind];
    if (spec.parent !== parentKind) continue;
    const rows = db
      .prepare(`SELECT * FROM ${spec.table} WHERE ${spec.parentColumn} = ?`)
      .all(parentId) as Record<string, string | null>[];
    for (const row of rows) {
      const targetId = spec.target ? (row[spec.target.column] ?? null) : null;
      entries.push({
        kind,
        id: kind === "bot_owner" ? row.character_id! : row.id!,
        name: row.name ?? row.username ?? null,
        discriminator: row.discriminator ?? null,
        targetId,
        targetName: spec.target ? nameOf(db, spec.target.kind, targetId) : null,
        mediaId: row.media_id ?? null,
        date: spec.date ? readDate(db, row[spec.date] ?? null) : null,
        start: spec.start ? readDate(db, row[spec.start] ?? null) : null,
        end: spec.end ? readDate(db, row[spec.end] ?? null) : null,
      });
    }
  }
  const sortDay = (entry: HistoryEntry) => (entry.date ?? entry.start)?.archiveDay ?? "9999-99-99";
  return entries.sort(
    (a, b) =>
      sortDay(a).localeCompare(sortDay(b)) ||
      a.kind.localeCompare(b.kind) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * The latest observation of `column` at or before `day`, or without a day the
 * latest dated one and then an undated one. Returns null when none applies.
 */
function latest(
  db: Database.Database,
  table: string,
  parentColumn: string,
  parentId: string,
  dateColumn: string,
  day: string | undefined,
): Record<string, string | null> | null {
  const row = db
    .prepare(
      `SELECT t.* FROM ${table} t LEFT JOIN date_values d ON d.id = t.${dateColumn}
       WHERE t.${parentColumn} = @parentId AND (@day IS NULL OR d.archive_day <= @day)
       ORDER BY d.archive_day IS NULL, d.archive_day DESC, coalesce(d.instant_ms, 0) DESC, t.id DESC
       LIMIT 1`,
    )
    .get({ parentId, day: day ?? null }) as Record<string, string | null> | undefined;
  return row ?? null;
}

/** The name an account, server, or channel had on a day, or null when no observation applies. */
export function nameAt(
  db: Database.Database,
  kind: "account" | "server" | "channel",
  id: string,
  day?: string,
): string | null {
  const spec =
    SPECS[kind === "account" ? "account_name" : kind === "server" ? "server_name" : "channel_name"];
  const row = latest(db, spec.table, spec.parentColumn, id, spec.date!, day);
  return row ? (row.username ?? row.name ?? null) : null;
}

/** The icon a server had on a day, as a media ID, or null. */
export function serverIconAt(db: Database.Database, serverId: string, day?: string): string | null {
  return (
    latest(db, "server_icons", "server_id", serverId, "observed_date_id", day)?.media_id ?? null
  );
}

/** A character's main account on a day, or null. */
export function mainAccountAt(
  db: Database.Database,
  characterId: string,
  day?: string,
): string | null {
  return (
    latest(db, "character_main_accounts", "character_id", characterId, "observed_date_id", day)
      ?.account_id ?? null
  );
}

export type Picture =
  | { source: "avatar"; accountId: string; mediaId: string }
  | { source: "fallback"; mediaId: string }
  | { source: "initials" };

/**
 * A character's picture on a day: their main account's avatar then, else
 * their fallback picture, else initials. A current image is never presented
 * as historical, so the source is always returned for labeling.
 */
export function characterPictureAt(
  db: Database.Database,
  characterId: string,
  day?: string,
): Picture {
  const accountId = mainAccountAt(db, characterId, day);
  if (accountId) {
    const avatar = latest(db, "account_avatars", "account_id", accountId, "observed_date_id", day);
    if (avatar?.media_id) return { source: "avatar", accountId, mediaId: avatar.media_id };
  }
  const fallback = db
    .prepare("SELECT fallback_media_id AS id FROM characters WHERE id = ?")
    .get(characterId) as { id: string | null } | undefined;
  return fallback?.id ? { source: "fallback", mediaId: fallback.id } : { source: "initials" };
}

/**
 * Sets or clears a character's fallback picture, or a channel's icon, such
 * as a group chat's. Both are single current images rather than history.
 */
export function setPicture(
  context: ArchivistContext,
  actor: Actor,
  input: {
    archiveId: unknown;
    kind: "character" | "channel";
    id: unknown;
    expectedVersion: unknown;
    media: StagedMedia | null;
  },
): void {
  const { store } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  const table = TABLES[input.kind];
  const column = input.kind === "character" ? "fallback_media_id" : "icon_media_id";
  const id = resolveShortId(db, table, input.id, input.kind);
  const expectedVersion = expectedVersionValue(input.expectedVersion);
  const row = db
    .prepare(`SELECT version, ${column} AS media FROM ${table} WHERE id = ?`)
    .get(id) as { version: number; media: string | null } | undefined;
  if (!row) throw notFoundRecord(input.kind);
  const media = input.media;
  if (media && !isImage(media)) throw invalid("media", "Pictures and icons must be images.");
  if (row.version !== expectedVersion) throw staleVersion(input.kind, id, row.version, {});
  if (!media && !row.media) return;
  const mediaId = media ? newId() : null;
  const paths = media ? mediaPaths(mediaId!, media.extension, media.previewFile !== null) : null;
  const now = timestamp(context.now());
  const field = input.kind === "character" ? "fallbackPicture" : "icon";
  commitMutation(store, {
    expectations: [{ table, id, version: row.version + 1 }],
    newFiles: paths ? [paths.original, ...(paths.preview ? [paths.preview] : [])] : undefined,
    placeFiles: media && paths ? () => placeStagedMedia(store.folder, media, paths) : undefined,
    apply(target) {
      if (media && paths) insertMediaRow(target, mediaId!, paths, media, now);
      target
        .prepare(
          `UPDATE ${table} SET ${column} = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
        )
        .run(mediaId, now, id, row.version);
    },
    append: [
      logEntry(context, actor, input.kind, id, { [field]: { old: row.media, new: mediaId } }),
    ],
  });
}
