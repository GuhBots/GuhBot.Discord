import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { openArchiveDatabase } from "../../../src/archivist/archive-database.js";
import { ArchivistError } from "../../../src/archivist/errors.js";
import {
  ARCHIVE_MIGRATIONS,
  ARCHIVE_SCHEMA_VERSION,
} from "../../../src/archivist/migrations/archive-schema.js";
import { applyMigrations, type VersionStore } from "../../../src/archivist/migrations/runner.js";
import { makeTempDir } from "../helpers/temp-dir.js";

/** The archive tables the plan's data contract defines. */
const ARCHIVE_TABLES = [
  "account_avatars",
  "account_names",
  "account_ownerships",
  "accounts",
  "archive_meta",
  "artifact_accounts",
  "artifact_channels",
  "artifact_characters",
  "artifact_events",
  "artifact_servers",
  "artifacts",
  "bot_owners",
  "channel_names",
  "channels",
  "character_aliases",
  "character_main_accounts",
  "characters",
  "date_values",
  "event_channels",
  "event_characters",
  "event_servers",
  "events",
  "gap_cards",
  "introductions",
  "media",
  "memberships",
  "request_artifacts",
  "request_characters",
  "request_events",
  "research_requests",
  "server_icons",
  "server_names",
  "server_owners",
  "servers",
];

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

function fileHash(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const NOW = "2026-11-23T00:00:00.000Z";

function insertMeta(db: Database.Database): void {
  db.prepare(
    `INSERT INTO archive_meta (singleton, archive_id, schema_version, name, created_at)
     VALUES (1, 'archive-1', ?, 'Test Archive', ?)`,
  ).run(db.pragma("user_version", { simple: true }), NOW);
}

test("a new archive gets every contract table at the current schema version", (t) => {
  const file = join(makeTempDir(t), "archive.db");
  const db = openArchiveDatabase(file, { create: true });
  t.after(() => db.close());

  assert.deepEqual(tableNames(db), ARCHIVE_TABLES);
  assert.equal(db.pragma("user_version", { simple: true }), ARCHIVE_SCHEMA_VERSION);
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(db.pragma("journal_mode", { simple: true }), "delete");
});

test("reopening an archive keeps its data and version", (t) => {
  const file = join(makeTempDir(t), "archive.db");
  const first = openArchiveDatabase(file, { create: true });
  insertMeta(first);
  first.close();

  const second = openArchiveDatabase(file);
  t.after(() => second.close());
  const meta = second.prepare("SELECT name, schema_version FROM archive_meta").get();
  assert.deepEqual(meta, { name: "Test Archive", schema_version: ARCHIVE_SCHEMA_VERSION });
  assert.equal(second.pragma("user_version", { simple: true }), ARCHIVE_SCHEMA_VERSION);
});

test("an archive from a newer GuhBot is refused without being modified", (t) => {
  const file = join(makeTempDir(t), "archive.db");
  const newer = new Database(file);
  newer.exec("CREATE TABLE future_table (id TEXT)");
  newer.pragma("user_version = 99");
  newer.close();
  const before = fileHash(file);

  assert.throws(
    () => openArchiveDatabase(file),
    (error) =>
      error instanceof ArchivistError &&
      error.code === "unsupported_schema" &&
      error.details.schemaVersion === 99,
  );
  assert.equal(fileHash(file), before);
});

test("opening a missing archive fails instead of creating an empty one", (t) => {
  const file = join(makeTempDir(t), "missing.db");
  assert.throws(() => openArchiveDatabase(file));
});

test("archive relationships must point at records in the same archive", (t) => {
  const db = openArchiveDatabase(join(makeTempDir(t), "archive.db"), { create: true });
  t.after(() => db.close());
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO artifact_characters (artifact_id, character_id) VALUES (?, ?)")
        .run("no-artifact", "no-character"),
    /FOREIGN KEY constraint failed/,
  );
});

test("the selected artifact date must follow exact, estimated, then file precedence", (t) => {
  const db = openArchiveDatabase(join(makeTempDir(t), "archive.db"), { create: true });
  t.after(() => db.close());
  const day = db.prepare(
    `INSERT INTO date_values (id, kind, original_text, calendar_day, archive_day)
     VALUES (?, 'day', ?, ?, ?)`,
  );
  day.run("exact", "2019-07-15", "2019-07-15", "2019-07-15");
  day.run("file", "2019-07-16", "2019-07-16", "2019-07-16");
  db.prepare(
    `INSERT INTO media (id, original_path, original_filename, mime_type, byte_length, sha256, created_at)
     VALUES ('media-1', 'media/originals/media-1.png', 'a.png', 'image/png', 10, ?, ?)`,
  ).run("0".repeat(64), NOW);
  const insertArtifact = (selected: string) =>
    db
      .prepare(
        `INSERT INTO artifacts (id, created_at, created_by, updated_at, media_id, description,
           source_provider, source_key, exact_date_id, exact_basis, file_date_id, selected_date_id)
         VALUES ('artifact-1', ?, '1', ?, 'media-1', 'A photo', 'web_upload', 'upload-1',
           'exact', 'Message timestamp', 'file', ?)`,
      )
      .run(NOW, NOW, selected);

  assert.throws(() => insertArtifact("file"), /CHECK constraint failed/);
  insertArtifact("exact");
});

