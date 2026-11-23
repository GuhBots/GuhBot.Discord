import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import Database from "better-sqlite3";
import { createArchive, registerArchive } from "../../../src/archivist/archives.js";
import { createArtifact, deleteArtifact, getArtifact } from "../../../src/archivist/artifacts.js";
import { closeArchivistContext, createArchivistContext } from "../../../src/archivist/context.js";
import { parseLog } from "../../../src/archivist/edit-log.js";
import { ArchivistError } from "../../../src/archivist/errors.js";
import {
  createExport,
  expireExports,
  exportFile,
  exportStatus,
  settleInterruptedExports,
} from "../../../src/archivist/exports.js";
import { createStagingFolder, stageMedia } from "../../../src/archivist/media.js";
import { addMember, removeMember } from "../../../src/archivist/members.js";
import { closeMetadataReader } from "../../../src/archivist/metadata.js";
import { planJournal, writeJournal } from "../../../src/archivist/mutations.js";
import { makeArchivist, MEMBER, OTHER, OWNER } from "../helpers/context.js";
import { closeFixtureWriter, writeImage } from "../helpers/media.js";
import { makeTempDir } from "../helpers/temp-dir.js";

after(async () => {
  await closeMetadataReader();
  await closeFixtureWriter();
});

/** Unpacks a zip with Python's standard library, which the repository checks already need. */
function unzip(zip: string, into: string): void {
  const result = spawnSync("python3", ["-I", "-m", "zipfile", "-e", zip, into], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

function listZip(zip: string): string[] {
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      'import sys, zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))',
      zip,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n").filter(Boolean).sort();
}

let sourceCounter = 0;

async function addPhoto(
  context: Parameters<typeof createArtifact>[0],
  archiveId: string,
  description: string,
) {
  const file = join(createStagingFolder(context), "original");
  await writeImage(file, "jpeg", { "ExifIFD:DateTimeOriginal": "2019:07:15 13:45:00" });
  const media = await stageMedia(context, { file, originalFilename: "photo.jpg" });
  sourceCounter += 1;
  const result = createArtifact(context, MEMBER, {
    archiveId,
    description,
    media,
    source: { provider: "discord_attachment", key: `8${String(sourceCounter).padStart(17, "0")}` },
  });
  return result.artifact;
}

test("an export holds the whole archive folder and nothing else", async (t) => {
  const { context } = makeArchivist(t);
  const { archiveId } = createArchive(context, OWNER, { name: "Old Days" });
  createArchive(context, OWNER, { name: "Another Archive" });
  addMember(context, OWNER, { archiveId, userId: MEMBER.userId });
  const kept = await addPhoto(context, archiveId, "Kept");
  const removed = await addPhoto(context, archiveId, "Removed later");
  deleteArtifact(context, MEMBER, { archiveId, id: removed.id, expectedVersion: 1 });
  const folder = join(context.paths.archivesRoot, archiveId);
  writeFileSync(join(folder, "notes.txt"), "kept with the archive");
  writeFileSync(join(folder, "edits.log.rewrite"), "transient");

  const job = await createExport(context, MEMBER, { archiveId });
  assert.equal(job.state, "ready");
  assert.match(job.fileName!, /^Old-Days-\d{4}-\d{2}-\d{2}\.zip$/);
  const { path } = exportFile(context, MEMBER, { archiveId, jobId: job.id });
  assert.ok(path.startsWith(context.paths.exportsDir));

  const entries = listZip(path);
  assert.deepEqual(
    entries,
    [
      `${archiveId}/archive.db`,
      `${archiveId}/edits.log`,
      `${archiveId}/media/originals/${kept.media.id}.jpg`,
      `${archiveId}/media/originals/${removed.media.id}.jpg`,
      `${archiveId}/media/previews/${kept.media.id}.webp`,
      `${archiveId}/media/previews/${removed.media.id}.webp`,
      `${archiveId}/notes.txt`,
    ].sort(),
  );
});

test("an exported archive restores into a clean installation without old access", async (t) => {
  const { context } = makeArchivist(t);
  const { archiveId } = createArchive(context, OWNER, { name: "Portable" });
  addMember(context, OWNER, { archiveId, userId: MEMBER.userId });
  const artifact = await addPhoto(context, archiveId, "Travels with its archive");
  const job = await createExport(context, MEMBER, { archiveId });
  const { path } = exportFile(context, MEMBER, { archiveId, jobId: job.id });

  const cleanDir = makeTempDir(t);
  const extracted = makeTempDir(t);
  unzip(path, extracted);
  mkdirSync(join(cleanDir, "archives"), { recursive: true });
  cpSync(join(extracted, archiveId), join(cleanDir, "archives", archiveId), { recursive: true });
  const botDb = new Database(join(cleanDir, "guhbot.db"));
  const clean = createArchivistContext({ dataDir: cleanDir, botDb });
  t.after(() => {
    closeArchivistContext(clean);
    botDb.close();
  });

  const restored = registerArchive(clean, OWNER, { archiveId });
  assert.equal(restored.archive.name, "Portable");
  assert.deepEqual(restored.warnings, []);
  const copy = getArtifact(clean, OWNER, { archiveId, id: artifact.id });
  assert.equal(copy.description, "Travels with its archive");
  assert.equal(copy.dates.selected?.date.archiveDay, "2019-07-15");
  const originalBytes = readFileSync(
    join(context.paths.archivesRoot, archiveId, "media/originals", `${artifact.media.id}.jpg`),
  );
  assert.deepEqual(
    readFileSync(
      join(cleanDir, "archives", archiveId, "media/originals", `${artifact.media.id}.jpg`),
    ),
    originalBytes,
  );
  assert.throws(
    () => getArtifact(clean, MEMBER, { archiveId, id: artifact.id }),
    (error) => error instanceof ArchivistError && error.code === "archive_not_found",
  );
});

test("an unfinished change is completed before the snapshot is taken", async (t) => {
  const { context } = makeArchivist(t);
  const { archiveId } = createArchive(context, OWNER, { name: "Pending" });
  const store = context.stores.get(archiveId)!;
  const input = {
    expectations: [{ table: "archive_meta" as const, id: archiveId, version: 2 }],
    apply: () => store.db.prepare("UPDATE archive_meta SET lane_gap_days = 30, version = 2").run(),
    append: [
      {
        at: "2026-11-23T00:00:00.000Z",
        editor: OWNER.userId,
        record: "archive",
        id: archiveId,
        changes: { laneGapDays: { old: 90, new: 30 } },
      },
    ],
  };
  writeJournal(store, planJournal(store, input));
  store.db.transaction(input.apply)();

  const job = await createExport(context, OWNER, { archiveId });
  const extracted = makeTempDir(t);
  unzip(exportFile(context, OWNER, { archiveId, jobId: job.id }).path, extracted);
  const log = parseLog(readFileSync(join(extracted, archiveId, "edits.log"), "utf8"));
  assert.deepEqual(log.at(-1)?.changes, { laneGapDays: { old: 90, new: 30 } });
  assert.equal(existsSync(store.journalFile), false);
});

test("downloads recheck access, and exports expire after a day", async (t) => {
  const { context } = makeArchivist(t);
  const { archiveId } = createArchive(context, OWNER, { name: "Access" });
  addMember(context, OWNER, { archiveId, userId: MEMBER.userId });
  const job = await createExport(context, MEMBER, { archiveId });
  await assert.rejects(
    createExport(context, OTHER, { archiveId }),
    (error) => error instanceof ArchivistError && error.code === "archive_not_found",
  );
  assert.equal(exportStatus(context, MEMBER, { archiveId, jobId: job.id }).state, "ready");

  removeMember(context, OWNER, { archiveId, userId: MEMBER.userId });
  assert.throws(
    () => exportFile(context, MEMBER, { archiveId, jobId: job.id }),
    (error) => error instanceof ArchivistError && error.code === "archive_not_found",
  );
  const { path } = exportFile(context, OWNER, { archiveId, jobId: job.id });

  context.botDb.prepare("UPDATE archivist_export_jobs SET expires_ms = 0").run();
  assert.equal(expireExports(context), 1);
  assert.equal(existsSync(path), false);
  assert.equal(exportStatus(context, OWNER, { archiveId, jobId: job.id }).state, "expired");
  assert.throws(
    () => exportFile(context, OWNER, { archiveId, jobId: job.id }),
    (error) => error instanceof ArchivistError && error.code === "not_found",
  );
});

test("exports interrupted by a restart are marked failed and cleaned up", (t) => {
  const archivist = makeArchivist(t);
  const { archiveId } = createArchive(archivist.context, OWNER, { name: "Interrupted" });
  archivist.context.botDb
    .prepare(
      "INSERT INTO archivist_export_jobs (id, archive_id, requested_by, state, created_ms, relative_path) VALUES ('j1', ?, ?, 'running', 0, 'j1/partial.zip')",
    )
    .run(archiveId, OWNER.userId);
  mkdirSync(join(archivist.context.paths.exportsDir, "j1"), { recursive: true });
  writeFileSync(join(archivist.context.paths.exportsDir, "j1", "partial.zip"), "partial");

  const context = archivist.restart();
  assert.equal(settleInterruptedExports(context), 1);
  assert.equal(existsSync(join(context.paths.exportsDir, "j1")), false);
  assert.equal(exportStatus(context, OWNER, { archiveId, jobId: "j1" }).state, "failed");
});
