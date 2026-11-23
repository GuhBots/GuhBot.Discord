# Archivist

The shared application code for Archivist, the archival feature described in the [Archivist plan](../../docs/proposals/ARCHIVIST-PLAN.md). The Discord commands and the optional web app call these operations, so both interfaces apply the same validation, permissions, dates, logging, and deletion rules.

Archivist is being built in milestones. This directory currently holds the storage foundation. Operations, media intake, exports, and the web server are added here as they are implemented.

## Contents

| Path | Contents |
| --- | --- |
| `errors.ts` | `ArchivistError` and the error codes both interfaces report, with their HTTP statuses |
| `fields.ts` | Shared field rules for text limits, colors, Discord IDs, archive name keys, record IDs, and timestamps |
| `dates.ts` | Date values and timezone rules for days, instants, daylight-saving gaps, and archive-day buckets |
| `paths.ts` | Archive folder layout, archive ID validation, and containment of stored paths |
| `edit-log.ts` | The `edits.log` line format, removal of a deleted record's lines, and durable file writes |
| `mutations.ts` | Journaled archive changes that keep the database, edit log, and bot-database follow-ups consistent across crashes |
| `archive-database.ts` | Opens an archive's `archive.db`, refuses newer schemas, and applies migrations |
| `operational-database.ts` | Prepares Archivist's tables in the bot's shared `guhbot.db` |
| `migrations/` | The archive and operational schemas as ordered migrations, and the code that applies them |

## Design Notes

* **No settings import.** Code here takes paths and database connections as arguments rather than reading `config.ts`, so tests can run against temporary archives. The Discord commands and the web server pass in the configured values.
* **Two version records.** An archive records its schema version in both `PRAGMA user_version` and `archive_meta.schema_version`, and each migration updates both in one transaction. Archivist's tables in `guhbot.db` use `archivist_schema` instead, because the bot database is shared with other features.
* **Refusing newer schemas.** A database newer than this build is refused before anything is written to it. There is no automatic downgrade.
* **Rollback journal for archives.** Archives use SQLite's rollback journal rather than WAL. A closed archive is then a single database file that can be copied or exported without companion files.
* **Unicode-aware name keys.** SQLite's `NOCASE` folds only ASCII letters. `archivist_archives.name_key` stores a key from `nameKey()`, which also folds accented letters, "ß", and full-width forms, and carries the uniqueness rule.
* **Crash recovery.** Each change writes a journal to `archivist-tmp/journals/` before touching the archive. The journal names the state each changed record has once the database commits, so recovery can tell a committed change from an abandoned one without storing recovery state in the portable folder. A committed change gets its log update finished. An abandoned one is discarded. Recovery runs before every later change and export. A journal that matches neither state stops further changes rather than guessing.
* **Exports avoid glob patterns.** `archiver` 8 depends on a `minimatch` version with a moderate advisory about glob pattern expansion. Exports add files from an explicit directory listing rather than glob patterns, so archive contents never reach that code path.

## Migrations

Each migration in `migrations/archive-schema.ts` or `migrations/operational-schema.ts` runs once, in its own transaction, in version order. Never edit a migration that has been released. Add a new one instead, and back up the archive before a migration that removes or rewrites data.

## Tests

[tests/archivist](../../tests/README.md) holds the automated tests for this code.
