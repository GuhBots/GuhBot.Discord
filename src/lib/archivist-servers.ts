import type Database from "better-sqlite3";
import {
  type CommandInteraction,
  type MessageComponentInteraction,
  MessageFlags,
  type ModalSubmitInteraction,
} from "discord.js";
import type { GuardFunction } from "discordx";
import { config } from "../config.js";
import { getDatabase } from "./database.js";

/**
 * The servers where the Archivist contributor commands work. Archivist's
 * owners add and remove them with /archivist-admin server, and the list lives
 * in the bot's database, so it changes without a restart. It decides only
 * where Discord offers the commands: the Archivist service still checks each
 * contributor's whitelist on every request.
 */

export interface ArchivistServer {
  guildId: string;
  /** The owner who added the server, or null when it was copied from ARCHIVIST_GUILD_IDS. */
  addedBy: string | null;
  /** ISO 8601 time. */
  addedAt: string;
}

export interface ServerStore {
  /** Every server, oldest first. */
  list(): ArchivistServer[];
  ids(): string[];
  has(guildId: string): boolean;
  /** Returns false when the server was already on the list. */
  add(guildId: string, addedBy: string): boolean;
  /** Returns false when the server was not on the list. */
  remove(guildId: string): boolean;
}

export interface OpenedServerStore {
  store: ServerStore;
  /** Whether this call created the list. */
  created: boolean;
  /** How many servers were copied from the starting list. */
  copied: number;
}

const TABLE = "archivist_servers";

/**
 * Opens the server list, creating it on first use. Only when it creates the
 * list does it copy `startingIds`, the servers ARCHIVIST_GUILD_IDS held before
 * the list moved into the database, so removing a server later is never
 * undone by a restart.
 */
export function openServerStore(
  database: Database.Database,
  startingIds: readonly string[],
  now: () => Date = () => new Date(),
): OpenedServerStore {
  const opened = database.transaction(() => {
    const exists = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(TABLE);
    if (exists) return { created: false, copied: 0 };
    database.exec(`
      CREATE TABLE ${TABLE} (
        guild_id TEXT PRIMARY KEY,
        added_by TEXT,
        added_at TEXT NOT NULL
      );
    `);
    const insert = database.prepare(
      `INSERT OR IGNORE INTO ${TABLE} (guild_id, added_by, added_at) VALUES (?, NULL, ?)`,
    );
    let copied = 0;
    for (const guildId of startingIds) {
      copied += insert.run(guildId, now().toISOString()).changes;
    }
    return { created: true, copied };
  })();

  const store: ServerStore = {
    list() {
      return database
        .prepare<[], ArchivistServer>(
          `SELECT guild_id AS guildId, added_by AS addedBy, added_at AS addedAt
           FROM ${TABLE} ORDER BY added_at, guild_id`,
        )
        .all();
    },
    ids() {
      return database
        .prepare<[], { guildId: string }>(`SELECT guild_id AS guildId FROM ${TABLE}`)
        .all()
        .map((row) => row.guildId);
    },
    has(guildId) {
      return (
        database.prepare(`SELECT 1 FROM ${TABLE} WHERE guild_id = ?`).get(guildId) !== undefined
      );
    },
    add(guildId, addedBy) {
      return (
        database
          .prepare(`INSERT OR IGNORE INTO ${TABLE} (guild_id, added_by, added_at) VALUES (?, ?, ?)`)
          .run(guildId, addedBy, now().toISOString()).changes > 0
      );
    },
    remove(guildId) {
      return database.prepare(`DELETE FROM ${TABLE} WHERE guild_id = ?`).run(guildId).changes > 0;
    },
  };
  return { store, ...opened };
}

let servers: ServerStore | undefined;

/** The bot's server list in `guhbot.db`, opened on first use. */
export function archivistServers(): ServerStore {
  if (!servers) {
    const opened = openServerStore(getDatabase(), config.archivistGuildIds);
    if (opened.copied) {
      console.log(
        `Archivist: copied ${opened.copied} server(s) from ARCHIVIST_GUILD_IDS into the database. ` +
          "Use /archivist-admin server to change the list from now on.",
      );
    } else if (!opened.created && config.archivistGuildIds.length) {
      console.log(
        "Archivist: ARCHIVIST_GUILD_IDS is ignored because the database already has a server list. " +
          "Use /archivist-admin server to change it.",
      );
    }
    servers = opened.store;
  }
  return servers;
}

/** For `@Guild`: the servers where the contributor commands are registered. */
export function archivistServerIds(): string[] {
  return archivistServers().ids();
}

type ArchivistInteraction =
  CommandInteraction | MessageComponentInteraction | ModalSubmitInteraction;

/**
 * A guard that refuses interactions outside the listed servers. Discord stops
 * offering the commands once a server is removed, but this also covers
 * buttons on older messages and a client that has not caught up yet.
 */
export function onlyInServers(store: () => ServerStore): GuardFunction<ArchivistInteraction> {
  return async (interaction, _client, next) => {
    if (interaction.guildId && store().has(interaction.guildId)) {
      await next();
      return;
    }
    await interaction.reply({
      content: "Archivist is not turned on in this server.",
      flags: MessageFlags.Ephemeral,
    });
  };
}

/** Use with `@Guard` on every contributor command and component class. */
export const InArchivistServer = onlyInServers(archivistServers);
