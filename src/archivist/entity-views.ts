import type Database from "better-sqlite3";
import type { Actor, ArchivistContext } from "./context.js";
import { type EntityKind } from "./entities.js";
import { ArchivistError } from "./errors.js";
import {
  characterPictureAt,
  type HistoryEntry,
  listHistory,
  nameAt,
  type Picture,
  serverIconAt,
} from "./history.js";
import { resolveShortId } from "./lookup.js";
import { readDate, type StoredDate } from "./date-store.js";
import { DEFAULT_LIMIT, readLimit } from "./queries.js";
import { openForActor } from "./records.js";
import { FOLD_FUNCTION } from "./search.js";

/**
 * Structured records for the website: the characters and places that fill
 * its side columns, and full pages for each kind of entity with their dated
 * history. Discord's replies use `getEntity`, which flattens a record into
 * labeled lines; the website needs the fields themselves.
 */

/** Discord's IDs count milliseconds from the start of 2015 in their upper bits. */
const DISCORD_EPOCH_MS = 1_420_070_400_000n;

/**
 * When a Discord account, server, channel, or message was created, read from
 * its ID without asking Discord. Null for anything that is not an ID.
 */
export function discordCreatedAt(discordId: string | null): string | null {
  if (!discordId || !/^\d{17,20}$/.test(discordId)) return null;
  return new Date(Number((BigInt(discordId) >> 22n) + DISCORD_EPOCH_MS)).toISOString();
}

export interface CharacterSummary {
  id: string;
  version: number;
  knownName: string;
  realName: string | null;
  /** The picture on the requested day, or the latest one. */
  picture: Picture;
}

export interface PlaceSummary {
  kind: "server" | "group_chat";
  id: string;
  version: number;
  /** The name and icon in effect on the requested day, or the latest ones. */
  name: string;
  iconMediaId: string | null;
  color: string;
  discordId: string | null;
  isMain: boolean;
}

function cursorValues(cursor: unknown): [string, string] | null {
  if (cursor === undefined || cursor === "") return null;
  try {
    const values = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8")) as unknown;
    if (
      Array.isArray(values) &&
      values.length === 2 &&
      values.every((v) => typeof v === "string")
    ) {
      return values as [string, string];
    }
  } catch {
    // Reported below.
  }
  throw new ArchivistError(
    "invalid_input",
    "That page link is not valid. Start from the first page.",
    {
      field: "cursor",
    },
  );
}

function cursorOf(values: [string, string]): string {
  return Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
}

/** Characters in name order, each with their picture on `day`. */
export function listCharacters(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; day?: string; limit?: unknown; cursor?: unknown },
): { items: CharacterSummary[]; next: string | null } {
  const { store } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  const limit = input.limit === undefined ? DEFAULT_LIMIT : readLimit(input.limit);
  const after = cursorValues(input.cursor);
  const rows = db
    .prepare(
      `SELECT id, version, known_name AS knownName, real_name AS realName, ${FOLD_FUNCTION}(known_name) AS k
       FROM characters
       ${after ? "WHERE (k > @k) OR (k = @k AND id > @id)" : ""}
       ORDER BY k, id LIMIT @limit`,
    )
    .all({ k: after?.[0], id: after?.[1], limit: limit + 1 }) as (Omit<
    CharacterSummary,
    "picture"
  > & { k: string })[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(({ k: _k, ...row }) => ({
      ...row,
      picture: characterPictureAt(db, row.id, input.day),
    })),
    next: rows.length > limit && last ? cursorOf([last.k, last.id]) : null,
  };
}

