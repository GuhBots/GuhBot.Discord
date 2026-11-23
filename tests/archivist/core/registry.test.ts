import assert from "node:assert/strict";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import {
  createArchive,
  getArchive,
  listArchives,
  registerArchive,
  renameArchive,
  unregisterArchive,
  updateArchiveSettings,
} from "../../../src/archivist/archives.js";
import { parseLog } from "../../../src/archivist/edit-log.js";
import { closeArchivistContext, createArchivistContext } from "../../../src/archivist/context.js";
import { ArchivistError, type ErrorCode } from "../../../src/archivist/errors.js";
import { addMember, listMembers, removeMember } from "../../../src/archivist/members.js";
import { commitMutation } from "../../../src/archivist/mutations.js";
import {
  getDateOrder,
  getTimeZone,
  inputTimeZone,
  resetPreferences,
  resetTimeZone,
  setDateOrder,
  resolveArchiveSelection,
  setTimeZone,
} from "../../../src/archivist/preferences.js";
import { makeArchivist, MEMBER, OTHER, OWNER } from "../helpers/context.js";
import { makeTempDir } from "../helpers/temp-dir.js";

function fails(code: ErrorCode) {
  return (error: unknown) => error instanceof ArchivistError && error.code === code;
}

function registryName(botDb: Database.Database, archiveId: string): unknown {
  return (
    botDb.prepare("SELECT name FROM archivist_archives WHERE archive_id = ?").get(archiveId) as
      { name: string } | undefined
  )?.name;
}

test("the owner creates an archive with its own folder, database, and log", (t) => {
  const { context } = makeArchivist(t);
  const archive = createArchive(context, OWNER, { name: "  Old Days  " });

  const folder = join(context.paths.archivesRoot, archive.archiveId);
  assert.deepEqual(readdirSync(folder).sort(), ["archive.db", "edits.log", "media"]);
  assert.deepEqual(readdirSync(join(folder, "media")).sort(), ["originals", "previews"]);
  assert.equal(archive.name, "Old Days");
  assert.equal(archive.timezone, "America/Toronto");
  assert.equal(archive.version, 1);
  assert.equal(registryName(context.botDb, archive.archiveId), "Old Days");
  const log = parseLog(readFileSync(join(folder, "edits.log"), "utf8"));
  assert.deepEqual(log[0]?.changes.name, { old: null, new: "Old Days" });
  assert.equal(log[0]?.editor, OWNER.userId);
});

test("only the owner creates archives, and names are unique ignoring case and form", (t) => {
  const { context } = makeArchivist(t);
  assert.throws(() => createArchive(context, MEMBER, { name: "Mine" }), fails("forbidden"));
  createArchive(context, OWNER, { name: "Straße" });
  assert.throws(() => createArchive(context, OWNER, { name: "STRASSE" }), fails("name_taken"));
  assert.throws(() => createArchive(context, OWNER, { name: "   " }), fails("invalid_input"));
  assert.equal(readdirSync(context.paths.archivesRoot).length, 1);
});

test("contributors see only the archives they are whitelisted for", (t) => {
  const { context } = makeArchivist(t);
  const first = createArchive(context, OWNER, { name: "First" });
  const second = createArchive(context, OWNER, { name: "Second" });
  addMember(context, OWNER, { archiveId: first.archiveId, userId: MEMBER.userId });

  assert.deepEqual(
    listArchives(context, OWNER).map((archive) => archive.name),
    ["First", "Second"],
  );
  assert.deepEqual(listArchives(context, MEMBER), [{ archiveId: first.archiveId, name: "First" }]);
  assert.deepEqual(listArchives(context, OTHER), []);

  assert.equal(getArchive(context, MEMBER, first.archiveId).name, "First");
  assert.throws(() => getArchive(context, MEMBER, second.archiveId), fails("archive_not_found"));
  assert.throws(() => getArchive(context, OTHER, first.archiveId), fails("archive_not_found"));
  assert.throws(() => getArchive(context, OWNER, "../escape"), fails("archive_not_found"));
});

