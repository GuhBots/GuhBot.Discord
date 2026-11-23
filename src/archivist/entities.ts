import type { Actor, ArchivistContext } from "./context.js";
import { dayText, parseDayInput } from "./dates.js";
import { cardsOf, syncGaps } from "./board.js";
import { pruneDates } from "./date-store.js";
import { getDateOrder } from "./preferences.js";
import { ArchivistError } from "./errors.js";
import {
  colorValue,
  discordId,
  newId,
  optionalText,
  requiredText,
  TEXT_LIMITS,
  timestamp,
} from "./fields.js";
import { commitMutation, type VersionedTable } from "./mutations.js";
import { nextColor } from "./palette.js";
import { resolveShortId } from "./people.js";
import { diffFields, logEntry, notFoundRecord, openForActor } from "./records.js";
import { expectedVersionValue, staleVersion } from "./versions.js";

/**
 * Characters, accounts, servers, and channels: creating them, editing their
 * own fields, and deleting them. Dated history such as aliases, names,
 * avatars, and memberships is edited separately, through the parent record.
 */

export type EntityKind = "character" | "account" | "server" | "channel";

const TABLES: Record<
  EntityKind,
  VersionedTable & ("characters" | "accounts" | "servers" | "channels")
> = {
  character: "characters",
  account: "accounts",
  server: "servers",
  channel: "channels",
};

/**
 * Links from other records that block deleting an entity. Owned history,
 * such as aliases and name observations, is removed with its parent instead.
 */
const BLOCKERS: Record<EntityKind, [label: string, table: string, column: string][]> = {
  character: [
    ["artifacts", "artifact_people", "character_id"],
    ["events", "event_people", "character_id"],
    ["missing-media requests", "request_people", "character_id"],
    ["accounts", "accounts", "character_id"],
    ["account ownership records", "account_ownerships", "character_id"],
    ["bot owner records", "bot_owners", "character_id"],
    ["server owner records", "server_owners", "character_id"],
    ["introductions", "introductions", "introducer_id"],
    ["introductions", "introductions", "introduced_id"],
  ],
  account: [
    ["artifacts", "artifact_accounts", "account_id"],
    ["server memberships", "memberships", "account_id"],
    ["main-account records", "character_main_accounts", "account_id"],
  ],
  server: [
    ["artifacts", "artifact_servers", "server_id"],
    ["events", "event_servers", "server_id"],
    ["channels", "channels", "server_id"],
    ["server memberships", "memberships", "server_id"],
    ["archive settings", "archive_meta", "main_server_id"],
  ],
  channel: [
    ["artifacts", "artifact_channels", "channel_id"],
    ["events", "event_channels", "channel_id"],
    ["threads", "channels", "parent_channel_id"],
  ],
};

function kindValue(value: unknown): EntityKind {
  if (value === "character" || value === "account" || value === "server" || value === "channel") {
    return value;
  }
  throw new ArchivistError(
    "invalid_input",
    "Kind must be character, account, server, or channel.",
    {
      field: "kind",
    },
  );
}

function optionalDiscordId(field: string, value: unknown): string | null {
  return value === undefined || value === null || value === "" ? null : discordId(field, value);
}

function assertDiscordIdFree(
  db: import("better-sqlite3").Database,
  table: string,
  id: string | null,
  exceptId?: string,
): void {
  if (
    id &&
    db
      .prepare(`SELECT 1 FROM ${table} WHERE discord_id = ? AND id IS NOT ?`)
      .get(id, exceptId ?? null)
  ) {
    throw new ArchivistError(
      "invalid_input",
      "That Discord ID is already recorded in this archive.",
      { field: "discordId" },
    );
  }
}

export interface CreatedEntity {
  kind: EntityKind;
  id: string;
  version: number;
}

function stamp(context: ArchivistContext, actor: Actor) {
  const now = timestamp(context.now());
  return { id: newId(), now, by: actor.userId };
}

