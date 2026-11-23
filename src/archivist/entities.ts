import type { Actor, ArchivistContext } from "./context.js";
import { calendarDay } from "./dates.js";
import { pruneDates } from "./date-store.js";
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
import { logEntry, notFoundRecord, openForActor } from "./records.js";
import { expectedVersionValue, staleVersion } from "./versions.js";

/**
 * Characters, accounts, servers, and channels. This file covers creating and
 * deleting them. Names, avatars, memberships, and other history are edited
 * through their parent record.
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
): void {
  if (id && db.prepare(`SELECT 1 FROM ${table} WHERE discord_id = ?`).get(id)) {
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
      : calendarDay("birthDay", input.birthDay);
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
  if (!CHANNEL_KINDS.includes(input.kind as ChannelKind)) {
    throw new ArchivistError(
      "invalid_input",
      "Channel kind must be guild_channel, thread, direct_message, or group_chat.",
      { field: "kind" },
    );
  }
  const kind = input.kind as ChannelKind;
  const label = requiredText("label", input.label, TEXT_LIMITS.name);
  const serverId = typeof input.serverId === "string" && input.serverId ? input.serverId : null;
  const parentChannelId =
    typeof input.parentChannelId === "string" && input.parentChannelId
      ? input.parentChannelId
      : null;
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
  if (serverId && !store.db.prepare("SELECT 1 FROM servers WHERE id = ?").get(serverId)) {
    throw new ArchivistError("invalid_input", "That server does not exist in this archive.", {
      field: "serverId",
    });
  }
  if ((kind === "thread") !== (parentChannelId !== null)) {
    throw new ArchivistError(
      "invalid_input",
      "Only threads have a parent channel, and they need one.",
      {
        field: "parentChannelId",
      },
    );
  }
  if (parentChannelId) {
    const parent = store.db
      .prepare("SELECT server_id AS serverId, kind FROM channels WHERE id = ?")
      .get(parentChannelId) as { serverId: string | null; kind: ChannelKind } | undefined;
    if (!parent || parent.kind !== "guild_channel" || parent.serverId !== serverId) {
      throw new ArchivistError(
        "invalid_input",
        "A thread's parent must be a channel in the same server.",
        { field: "parentChannelId" },
      );
    }
  }
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
  const id = typeof input.id === "string" ? input.id : "";
  const expectedVersion = expectedVersionValue(input.expectedVersion);
  const row = store.db.prepare(`SELECT version FROM ${table} WHERE id = ?`).get(id) as
    { version: number } | undefined;
  if (!row) throw notFoundRecord(kind);
  if (row.version !== expectedVersion) throw staleVersion(kind, id, row.version, {});
  const blockers = entityBlockers(store.db, kind, id);
  if (Object.keys(blockers).length > 0) {
    const summary = Object.entries(blockers)
      .map(([label, count]) => `${count} ${label}`)
      .join(", ");
    throw new ArchivistError(
      "reference_blocked",
      `This ${kind} is still linked from ${summary}. Remove those links first.`,
      { record: kind, id, references: blockers },
    );
  }
  commitMutation(store, {
    expectations: [{ table, id, state: "absent" }],
    apply(db) {
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      pruneDates(db);
    },
    removeRecords: [{ record: kind, id }],
  });
}

export { kindValue as entityKindValue };