const archiveVersions: VersionStore = {
  read: (db) => db.pragma("user_version", { simple: true }) as number,
  write(db, version) {
    db.pragma(`user_version = ${version}`);
    db.prepare("UPDATE archive_meta SET schema_version = ?").run(version);
  },
};

test("version 2 keeps every artifact, its links, and an old exact basis", (t) => {
  const file = join(makeTempDir(t), "archive.db");
  const old = new Database(file);
  applyMigrations(old, ARCHIVE_MIGRATIONS.slice(0, 1), archiveVersions, "archive");
  insertMeta(old);
  old.exec(`
    INSERT INTO date_values (id, kind, original_text, calendar_day, archive_day)
      VALUES ('d1', 'day', '2019-07-15', '2019-07-15', '2019-07-15');
    INSERT INTO media (id, original_path, original_filename, mime_type, byte_length, sha256, created_at)
      VALUES ('m1', 'media/originals/m1.png', 'a.png', 'image/png', 10, '${"0".repeat(64)}', '${NOW}'),
             ('m2', 'media/originals/m2.png', 'b.png', 'image/png', 10, '${"1".repeat(64)}', '${NOW}');
    INSERT INTO characters (id, created_at, created_by, updated_at, known_name)
      VALUES ('c1', '${NOW}', '1', '${NOW}', 'Sam');
    INSERT INTO artifacts (id, version, created_at, created_by, updated_at, media_id, description,
        source_provider, source_key, exact_date_id, exact_basis, selected_date_id, identification_state)
      VALUES ('a1', 3, '${NOW}', '1', '${NOW}', 'm1', 'Meetup', 'web_upload', 'u1', 'd1', 'Chat log', 'd1', 'incomplete'),
             ('a2', 1, '${NOW}', '1', '${NOW}', 'm2', 'Screenshot', 'web_upload', 'u2', NULL, NULL, NULL, 'complete');
    INSERT INTO artifact_people (artifact_id, character_id) VALUES ('a1', 'c1');
    INSERT INTO events (id, created_at, created_by, updated_at, title, description, date_kind,
        certainty, start_date_id, exact_basis, color)
      VALUES ('e1', '${NOW}', '1', '${NOW}', 'Launch', 'Server opened', 'single', 'exact', 'd1', 'Pinned message', '#3366cc');
    INSERT INTO artifact_events (artifact_id, event_id) VALUES ('a1', 'e1');
  `);
  old.close();

  // Stop at version 2, so the names it used are still there.
  const db = new Database(file);
  t.after(() => db.close());
  db.pragma("foreign_keys = ON");
  applyMigrations(db, ARCHIVE_MIGRATIONS.slice(0, 2), archiveVersions, "archive");
  assert.equal(db.pragma("user_version", { simple: true }), 2);
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.deepEqual(
    db
      .prepare("SELECT id, version, exact_basis, unidentified_people FROM artifacts ORDER BY id")
      .all(),
    [
      { id: "a1", version: 3, exact_basis: "Chat log", unidentified_people: 1 },
      { id: "a2", version: 1, exact_basis: null, unidentified_people: 0 },
    ],
  );
  assert.equal(
    (db.prepare("SELECT count(*) AS n FROM artifact_people").get() as { n: number }).n,
    1,
  );
  assert.equal(
    (db.prepare("SELECT exact_basis FROM events WHERE id = 'e1'").get() as { exact_basis: string })
      .exact_basis,
    "Pinned message",
  );
  assert.deepEqual(db.pragma("foreign_key_check"), []);

  // An exact date no longer needs a basis, and links still cascade on delete.
  db.prepare("UPDATE artifacts SET exact_basis = NULL WHERE id = 'a1'").run();
  db.prepare("DELETE FROM artifacts WHERE id = 'a1'").run();
  assert.equal(
    (db.prepare("SELECT count(*) AS n FROM artifact_events").get() as { n: number }).n,
    0,
  );
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO artifact_people (artifact_id, character_id) VALUES ('none', 'c1')")
        .run(),
    /FOREIGN KEY constraint failed/,
  );
});