export function createCharacter(
  context: ArchivistContext,
  actor: Actor,
  input: {
    archiveId: unknown;
    knownName: unknown;
    realName?: unknown;
    birthDay?: unknown;
    metInPerson?: unknown;
  },
): CreatedEntity {
  const { store } = openForActor(context, actor, input.archiveId);
  const knownName = requiredText("knownName", input.knownName, TEXT_LIMITS.name);
  const realName = optionalText("realName", input.realName, TEXT_LIMITS.name);
  const birthDay =
    input.birthDay === undefined || input.birthDay === null || input.birthDay === ""
      ? null
      : parseDayInput("birthDay", input.birthDay, getDateOrder(context, actor));
  const metInPerson = input.metInPerson ?? "unknown";
  if (metInPerson !== "unknown" && metInPerson !== "yes" && metInPerson !== "no") {
    throw new ArchivistError("invalid_input", "Met in person must be unknown, yes, or no.", {
      field: "metInPerson",
    });
  }
  const { id, now, by } = stamp(context, actor);
  commitMutation(store, {
    expectations: [{ table: "characters", id, state: "present" }],
    apply(db) {
      db.prepare(
        `INSERT INTO characters (id, created_at, created_by, updated_at, known_name, real_name, birth_day, met_in_person)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, now, by, now, knownName, realName, birthDay, metInPerson);
    },
    append: [
      logEntry(context, actor, "character", id, {
        knownName: { old: null, new: knownName },
        ...(realName ? { realName: { old: null, new: realName } } : {}),
        ...(birthDay ? { birthDay: { old: null, new: birthDay } } : {}),
        ...(metInPerson !== "unknown" ? { metInPerson: { old: null, new: metInPerson } } : {}),
      }),
    ],
  });
  return { kind: "character", id, version: 1 };
}

export function createServer(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; label: unknown; discordId?: unknown; color?: unknown },
): CreatedEntity {
  const { store } = openForActor(context, actor, input.archiveId);
  const label = requiredText("label", input.label, TEXT_LIMITS.name);
  const serverDiscordId = optionalDiscordId("discordId", input.discordId);
  assertDiscordIdFree(store.db, "servers", serverDiscordId);
  const color =
    input.color === undefined ? nextColor(store.db, "servers") : colorValue("color", input.color);
  const { id, now, by } = stamp(context, actor);
  commitMutation(store, {
    expectations: [{ table: "servers", id, state: "present" }],
    apply(db) {
      db.prepare(
        `INSERT INTO servers (id, created_at, created_by, updated_at, discord_id, label, color)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, now, by, now, serverDiscordId, label, color);
    },
    append: [
      logEntry(context, actor, "server", id, {
        label: { old: null, new: label },
        color: { old: null, new: color },
        ...(serverDiscordId ? { discordId: { old: null, new: serverDiscordId } } : {}),
      }),
    ],
  });
  return { kind: "server", id, version: 1 };
}

const CHANNEL_KINDS = ["guild_channel", "thread", "direct_message", "group_chat"] as const;
type ChannelKind = (typeof CHANNEL_KINDS)[number];

function channelKindValue(value: unknown): ChannelKind {
  if (!CHANNEL_KINDS.includes(value as ChannelKind)) {
    throw new ArchivistError(
      "invalid_input",
      "Channel kind must be guild_channel, thread, direct_message, or group_chat.",
      { field: "kind" },
    );
  }
  return value as ChannelKind;
}

/**
 * Checks where a channel sits: server channels and threads need a server,
 * direct messages and group chats have none, and only threads have a parent,
 * which must be a channel in the same server.
 */
function checkChannelPlacement(
  db: import("better-sqlite3").Database,
  kind: ChannelKind,
  serverId: string | null,
  parentChannelId: string | null,
  selfId?: string,
): void {
  const inServer = kind === "guild_channel" || kind === "thread";
  if (inServer !== (serverId !== null)) {
    throw new ArchivistError(
      "invalid_input",
      inServer
        ? "Server channels and threads need a server."
        : "Direct messages and group chats have no server.",
      { field: "serverId" },
    );
  }
  if (serverId && !db.prepare("SELECT 1 FROM servers WHERE id = ?").get(serverId)) {
    throw new ArchivistError("invalid_input", "That server does not exist in this archive.", {
      field: "serverId",
    });
  }
  if ((kind === "thread") !== (parentChannelId !== null)) {
    throw new ArchivistError(
      "invalid_input",
      "Only threads have a parent channel, and they need one.",
      { field: "parentChannelId" },
    );
  }
  if (parentChannelId) {
    const parent = db
      .prepare("SELECT server_id AS serverId, kind FROM channels WHERE id = ?")
      .get(parentChannelId) as { serverId: string | null; kind: ChannelKind } | undefined;
    if (
      !parent ||
      parentChannelId === selfId ||
      parent.kind !== "guild_channel" ||
      parent.serverId !== serverId
    ) {
      throw new ArchivistError(
        "invalid_input",
        "A thread's parent must be a channel in the same server.",
        { field: "parentChannelId" },
      );
    }
  }
}

