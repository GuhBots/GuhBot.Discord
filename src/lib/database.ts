import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";

let database: Database.Database | undefined;

/**
 * Opens the database on first use and creates its tables. Archivist adds its
 * own tables to this database through its migrations.
 */
export function getDatabase(): Database.Database {
  if (!database) {
    mkdirSync(config.dataDir, { recursive: true });
    database = new Database(join(config.dataDir, "guhbot.db"));
    database.pragma("journal_mode = WAL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS afk (
        user_id  TEXT PRIMARY KEY,
        reason   TEXT NOT NULL,
        mentions INTEGER NOT NULL DEFAULT 0
      );
    `);
  }
  return database;
}

export function closeDatabase(): void {
  database?.close();
  database = undefined;
}

export interface AfkStatus {
  reason: string;
  mentions: number;
}

/** AFK statuses are global. A user is AFK in every server the bot shares with them. */
export const afkStore = {
  get(userId: string): AfkStatus | undefined {
    return getDatabase()
      .prepare<[string], AfkStatus>("SELECT reason, mentions FROM afk WHERE user_id = ?")
      .get(userId);
  },

  /** Sets the user's AFK reason and resets their mention counter. */
  set(userId: string, reason: string): void {
    getDatabase()
      .prepare(
        `INSERT INTO afk (user_id, reason) VALUES (?, ?)
         ON CONFLICT (user_id) DO UPDATE SET reason = excluded.reason, mentions = 0`,
      )
      .run(userId, reason);
  },

  clear(userId: string): void {
    getDatabase().prepare("DELETE FROM afk WHERE user_id = ?").run(userId);
  },

  addMention(userId: string): void {
    getDatabase().prepare("UPDATE afk SET mentions = mentions + 1 WHERE user_id = ?").run(userId);
  },
};
