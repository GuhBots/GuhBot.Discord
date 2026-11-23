import Database from "better-sqlite3";
import { ArchivistError } from "./errors.js";
import { ARCHIVE_SCHEMA_VERSION } from "./migrations/archive-schema.js";
import { migrateArchiveDatabase, readArchiveSchemaVersion } from "./migrations/runner.js";

export interface OpenArchiveOptions {
  /** Creates the file when it does not exist. Registration and normal use leave this off. */
  create?: boolean;
}

/**
 * Opens an archive's `archive.db` and brings it to the current schema.
 *
 * The version is checked before any setting is changed, so a newer archive is
 * refused without writing to it. Archives use a rollback journal rather than
 * WAL, so a closed archive is a single database file that can be copied or
 * zipped on its own.
 */
export function openArchiveDatabase(
  file: string,
  options: OpenArchiveOptions = {},
): Database.Database {
  const db = new Database(file, { fileMustExist: !options.create });
  try {
    const version = readArchiveSchemaVersion(db);
    if (version > ARCHIVE_SCHEMA_VERSION) {
      throw new ArchivistError(
        "unsupported_schema",
        `This archive uses schema version ${version}, but this version of GuhBot supports up to ${ARCHIVE_SCHEMA_VERSION}.`,
        { schemaVersion: version, supportedVersion: ARCHIVE_SCHEMA_VERSION },
      );
    }
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = DELETE");
    db.pragma("synchronous = FULL");
    migrateArchiveDatabase(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