export function createChannel(
  context: ArchivistContext,
  actor: Actor,
  input: {
    archiveId: unknown;
    kind: unknown;
    label: unknown;
    serverId?: unknown;
    parentChannelId?: unknown;
    discordId?: unknown;
    color?: unknown;
  },
): CreatedEntity {
  const { store } = openForActor(context, actor, input.archiveId);
  const kind = channelKindValue(input.kind);
  const label = requiredText("label", input.label, TEXT_LIMITS.name);
  const serverId = typeof input.serverId === "string" && input.serverId ? input.serverId : null;
  const parentChannelId =
    typeof input.parentChannelId === "string" && input.parentChannelId
      ? input.parentChannelId
      : null;
  checkChannelPlacement(store.db, kind, serverId, parentChannelId);
  const channelDiscordId = optionalDiscordId("discordId", input.discordId);
  assertDiscordIdFree(store.db, "channels", channelDiscordId);
  const color =
    input.color === undefined ? nextColor(store.db, "channels") : colorValue("color", input.color);
  const { id, now, by } = stamp(context, actor);
  commitMutation(store, {
    expectations: [{ table: "channels", id, state: "present" }],
    apply(db) {
      db.prepare(
        `INSERT INTO channels (id, created_at, created_by, updated_at, discord_id, kind, server_id, parent_channel_id, label, color)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, now, by, now, channelDiscordId, kind, serverId, parentChannelId, label, color);
    },
    append: [
      logEntry(context, actor, "channel", id, {
        kind: { old: null, new: kind },
        label: { old: null, new: label },
        color: { old: null, new: color },
        ...(serverId ? { serverId: { old: null, new: serverId } } : {}),
        ...(parentChannelId ? { parentChannelId: { old: null, new: parentChannelId } } : {}),
        ...(channelDiscordId ? { discordId: { old: null, new: channelDiscordId } } : {}),
      }),
    ],
  });
  return { kind: "channel", id, version: 1 };
}

export function createAccount(
  context: ArchivistContext,
  actor: Actor,
  input: {
    archiveId: unknown;
    kind: unknown;
    label: unknown;
    discordId?: unknown;
    characterId?: unknown;
  },
): CreatedEntity {
  const { store } = openForActor(context, actor, input.archiveId);
  if (input.kind !== "human" && input.kind !== "bot") {
    throw new ArchivistError("invalid_input", "Account kind must be human or bot.", {
      field: "kind",
    });
  }
  const kind = input.kind;
  const label = requiredText("label", input.label, TEXT_LIMITS.name);
  const accountDiscordId = optionalDiscordId("discordId", input.discordId);
  assertDiscordIdFree(store.db, "accounts", accountDiscordId);
  const characterId =
    typeof input.characterId === "string" && input.characterId ? input.characterId : null;
  if (characterId && kind === "bot") {
    throw new ArchivistError(
      "invalid_input",
      "Bot accounts record their owners separately rather than one character.",
      { field: "characterId" },
    );
  }
  if (characterId && !store.db.prepare("SELECT 1 FROM characters WHERE id = ?").get(characterId)) {
    throw new ArchivistError("invalid_input", "That character does not exist in this archive.", {
      field: "characterId",
    });
  }
  const { id, now, by } = stamp(context, actor);
  commitMutation(store, {
    expectations: [{ table: "accounts", id, state: "present" }],
    apply(db) {
      db.prepare(
        `INSERT INTO accounts (id, created_at, created_by, updated_at, discord_id, kind, label, character_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, now, by, now, accountDiscordId, kind, label, characterId);
      syncGaps(db, now, by);
    },
    append: [
      logEntry(context, actor, "account", id, {
        kind: { old: null, new: kind },
        label: { old: null, new: label },
        ...(accountDiscordId ? { discordId: { old: null, new: accountDiscordId } } : {}),
        ...(characterId ? { characterId: { old: null, new: characterId } } : {}),
      }),
    ],
  });
  return { kind: "account", id, version: 1 };
}

/** Counts each kind of link that blocks deleting an entity. */
export function entityBlockers(
  db: import("better-sqlite3").Database,
  kind: EntityKind,
  id: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [label, table, column] of BLOCKERS[kind]) {
    const { n } = db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(id) as {
      n: number;
    };
    if (n > 0) counts[label] = (counts[label] ?? 0) + n;
  }
  return counts;
}