test("members can see an archive but not run owner actions on it", (t) => {
  const { context } = makeArchivist(t);
  const archive = createArchive(context, OWNER, { name: "Shared" });
  addMember(context, OWNER, { archiveId: archive.archiveId, userId: MEMBER.userId });
  const input = { archiveId: archive.archiveId, name: "Taken Over", expectedVersion: 1 };

  assert.throws(() => renameArchive(context, MEMBER, input), fails("forbidden"));
  assert.throws(() => renameArchive(context, OTHER, input), fails("archive_not_found"));
  assert.throws(
    () => addMember(context, MEMBER, { archiveId: archive.archiveId, userId: OTHER.userId }),
    fails("forbidden"),
  );
  assert.throws(
    () => unregisterArchive(context, MEMBER, { archiveId: archive.archiveId }),
    fails("forbidden"),
  );
});

test("whitelist changes are idempotent and removal applies to the next request", (t) => {
  const { context } = makeArchivist(t);
  const archive = createArchive(context, OWNER, { name: "Shared" });
  const membership = { archiveId: archive.archiveId, userId: MEMBER.userId };

  assert.deepEqual(addMember(context, OWNER, membership), { added: true });
  assert.deepEqual(addMember(context, OWNER, membership), { added: false });
  assert.deepEqual(
    listMembers(context, OWNER, membership).map((member) => member.userId),
    [MEMBER.userId],
  );
  assert.equal(getArchive(context, MEMBER, archive.archiveId).name, "Shared");

  assert.deepEqual(removeMember(context, OWNER, membership), { removed: true });
  assert.deepEqual(removeMember(context, OWNER, membership), { removed: false });
  assert.throws(() => getArchive(context, MEMBER, archive.archiveId), fails("archive_not_found"));
  assert.throws(
    () => addMember(context, OWNER, { archiveId: archive.archiveId, userId: "not-an-id" }),
    fails("invalid_input"),
  );
});

test("renaming checks the version, updates both databases, and never moves the folder", (t) => {
  const { context } = makeArchivist(t);
  const archive = createArchive(context, OWNER, { name: "Before" });
  createArchive(context, OWNER, { name: "Other" });
  const folder = join(context.paths.archivesRoot, archive.archiveId);

  const renamed = renameArchive(context, OWNER, {
    archiveId: archive.archiveId,
    name: "After",
    expectedVersion: 1,
  });
  assert.equal(renamed.version, 2);
  assert.equal(registryName(context.botDb, archive.archiveId), "After");
  assert.ok(existsSync(join(folder, "archive.db")));

  assert.throws(
    () =>
      renameArchive(context, OWNER, {
        archiveId: archive.archiveId,
        name: "Again",
        expectedVersion: 1,
      }),
    (error: unknown) =>
      fails("stale_version")(error) &&
      (error as ArchivistError).details.currentVersion === 2 &&
      JSON.stringify((error as ArchivistError).details.current) === '{"name":"After"}',
  );
  assert.throws(
    () =>
      renameArchive(context, OWNER, {
        archiveId: archive.archiveId,
        name: "OTHER",
        expectedVersion: 2,
      }),
    fails("name_taken"),
  );
  const recased = renameArchive(context, OWNER, {
    archiveId: archive.archiveId,
    name: "AFTER",
    expectedVersion: 2,
  });
  assert.equal(recased.name, "AFTER");
});

test("a rename interrupted between the two databases is finished after a restart", (t) => {
  const archivist = makeArchivist(t);
  const archive = createArchive(archivist.context, OWNER, { name: "Before" });
  const store = archivist.context.stores.get(archive.archiveId)!;
  assert.throws(() =>
    commitMutation(
      store,
      {
        expectations: [{ table: "archive_meta", id: archive.archiveId, version: 2 }],
        apply: (db) => db.prepare("UPDATE archive_meta SET name = 'After', version = 2").run(),
        followUps: [{ kind: "archive_name", archiveId: archive.archiveId, name: "After" }],
      },
      {
        applyFollowUp() {
          throw new Error("Simulated crash before the bot database was updated");
        },
      },
    ),
  );
  assert.equal(registryName(archivist.context.botDb, archive.archiveId), "Before");

  const context = archivist.restart();
  assert.equal(getArchive(context, OWNER, archive.archiveId).name, "After");
  assert.equal(registryName(context.botDb, archive.archiveId), "After");
});