/** Servers and group chats for the left column, the main server first. */
export function listPlaces(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; day?: string },
): PlaceSummary[] {
  const { store, details } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  const servers = db
    .prepare("SELECT id, version, label, color, discord_id AS discordId FROM servers")
    .all() as {
    id: string;
    version: number;
    label: string;
    color: string;
    discordId: string | null;
  }[];
  const chats = db
    .prepare(
      "SELECT id, version, label, color, discord_id AS discordId, icon_media_id AS icon FROM channels WHERE kind = 'group_chat'",
    )
    .all() as {
    id: string;
    version: number;
    label: string;
    color: string;
    discordId: string | null;
    icon: string | null;
  }[];
  const places: PlaceSummary[] = [
    ...servers.map((s) => ({
      kind: "server" as const,
      id: s.id,
      version: s.version,
      name: nameAt(db, "server", s.id, input.day) ?? s.label,
      iconMediaId: serverIconAt(db, s.id, input.day),
      color: s.color,
      discordId: s.discordId,
      isMain: s.id === details.mainServerId,
    })),
    ...chats.map((c) => ({
      kind: "group_chat" as const,
      id: c.id,
      version: c.version,
      name: nameAt(db, "channel", c.id, input.day) ?? c.label,
      iconMediaId: c.icon,
      color: c.color,
      discordId: c.discordId,
      isMain: false,
    })),
  ];
  return places.sort(
    (a, b) =>
      Number(b.isMain) - Number(a.isMain) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}

/** Display names for linked records, so a page can show them without a request per link. */
export function linkNames(
  db: Database.Database,
  links: Partial<
    Record<"characters" | "accounts" | "servers" | "channels" | "events", readonly string[]>
  >,
): Record<string, string> {
  const sources = {
    characters: "SELECT id, known_name AS name FROM characters",
    accounts: "SELECT id, label AS name FROM accounts",
    servers: "SELECT id, label AS name FROM servers",
    channels: "SELECT id, label AS name FROM channels",
    events: "SELECT id, title AS name FROM events",
  } as const;
  const names: Record<string, string> = {};
  for (const [kind, sql] of Object.entries(sources) as [keyof typeof sources, string][]) {
    const ids = links[kind];
    if (!ids?.length) continue;
    const rows = db
      .prepare(`${sql} WHERE id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids)) as { id: string; name: string }[];
    for (const row of rows) names[row.id] = row.name;
  }
  return names;
}

/* Full records */

export interface AccountView {
  kind: "account";
  id: string;
  version: number;
  accountKind: "human" | "bot";
  label: string;
  discordId: string | null;
  discordCreatedAt: string | null;
  characterId: string | null;
  history: HistoryEntry[];
  createdAt: string;
  createdBy: string;
}

export interface CharacterView {
  kind: "character";
  id: string;
  version: number;
  knownName: string;
  realName: string | null;
  birthDay: string | null;
  metInPerson: "unknown" | "yes" | "no";
  fallbackMediaId: string | null;
  /** Aliases, main accounts, and introductions. */
  history: HistoryEntry[];
  accounts: AccountView[];
  /** Every picture they have had, oldest first: account avatars, then the fallback picture. */
  pictures: { mediaId: string; date: StoredDate | null; accountId: string | null }[];
  createdAt: string;
  createdBy: string;
}

export interface ServerView {
  kind: "server";
  id: string;
  version: number;
  label: string;
  color: string;
  discordId: string | null;
  discordCreatedAt: string | null;
  isMain: boolean;
  /** Names, icons, and owners. */
  history: HistoryEntry[];
  channels: ChannelView[];
  createdAt: string;
  createdBy: string;
}

export interface ChannelView {
  kind: "channel";
  id: string;
  version: number;
  channelKind: "guild_channel" | "thread" | "direct_message" | "group_chat";
  label: string;
  color: string;
  serverId: string | null;
  parentChannelId: string | null;
  iconMediaId: string | null;
  discordId: string | null;
  discordCreatedAt: string | null;
  history: HistoryEntry[];
  createdAt: string;
  createdBy: string;
}

export type EntityView = CharacterView | AccountView | ServerView | ChannelView;

function accountView(db: Database.Database, id: string): AccountView {
  const row = db
    .prepare(
      `SELECT id, version, kind, label, discord_id AS discordId, character_id AS characterId, created_at AS createdAt, created_by AS createdBy
       FROM accounts WHERE id = ?`,
    )
    .get(id) as Omit<AccountView, "kind" | "accountKind" | "discordCreatedAt" | "history"> & {
    kind: "human" | "bot";
  };
  return {
    ...row,
    kind: "account",
    accountKind: row.kind,
    discordCreatedAt: discordCreatedAt(row.discordId),
    history: listHistory(db, "account", id),
  };
}

function channelView(db: Database.Database, id: string): ChannelView {
  const row = db
    .prepare(
      `SELECT id, version, kind, label, color, server_id AS serverId, parent_channel_id AS parentChannelId,
         icon_media_id AS iconMediaId, discord_id AS discordId, created_at AS createdAt, created_by AS createdBy
       FROM channels WHERE id = ?`,
    )
    .get(id) as Omit<ChannelView, "kind" | "channelKind" | "discordCreatedAt" | "history"> & {
    kind: ChannelView["channelKind"];
  };
  return {
    ...row,
    kind: "channel",
    channelKind: row.kind,
    discordCreatedAt: discordCreatedAt(row.discordId),
    history: listHistory(db, "channel", id),
  };
}

const TABLES: Record<EntityKind, "characters" | "accounts" | "servers" | "channels"> = {
  character: "characters",
  account: "accounts",
  server: "servers",
  channel: "channels",
};

/** A full record with its history, for its page on the website. */
export function entityView(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; kind: unknown; id: unknown },
): EntityView {
  const { store, details } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  if (typeof input.kind !== "string" || !(input.kind in TABLES)) {
    throw new ArchivistError(
      "invalid_input",
      "Kind must be character, account, server, or channel.",
      { field: "kind" },
    );
  }
  const kind = input.kind as EntityKind;
  const id = resolveShortId(db, TABLES[kind], input.id, kind);
  if (kind === "account") return accountView(db, id);
  if (kind === "channel") return channelView(db, id);
  if (kind === "server") {
    const row = db
      .prepare(
        "SELECT id, version, label, color, discord_id AS discordId, created_at AS createdAt, created_by AS createdBy FROM servers WHERE id = ?",
      )
      .get(id) as Omit<ServerView, "kind" | "discordCreatedAt" | "isMain" | "history" | "channels">;
    const channels = db
      .prepare("SELECT id FROM channels WHERE server_id = ? ORDER BY kind = 'thread', label, id")
      .all(id) as { id: string }[];
    return {
      ...row,
      kind: "server",
      discordCreatedAt: discordCreatedAt(row.discordId),
      isMain: id === details.mainServerId,
      history: listHistory(db, "server", id),
      channels: channels.map((c) => channelView(db, c.id)),
    };
  }
  const row = db
    .prepare(
      `SELECT id, version, known_name AS knownName, real_name AS realName, birth_day AS birthDay, met_in_person AS metInPerson,
         fallback_media_id AS fallbackMediaId, created_at AS createdAt, created_by AS createdBy
       FROM characters WHERE id = ?`,
    )
    .get(id) as Omit<CharacterView, "kind" | "history" | "accounts" | "pictures">;
  const accounts = (
    db.prepare("SELECT id FROM accounts WHERE character_id = ? ORDER BY label, id").all(id) as {
      id: string;
    }[]
  ).map((a) => accountView(db, a.id));
  const avatars = db
    .prepare(
      `SELECT v.account_id AS accountId, v.media_id AS mediaId, v.observed_date_id AS dateId, d.archive_day AS day
       FROM account_avatars v JOIN accounts a ON a.id = v.account_id
       LEFT JOIN date_values d ON d.id = v.observed_date_id
       WHERE a.character_id = ?
       ORDER BY d.archive_day IS NULL, d.archive_day, v.id`,
    )
    .all(id) as { accountId: string; mediaId: string; dateId: string | null }[];
  const pictures: CharacterView["pictures"] = avatars.map((a) => ({
    mediaId: a.mediaId,
    date: a.dateId ? readDate(db, a.dateId) : null,
    accountId: a.accountId,
  }));
  if (row.fallbackMediaId)
    pictures.push({ mediaId: row.fallbackMediaId, date: null, accountId: null });
  return {
    ...row,
    kind: "character",
    history: listHistory(db, "character", id),
    accounts,
    pictures,
  };
}
