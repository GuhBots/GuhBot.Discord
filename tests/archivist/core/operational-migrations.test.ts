import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { ArchivistError } from "../../../src/archivist/errors.js";
import { nameKey } from "../../../src/archivist/fields.js";
import { prepareOperationalDatabase } from "../../../src/archivist/operational-database.js";
import { makeTempDir } from "../helpers/temp-dir.js";

/** The AFK table exactly as `src/lib/database.ts` creates it. */
const AFK_TABLE = `
  CREATE TABLE IF NOT EXISTS afk (
    user_id  TEXT PRIMARY KEY,
    reason   TEXT NOT NULL,
    mentions INTEGER NOT NULL DEFAULT 0
  );
`;

const AFK_ROWS = [
  { user_id: "111111111111111111", reason: "Sleeping", mentions: 3 },
  { user_id: "222222222222222222", reason: "Away 🌙", mentions: 0 },
];

/** A bot database as it exists before Archivist, with AFK data in WAL mode. */
function existingBotDatabase(t: TestContext): Database.Database {
  const db = new Database(join(makeTempDir(t), "guhbot.db"));
  t.after(() => db.close());
  db.pragma("journal_mode = WAL");
  db.exec(AFK_TABLE);
  const insert = db.prepare("INSERT INTO afk (user_id, reason, mentions) VALUES (?, ?, ?)");
  for (const row of AFK_ROWS) insert.run(row.user_id, row.reason, row.mentions);
  return db;
}

function afkState(db: Database.Database): unknown {
  return {
    schema: db.prepare("SELECT sql FROM sqlite_master WHERE name = 'afk'").get(),
    rows: db.prepare("SELECT * FROM afk ORDER BY user_id").all(),
  };
}

test("Archivist tables are added without changing AFK data", (t) => {
  const db = existingBotDatabase(t);
  const before = afkState(db);

  assert.deepEqual(prepareOperationalDatabase(db), { from: 0, to: 2 });

  assert.deepEqual(afkState(db), before);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'archivist_%'")
    .all();
  assert.equal(tables.length, 11);
  assert.deepEqual(db.prepare("SELECT version FROM archivist_schema").get(), { version: 2 });
  assert.equal(db.pragma("user_version", { simple: true }), 0);
});

test("preparing an up-to-date bot database changes nothing", (t) => {
  const db = existingBotDatabase(t);
  prepareOperationalDatabase(db);
  const before = afkState(db);

  assert.deepEqual(prepareOperationalDatabase(db), { from: 2, to: 2 });
  assert.deepEqual(afkState(db), before);
});

test("a newer Archivist schema is refused and AFK data is left alone", (t) => {
  const db = existingBotDatabase(t);
  prepareOperationalDatabase(db);
  db.prepare("UPDATE archivist_schema SET version = 99").run();
  const before = afkState(db);

  assert.throws(
    () => prepareOperationalDatabase(db),
    (error) => error instanceof ArchivistError && error.code === "unsupported_schema",
  );
  assert.deepEqual(afkState(db), before);
});

test("archive names are unique regardless of case and Unicode form", (t) => {
  const db = existingBotDatabase(t);
  prepareOperationalDatabase(db);
  const register = db.prepare(
    `INSERT INTO archivist_archives (archive_id, name, name_key, relative_path, registered_at, registered_by)
     VALUES (?, ?, ?, ?, '2026-11-23T00:00:00.000Z', '1')`,
  );
  register.run("a1", "Straße", nameKey("Straße"), "archives/a1");

  assert.throws(
    () => register.run("a2", "STRASSE", nameKey("STRASSE"), "archives/a2"),
    /UNIQUE constraint failed: archivist_archives.name_key/,
  );
  register.run("a3", "Ärchiv", nameKey("Ärchiv"), "archives/a3");
  assert.throws(
    () => register.run("a4", "ärchiv", nameKey("ärchiv"), "archives/a4"),
    /UNIQUE constraint failed/,
  );
});

test("unregistering an archive removes its access and remembered selections", (t) => {
  const db = existingBotDatabase(t);
  prepareOperationalDatabase(db);
  const now = "2026-11-23T00:00:00.000Z";
  db.prepare(
    `INSERT INTO archivist_archives (archive_id, name, name_key, relative_path, registered_at, registered_by)
     VALUES ('a1', 'One', 'one', 'archives/a1', ?, '1')`,
  ).run(now);
  db.prepare(
    `INSERT INTO archivist_whitelist (archive_id, discord_user_id, granted_at, granted_by)
     VALUES ('a1', '333333333333333333', ?, '1')`,
  ).run(now);
  db.prepare(
    `INSERT INTO archivist_last_archives (discord_user_id, archive_id, updated_at)
     VALUES ('333333333333333333', 'a1', ?)`,
  ).run(now);

  db.prepare("DELETE FROM archivist_archives WHERE archive_id = 'a1'").run();

  const count = (table: string) =>
    (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  assert.equal(count("archivist_whitelist"), 0);
  assert.equal(count("archivist_last_archives"), 0);
});