test("unregistering keeps the folder, and registering again grants no old access", (t) => {
  const { context } = makeArchivist(t);
  const archive = createArchive(context, OWNER, { name: "Kept" });
  addMember(context, OWNER, { archiveId: archive.archiveId, userId: MEMBER.userId });
  resolveArchiveSelection(context, MEMBER, archive.archiveId);

  unregisterArchive(context, OWNER, { archiveId: archive.archiveId });
  assert.ok(existsSync(join(context.paths.archivesRoot, archive.archiveId, "archive.db")));
  assert.deepEqual(listArchives(context, OWNER), []);
  assert.throws(() => resolveArchiveSelection(context, MEMBER, undefined), fails("invalid_input"));

  assert.throws(
    () => registerArchive(context, MEMBER, { archiveId: archive.archiveId }),
    fails("forbidden"),
  );
  const result = registerArchive(context, OWNER, { archiveId: archive.archiveId });
  assert.equal(result.archive.name, "Kept");
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(listArchives(context, MEMBER), []);
  assert.throws(
    () => registerArchive(context, OWNER, { archiveId: archive.archiveId }),
    fails("invalid_input"),
  );
});

test("registering under a taken name requires a new name, recorded as a rename", (t) => {
  const { context } = makeArchivist(t);
  const archive = createArchive(context, OWNER, { name: "Shared Name" });
  unregisterArchive(context, OWNER, { archiveId: archive.archiveId });
  createArchive(context, OWNER, { name: "shared name" });

  assert.throws(
    () => registerArchive(context, OWNER, { archiveId: archive.archiveId }),
    fails("name_taken"),
  );
  const result = registerArchive(context, OWNER, {
    archiveId: archive.archiveId,
    name: "Restored Copy",
  });
  assert.equal(result.archive.name, "Restored Copy");
  const log = parseLog(
    readFileSync(join(context.paths.archivesRoot, archive.archiveId, "edits.log"), "utf8"),
  );
  assert.deepEqual(log.at(-1)?.changes.name, { old: "Shared Name", new: "Restored Copy" });
});

test("registration refuses folders that are missing, mismatched, damaged, or newer", (t) => {
  const { context } = makeArchivist(t);
  const archive = createArchive(context, OWNER, { name: "Source" });
  unregisterArchive(context, OWNER, { archiveId: archive.archiveId });
  const source = join(context.paths.archivesRoot, archive.archiveId);

  assert.throws(
    () => registerArchive(context, OWNER, { archiveId: "11111111-1111-4111-8111-111111111111" }),
    fails("invalid_input"),
  );

  const mismatchedId = "22222222-2222-4222-8222-222222222222";
  cpSync(source, join(context.paths.archivesRoot, mismatchedId), { recursive: true });
  assert.throws(
    () => registerArchive(context, OWNER, { archiveId: mismatchedId }),
    fails("invalid_input"),
  );

  const db = new Database(join(source, "archive.db"));
  db.prepare(
    `INSERT INTO media (id, original_path, original_filename, mime_type, byte_length, sha256, created_at)
     VALUES ('m1', '../../outside.png', 'a.png', 'image/png', 1, ?, 'now')`,
  ).run("0".repeat(64));
  db.close();
  assert.throws(
    () => registerArchive(context, OWNER, { archiveId: archive.archiveId }),
    fails("invalid_input"),
  );

  const fixed = new Database(join(source, "archive.db"));
  fixed.prepare("UPDATE media SET original_path = 'media/originals/m1.png'").run();
  fixed.close();
  assert.throws(
    () => registerArchive(context, OWNER, { archiveId: archive.archiveId }),
    fails("invalid_input"),
  );

  const newer = new Database(join(source, "archive.db"));
  newer.pragma("user_version = 99");
  newer.close();
  assert.throws(
    () => registerArchive(context, OWNER, { archiveId: archive.archiveId }),
    fails("unsupported_schema"),
  );
  rmSync(join(context.paths.archivesRoot, mismatchedId), { recursive: true });
  assert.deepEqual(listArchives(context, OWNER), []);
});