/**
 * Refuses deleting an entity that something still links to, naming what.
 * Discord runs this before asking for confirmation, so a blocked delete is
 * refused before the Delete permanently button appears.
 */
export function assertEntityDeletable(
  db: import("better-sqlite3").Database,
  kind: EntityKind,
  id: string,
): void {
  const blockers = entityBlockers(db, kind, id);
  if (Object.keys(blockers).length === 0) return;
  const summary = Object.entries(blockers)
    .map(([label, count]) => `${count} ${label}`)
    .join(", ");
  throw new ArchivistError(
    "reference_blocked",
    `This ${kind} is still linked from ${summary}. Remove those links first.`,
    { record: kind, id, references: blockers },
  );
}

/**
 * Permanently deletes an entity once nothing links to it. Its own history and
 * its own edit-log lines go with it. There is no trash or deletion log.
 */
export function deleteEntity(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; kind: unknown; id: unknown; expectedVersion: unknown },
): void {
  const { store } = openForActor(context, actor, input.archiveId);
  const kind = kindValue(input.kind);
  const table = TABLES[kind];
  const id = resolveShortId(store.db, table, input.id, kind);
  const expectedVersion = expectedVersionValue(input.expectedVersion);
  const row = store.db.prepare(`SELECT version FROM ${table} WHERE id = ?`).get(id) as
    { version: number } | undefined;
  if (!row) throw notFoundRecord(kind);
  if (row.version !== expectedVersion) throw staleVersion(kind, id, row.version, {});
  assertEntityDeletable(store.db, kind, id);
  const cards = kind === "channel" ? [] : cardsOf(store.db, kind, id);
  const now = timestamp(context.now());
  commitMutation(store, {
    expectations: [{ table, id, state: "absent" }],
    apply(db) {
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      pruneDates(db);
      syncGaps(db, now, actor.userId);
    },
    removeRecords: [{ record: kind, id }, ...cards.map((card) => ({ record: "gap", id: card }))],
  });
}

export { kindValue as entityKindValue };

/** Fields an edit may change. Undefined leaves a field alone, and null or "" clears an optional one. */
export interface UpdateEntityInput {
  archiveId: unknown;
  kind: unknown;
  id: unknown;
  expectedVersion: unknown;
  /** Characters. */
  knownName?: unknown;
  realName?: unknown;
  birthDay?: unknown;
  metInPerson?: unknown;
  /** Accounts, servers, and channels. */
  label?: unknown;
  discordId?: unknown;
  /** Accounts: `human` or `bot`. Channels: the channel kind. */
  subkind?: unknown;
  /** Accounts. */
  characterId?: unknown;
  /** Servers and channels. */
  color?: unknown;
  /** Channels. */
  serverId?: unknown;
  parentChannelId?: unknown;
}

type Editable = Record<string, string | null>;

const COLUMNS: Record<EntityKind, Record<string, string>> = {
  character: {
    knownName: "known_name",
    realName: "real_name",
    birthDay: "birth_day",
    metInPerson: "met_in_person",
  },
  account: {
    subkind: "kind",
    label: "label",
    discordId: "discord_id",
    characterId: "character_id",
  },
  server: { label: "label", discordId: "discord_id", color: "color" },
  channel: {
    subkind: "kind",
    label: "label",
    discordId: "discord_id",
    serverId: "server_id",
    parentChannelId: "parent_channel_id",
    color: "color",
  },
};

const cleared = (value: unknown) => value === null || value === "";

/** A related record's ID from full or short form, or null when cleared. */
function relatedId(
  db: import("better-sqlite3").Database,
  table: "characters" | "servers" | "channels",
  value: unknown,
  record: string,
): string | null {
  return cleared(value) ? null : resolveShortId(db, table, value, record);
}

/**
 * Edits an entity's own fields as the contributor saw them at
 * `expectedVersion`. A stale edit is refused with the current values, and an
 * edit that changes nothing saves nothing. Dated history is edited separately.
 */