test("version 3 renames people to characters and keeps every row", (t) => {
  const file = join(makeTempDir(t), "archive.db");
  const old = new Database(file);
  old.pragma("foreign_keys = ON");
  applyMigrations(old, ARCHIVE_MIGRATIONS.slice(0, 1), archiveVersions, "archive");
  insertMeta(old);
  applyMigrations(old, ARCHIVE_MIGRATIONS.slice(0, 2), archiveVersions, "archive");
  old.exec(`
    INSERT INTO date_values (id, kind, original_text, calendar_day, archive_day)
      VALUES ('d1', 'day', '2019-07-15', '2019-07-15', '2019-07-15');
    INSERT INTO media (id, original_path, original_filename, mime_type, byte_length, sha256, created_at)
      VALUES ('m1', 'media/originals/m1.png', 'a.png', 'image/png', 10, '${"0".repeat(64)}', '${NOW}');
    INSERT INTO characters (id, created_at, created_by, updated_at, known_name)
      VALUES ('c1', '${NOW}', '1', '${NOW}', 'Sam');
    INSERT INTO artifacts (id, created_at, created_by, updated_at, media_id, description,
        source_provider, source_key, unidentified_people)
      VALUES ('a1', '${NOW}', '1', '${NOW}', 'm1', 'Meetup', 'web_upload', 'u1', 1);
    INSERT INTO artifact_people (artifact_id, character_id) VALUES ('a1', 'c1');
    INSERT INTO events (id, created_at, created_by, updated_at, title, description, date_kind,
        certainty, start_date_id, color)
      VALUES ('e1', '${NOW}', '1', '${NOW}', 'Launch', 'Server opened', 'single', 'exact', 'd1', '#3366cc');
    INSERT INTO event_people (event_id, character_id) VALUES ('e1', 'c1');
    INSERT INTO research_requests (id, created_at, created_by, updated_at, description, constraint_kind, anchor_event_id)
      VALUES ('r1', '${NOW}', '1', '${NOW}', 'Photos', 'before_event', 'e1');
    INSERT INTO request_people (request_id, character_id) VALUES ('r1', 'c1');
    INSERT INTO gap_cards (id, version, created_at, created_by, updated_at, kind, artifact_id, status, priority)
      VALUES ('g1', 2, '${NOW}', 'archivist', '${NOW}', 'missing_people', 'a1', 'needed', 'high'),
             ('g2', 1, '${NOW}', '1', '${NOW}', 'custom', 'a1', 'resolved', 'low');
  `);
  old.close();

  const db = openArchiveDatabase(file);
  t.after(() => db.close());
  assert.equal(db.pragma("user_version", { simple: true }), 3);
  assert.equal(
    (db.prepare("SELECT schema_version FROM archive_meta").get() as { schema_version: number })
      .schema_version,
    3,
  );
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.deepEqual(tableNames(db), ARCHIVE_TABLES);
  const count = (table: string) =>
    (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  assert.equal(count("artifact_characters"), 1);
  assert.equal(count("event_characters"), 1);
  assert.equal(count("request_characters"), 1);
  assert.deepEqual(db.prepare("SELECT unidentified_characters AS flag FROM artifacts").get(), {
    flag: 1,
  });
  assert.deepEqual(
    db.prepare("SELECT id, version, kind, status FROM gap_cards ORDER BY id").all(),
    [
      { id: "g1", version: 2, kind: "missing_characters", status: "needed" },
      { id: "g2", version: 1, kind: "custom", status: "resolved" },
    ],
  );
  assert.deepEqual(
    (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%reverse' ORDER BY name",
        )
        .all() as { name: string }[]
    )
      .map((row) => row.name)
      .filter((name) => /people|characters/.test(name)),
    ["artifact_characters_reverse", "event_characters_reverse", "request_characters_reverse"],
  );
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'gap_status_priority'").get());
  assert.deepEqual(db.pragma("foreign_key_check"), []);

  // The old kind is refused, and links still cascade or block as before.
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO gap_cards (id, created_at, created_by, updated_at, kind, event_id, priority)
           VALUES ('g3', '${NOW}', '1', '${NOW}', 'missing_people', 'e1', 'high')`,
        )
        .run(),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => db.prepare("DELETE FROM characters WHERE id = 'c1'").run(),
    /FOREIGN KEY constraint failed/,
  );
  db.prepare("DELETE FROM artifacts WHERE id = 'a1'").run();
  assert.equal(count("artifact_characters"), 0);
  assert.equal(count("gap_cards"), 0);
});

test("a failed migration leaves the database at its last complete version", (t) => {
  const db = new Database(join(makeTempDir(t), "test.db"));
  t.after(() => db.close());
  const store: VersionStore = {
    read: (target) => target.pragma("user_version", { simple: true }) as number,
    write: (target, version) => target.pragma(`user_version = ${version}`),
  };
  const migrations = [
    { version: 1, sql: "CREATE TABLE first (id TEXT);" },
    { version: 2, sql: "CREATE TABLE second (id TEXT); INSERT INTO missing VALUES (1);" },
  ];

  assert.throws(() => applyMigrations(db, migrations, store, "test database"));
  assert.equal(db.pragma("user_version", { simple: true }), 1);
  assert.deepEqual(tableNames(db), ["first"]);
});