test("a timezone change recomputes instant days and logs only the setting", (t) => {
  const { context } = makeArchivist(t);
  const archive = createArchive(context, OWNER, { name: "Zones" });
  const store = context.stores.get(archive.archiveId)!;
  store.db
    .prepare(
      `INSERT INTO date_values (id, kind, original_text, instant_ms, timezone, archive_day)
       VALUES ('late', 'instant', '2019-07-16 02:00Z', ?, 'UTC', '2019-07-15')`,
    )
    .run(Date.UTC(2019, 6, 16, 2));
  store.db
    .prepare(
      `INSERT INTO date_values (id, kind, original_text, calendar_day, archive_day)
       VALUES ('plain', 'day', '2019-07-15', '2019-07-15', '2019-07-15')`,
    )
    .run();

  const updated = updateArchiveSettings(context, OWNER, {
    archiveId: archive.archiveId,
    expectedVersion: 1,
    timezone: "asia/tokyo",
    laneGapDays: 30,
  });
  assert.equal(updated.timezone, "Asia/Tokyo");
  assert.equal(updated.laneGapDays, 30);
  const days = store.db.prepare("SELECT id, archive_day FROM date_values ORDER BY id").all();
  assert.deepEqual(days, [
    { id: "late", archive_day: "2019-07-16" },
    { id: "plain", archive_day: "2019-07-15" },
  ]);
  const log = parseLog(readFileSync(join(store.folder, "edits.log"), "utf8"));
  assert.equal(log.length, 2);
  assert.deepEqual(log[1]?.changes, {
    timezone: { old: "America/Toronto", new: "Asia/Tokyo" },
    laneGapDays: { old: 90, new: 30 },
  });

  const settings = { archiveId: archive.archiveId, expectedVersion: 2 };
  assert.throws(
    () => updateArchiveSettings(context, OWNER, { ...settings, timezone: "Mars/Base" }),
    fails("invalid_input"),
  );
  assert.throws(
    () => updateArchiveSettings(context, OWNER, { ...settings, mainServerId: "missing" }),
    fails("invalid_input"),
  );
  assert.throws(
    () => updateArchiveSettings(context, OWNER, { ...settings, laneGapDays: 0 }),
    fails("invalid_input"),
  );
  assert.throws(
    () =>
      updateArchiveSettings(context, OWNER, { ...settings, expectedVersion: 1, laneGapDays: 10 }),
    fails("stale_version"),
  );
});

test("personal timezones are validated and fall back to the archive's", (t) => {
  const { context } = makeArchivist(t);
  assert.equal(inputTimeZone(context, MEMBER, "America/Toronto"), "America/Toronto");
  assert.equal(setTimeZone(context, MEMBER, "europe/london"), "Europe/London");
  assert.equal(getTimeZone(context, MEMBER), "Europe/London");
  assert.equal(inputTimeZone(context, MEMBER, "America/Toronto"), "Europe/London");
  assert.throws(() => setTimeZone(context, MEMBER, "+05:00"), fails("invalid_input"));
  resetTimeZone(context, MEMBER);
  assert.equal(getTimeZone(context, MEMBER), null);
});

test("each contributor's date order is kept, and a reset clears it with the timezone", (t) => {
  const { context } = makeArchivist(t);
  assert.equal(getDateOrder(context, MEMBER), "ymd");
  assert.equal(setDateOrder(context, MEMBER, "dmy"), "dmy");
  assert.equal(getDateOrder(context, MEMBER), "dmy");
  assert.equal(getDateOrder(context, OWNER), "ymd");
  assert.throws(() => setDateOrder(context, MEMBER, "ydm"), fails("invalid_input"));
  setTimeZone(context, MEMBER, "Europe/London");
  resetPreferences(context, MEMBER);
  assert.equal(getDateOrder(context, MEMBER), "ymd");
  assert.equal(getTimeZone(context, MEMBER), null);
});

