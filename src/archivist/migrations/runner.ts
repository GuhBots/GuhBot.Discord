import type Database from "better-sqlite3";
import { ArchivistError } from "../errors.js";
import { ARCHIVE_MIGRATIONS } from "./archive-schema.js";
import { OPERATIONAL_MIGRATIONS } from "./operational-schema.js";

export interface Migration {
  /** The schema version after this migration. Versions start at 1 and increase by 1. */
  version: number;
  sql: string;
  /**
   * The migration drops and recreates tables that other tables reference.
   * Foreign keys are switched off while it runs, as SQLite's documented
   * table rebuild requires, and every reference is checked before it commits.
   */
  rebuildsTables?: boolean;
}

/** Where a database records which migrations it has applied. */
export interface VersionStore {
  read(db: Database.Database): number;
  write(db: Database.Database, version: number): void;
}

export interface MigrationResult {
  from: number;
  to: number;
}

/**
 * Applies each migration newer than the database's version, one transaction
 * per migration, so an interruption leaves the database at the last complete
 * version. A database newer than this build is refused untouched, because
 * this build cannot know what the newer schema requires.
 */
export function applyMigrations(
  db: Database.Database,
  migrations: readonly Migration[],
  store: VersionStore,
  label: string,
): MigrationResult {
  const supported = migrations.at(-1)?.version ?? 0;
  const from = store.read(db);
  if (from > supported) {
    throw new ArchivistError(
      "unsupported_schema",
      `This ${label} uses schema version ${from}, but this version of GuhBot supports up to ${supported}.`,
      { schemaVersion: from, supportedVersion: supported },
    );
  }
  for (const migration of migrations) {
    if (migration.version <= from) continue;
    // Dropping a referenced table with foreign keys on would delete or block
    // the rows that point at it. The setting cannot change inside a transaction.
    const restoreForeignKeys =
      migration.rebuildsTables === true && db.pragma("foreign_keys", { simple: true }) === 1;
    if (restoreForeignKeys) db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(migration.sql);
        if (migration.rebuildsTables && (db.pragma("foreign_key_check") as unknown[]).length > 0) {
          throw new Error(`Migration ${migration.version} would leave broken references.`);
        }
        store.write(db, migration.version);
      })();
    } finally {
      if (restoreForeignKeys) db.pragma("foreign_keys = ON");
    }
  }
  return { from, to: Math.max(from, supported) };
}

/**
 * An archive records its version in `PRAGMA user_version` and, once its
 * metadata row exists, in `archive_meta.schema_version`. Both change together
 * so a reader without GuhBot sees one consistent version.
 */
const archiveVersionStore: VersionStore = {
  read: (db) => db.pragma("user_version", { simple: true }) as number,
  write(db, version) {
    db.pragma(`user_version = ${Math.trunc(version)}`);
    db.prepare("UPDATE archive_meta SET schema_version = ?").run(version);
  },
};

/**
 * The bot database is shared with other features, so Archivist keeps its own
 * version in `archivist_schema` instead of claiming `PRAGMA user_version`.
 */
const operationalVersionStore: VersionStore = {
  read(db) {
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'archivist_schema'")
      .get();
    if (!table) return 0;
    const row = db.prepare("SELECT version FROM archivist_schema WHERE singleton = 1").get() as
      { version: number } | undefined;
    return row?.version ?? 0;
  },
  write(db, version) {
    db.prepare(
      `INSERT INTO archivist_schema (singleton, version) VALUES (1, ?)
       ON CONFLICT (singleton) DO UPDATE SET version = excluded.version`,
    ).run(version);
  },
};

export function readArchiveSchemaVersion(db: Database.Database): number {
  return archiveVersionStore.read(db);
}

export function migrateArchiveDatabase(db: Database.Database): MigrationResult {
  return applyMigrations(db, ARCHIVE_MIGRATIONS, archiveVersionStore, "archive");
}

export function migrateOperationalDatabase(db: Database.Database): MigrationResult {
  return applyMigrations(db, OPERATIONAL_MIGRATIONS, operationalVersionStore, "bot database");
}
