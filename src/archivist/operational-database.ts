import type Database from "better-sqlite3";
import { migrateOperationalDatabase, type MigrationResult } from "./migrations/runner.js";

/**
 * Prepares the bot's shared `guhbot.db` connection for Archivist. Archivist's
 * tables rely on cascading deletes, and SQLite enforces foreign keys only when
 * each connection turns them on. The AFK table has no foreign keys, so this
 * does not change how it behaves.
 */
export function prepareOperationalDatabase(db: Database.Database): MigrationResult {
  db.pragma("foreign_keys = ON");
  return migrateOperationalDatabase(db);
}