test("an omitted archive uses the last explicit choice while access lasts", (t) => {
  const { context } = makeArchivist(t);
  const first = createArchive(context, OWNER, { name: "First" });
  const second = createArchive(context, OWNER, { name: "Second" });
  addMember(context, OWNER, { archiveId: first.archiveId, userId: MEMBER.userId });
  addMember(context, OWNER, { archiveId: second.archiveId, userId: MEMBER.userId });

  assert.throws(() => resolveArchiveSelection(context, MEMBER, undefined), fails("invalid_input"));
  assert.equal(resolveArchiveSelection(context, MEMBER, second.archiveId).name, "Second");
  assert.equal(resolveArchiveSelection(context, MEMBER, undefined).name, "Second");
  assert.equal(resolveArchiveSelection(context, MEMBER, first.archiveId).name, "First");
  assert.equal(resolveArchiveSelection(context, MEMBER, "").name, "First");

  removeMember(context, OWNER, { archiveId: first.archiveId, userId: MEMBER.userId });
  assert.throws(() => resolveArchiveSelection(context, MEMBER, undefined), fails("invalid_input"));
  assert.throws(
    () => resolveArchiveSelection(context, MEMBER, first.archiveId),
    fails("archive_not_found"),
  );
  assert.equal(resolveArchiveSelection(context, MEMBER, second.archiveId).name, "Second");
});

test("archives, members, and preferences survive a restart", (t) => {
  const archivist = makeArchivist(t);
  const archive = createArchive(archivist.context, OWNER, { name: "Durable" });
  addMember(archivist.context, OWNER, { archiveId: archive.archiveId, userId: MEMBER.userId });
  setTimeZone(archivist.context, MEMBER, "Europe/Paris");
  resolveArchiveSelection(archivist.context, MEMBER, archive.archiveId);

  const context = archivist.restart();
  assert.deepEqual(listArchives(context, MEMBER), [
    { archiveId: archive.archiveId, name: "Durable" },
  ]);
  assert.equal(getArchive(context, MEMBER, archive.archiveId).name, "Durable");
  assert.equal(getTimeZone(context, MEMBER), "Europe/Paris");
  assert.equal(resolveArchiveSelection(context, MEMBER, undefined).archiveId, archive.archiveId);
});

test("Archivist work and restarts leave the bot's AFK data untouched", (t) => {
  const dataDir = makeTempDir(t);
  const seed = new Database(join(dataDir, "guhbot.db"));
  seed.pragma("journal_mode = WAL");
  seed.exec(
    "CREATE TABLE afk (user_id TEXT PRIMARY KEY, reason TEXT NOT NULL, mentions INTEGER NOT NULL DEFAULT 0)",
  );
  seed.prepare("INSERT INTO afk VALUES ('111111111111111111', 'Lunch', 2)").run();
  const afkBefore = seed.prepare("SELECT * FROM afk").all();
  seed.close();

  for (let run = 0; run < 2; run++) {
    const botDb = new Database(join(dataDir, "guhbot.db"));
    const context = createArchivistContext({ dataDir, botDb });
    const archive = createArchive(context, OWNER, { name: `Run ${run}` });
    addMember(context, OWNER, { archiveId: archive.archiveId, userId: MEMBER.userId });
    renameArchive(context, OWNER, {
      archiveId: archive.archiveId,
      name: `Renamed ${run}`,
      expectedVersion: 1,
    });
    unregisterArchive(context, OWNER, { archiveId: archive.archiveId });
    closeArchivistContext(context);
    assert.deepEqual(botDb.prepare("SELECT * FROM afk").all(), afkBefore);
    botDb.close();
  }
});