export function updateEntity(
  context: ArchivistContext,
  actor: Actor,
  input: UpdateEntityInput,
): EntityDetails {
  const { store } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  const kind = kindValue(input.kind);
  const table = TABLES[kind];
  const id = resolveShortId(db, table, input.id, kind);
  const expectedVersion = expectedVersionValue(input.expectedVersion);
  const columns = COLUMNS[kind];
  const row = db
    .prepare(`SELECT version, ${Object.values(columns).join(", ")} FROM ${table} WHERE id = ?`)
    .get(id) as (Record<string, string | null> & { version: number }) | undefined;
  if (!row) throw notFoundRecord(kind);
  const before: Editable = Object.fromEntries(
    Object.entries(columns).map(([field, column]) => [field, row[column] ?? null]),
  );
  const after: Editable = { ...before };
  const given = (field: keyof UpdateEntityInput) => field in columns && input[field] !== undefined;

  if (kind === "character") {
    if (given("knownName")) {
      after.knownName = requiredText("knownName", input.knownName, TEXT_LIMITS.name);
    }
    if (given("realName")) {
      after.realName = optionalText("realName", input.realName, TEXT_LIMITS.name);
    }
    if (given("birthDay")) {
      after.birthDay = cleared(input.birthDay)
        ? null
        : parseDayInput("birthDay", input.birthDay, getDateOrder(context, actor));
    }
    if (given("metInPerson")) {
      if (!["unknown", "yes", "no"].includes(input.metInPerson as string)) {
        throw new ArchivistError("invalid_input", "Met in person must be unknown, yes, or no.", {
          field: "metInPerson",
        });
      }
      after.metInPerson = input.metInPerson as string;
    }
  } else {
    if (given("label")) after.label = requiredText("label", input.label, TEXT_LIMITS.name);
    if (given("discordId")) {
      after.discordId = optionalDiscordId("discordId", input.discordId);
      assertDiscordIdFree(db, table, after.discordId, id);
    }
    if (given("color")) after.color = colorValue("color", input.color);
  }

  if (kind === "account") {
    if (given("subkind")) {
      if (input.subkind !== "human" && input.subkind !== "bot") {
        throw new ArchivistError("invalid_input", "Account kind must be human or bot.", {
          field: "kind",
        });
      }
      after.subkind = input.subkind;
    }
    if (given("characterId")) {
      after.characterId = relatedId(db, "characters", input.characterId, "character");
    }
    if (after.subkind === "bot" && after.characterId) {
      throw new ArchivistError(
        "invalid_input",
        "Bot accounts record their owners separately rather than one character.",
        { field: "characterId" },
      );
    }
  }

  if (kind === "channel") {
    if (given("subkind")) after.subkind = channelKindValue(input.subkind);
    if (given("serverId")) after.serverId = relatedId(db, "servers", input.serverId, "server");
    if (given("parentChannelId")) {
      after.parentChannelId = relatedId(db, "channels", input.parentChannelId, "channel");
    }
    checkChannelPlacement(
      db,
      after.subkind as ChannelKind,
      after.serverId ?? null,
      after.parentChannelId ?? null,
      id,
    );
    const threads = (
      db.prepare("SELECT count(*) AS n FROM channels WHERE parent_channel_id = ?").get(id) as {
        n: number;
      }
    ).n;
    if (threads > 0 && (after.subkind !== "guild_channel" || after.serverId !== before.serverId)) {
      throw new ArchivistError(
        "reference_blocked",
        `${threads} thread${threads === 1 ? "" : "s"} still belong to this channel. Move or delete them first.`,
        { field: "kind", references: { threads } },
      );
    }
  }

  const fields = Object.keys(columns);
  const changes = diffFields(before, after, fields);
  if (row.version !== expectedVersion) {
    const attempted = Object.fromEntries(
      Object.keys(changes).map((field) => [field, before[field]]),
    );
    throw staleVersion(kind, id, row.version, attempted);
  }
  if (Object.keys(changes).length > 0) {
    const now = timestamp(context.now());
    const set = Object.keys(changes)
      .map((field) => `${columns[field]} = @${field}`)
      .join(", ");
    commitMutation(store, {
      expectations: [{ table, id, version: row.version + 1 }],
      apply(target) {
        target
          .prepare(
            `UPDATE ${table} SET ${set}, version = version + 1, updated_at = @now WHERE id = @id AND version = @version`,
          )
          .run({ ...after, now, id, version: row.version });
        syncGaps(target, now, actor.userId);
      },
      append: [logEntry(context, actor, kind, id, changes)],
    });
  }
  return getEntity(context, actor, { archiveId: input.archiveId, kind, id });
}

export interface EntityDetails {
  kind: EntityKind;
  id: string;
  version: number;
  createdAt: string;
  createdBy: string;
  name: string;
  /** Labeled values to show, in display order. Empty values are left out. */
  fields: [label: string, value: string][];
}

/** Whole years from a birth day to `now`, for display. Age is never stored. */
export function ageOn(birthDay: string, now: Date): number {
  const [year, month, day] = birthDay.split("-").map(Number) as [number, number, number];
  let age = now.getUTCFullYear() - year;
  if (
    now.getUTCMonth() + 1 < month ||
    (now.getUTCMonth() + 1 === month && now.getUTCDate() < day)
  ) {
    age -= 1;
  }
  return age;
}

/** Reads an entity by full or short ID, with the details people need to recognize it. */
export function getEntity(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; kind: unknown; id: unknown },
): EntityDetails {
  const { store } = openForActor(context, actor, input.archiveId);
  const kind = kindValue(input.kind);
  const db = store.db;
  const id = resolveShortId(db, TABLES[kind], input.id, kind);
  const base = db
    .prepare(
      `SELECT version, created_at AS createdAt, created_by AS createdBy FROM ${TABLES[kind]} WHERE id = ?`,
    )
    .get(id) as { version: number; createdAt: string; createdBy: string };
  const name = (table: string, column: string, value: string | null) =>
    value
      ? ((
          db.prepare(`SELECT ${column} AS v FROM ${table} WHERE id = ?`).get(value) as
            { v: string } | undefined
        )?.v ?? null)
      : null;
  const fields: [string, string | null][] = [];
  let label = "";
  if (kind === "character") {
    const row = db.prepare("SELECT * FROM characters WHERE id = ?").get(id) as {
      known_name: string;
      real_name: string | null;
      birth_day: string | null;
      met_in_person: string;
    };
    label = row.known_name;
    const aliases = (
      db
        .prepare("SELECT name FROM character_aliases WHERE character_id = ? ORDER BY name")
        .all(id) as { name: string }[]
    ).map((alias) => alias.name);
    const accounts = (
      db.prepare("SELECT label FROM accounts WHERE character_id = ? ORDER BY label").all(id) as {
        label: string;
      }[]
    ).map((account) => account.label);
    fields.push(
      ["Real name", row.real_name],
      ["Aliases", aliases.join(", ") || null],
      [
        "Birth day",
        row.birth_day
          ? `${dayText(row.birth_day)} (age ${ageOn(row.birth_day, context.now())})`
          : null,
      ],
      ["Met in person", row.met_in_person],
      ["Accounts", accounts.join(", ") || null],
    );
  } else if (kind === "account") {
    const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as {
      label: string;
      kind: string;
      discord_id: string | null;
      character_id: string | null;
    };
    label = row.label;
    fields.push(
      ["Kind", row.kind],
      ["Discord ID", row.discord_id],
      [
        "Character",
        name("characters", "known_name", row.character_id) ??
          (row.kind === "human" ? "Not linked yet" : null),
      ],
    );
  } else if (kind === "server") {
    const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(id) as {
      label: string;
      discord_id: string | null;
      color: string;
    };
    label = row.label;
    fields.push(["Discord ID", row.discord_id], ["Lane color", row.color]);
  } else {
    const row = db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as {
      label: string;
      kind: string;
      discord_id: string | null;
      server_id: string | null;
      parent_channel_id: string | null;
      color: string;
    };
    label = row.label;
    fields.push(
      ["Kind", row.kind.replace("_", " ")],
      ["Server", name("servers", "label", row.server_id)],
      ["Parent channel", name("channels", "label", row.parent_channel_id)],
      ["Discord ID", row.discord_id],
      ["Lane color", row.kind === "group_chat" ? row.color : null],
    );
  }
  return {
    kind,
    id,
    ...base,
    name: label,
    fields: fields.filter((field): field is [string, string] => field[1] !== null),
  };
}
