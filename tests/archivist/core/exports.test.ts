import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import Database from "better-sqlite3";
import { createArchive, registerArchive } from "../../../src/archivist/archives.js";
import { createArtifact, deleteArtifact, getArtifact } from "../../../src/archivist/artifacts.js";
import { closeArchivistContext, createArchivistContext } from "../../../src/archivist/context.js";
import { parseLog } from "../../../src/archivist/edit-log.js";
import { ArchivistError } from "../../../src/archivist/errors.js";
import {
  createExport,
  exportStatus,
  listExports,
  settleInterruptedExports,
  startExport,
} from "../../../src/archivist/exports.js";
import { createStagingFolder, stageMedia } from "../../../src/archivist/media.js";
import { addMember } from "../../../src/archivist/members.js";
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

  const job = await createExport(context, OWNER, { archiveId });
  assert.equal(job.state, "ready");
  const path = job.path!;
  assert.match(path, /\/archivist-exports\/Old-Days-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.zip$/);
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
  const { path } = await createExport(context, OWNER, { archiveId });

  const cleanDir = makeTempDir(t);
  const extracted = makeTempDir(t);
  unzip(path!, extracted);
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
  unzip(job.path!, extracted);
  const log = parseLog(readFileSync(join(extracted, archiveId, "edits.log"), "utf8"));
  assert.deepEqual(log.at(-1)?.changes, { laneGapDays: { old: 90, new: 30 } });
  assert.equal(existsSync(store.journalFile), false);
});

test("only the owner exports, and a zip stays on the host until it is deleted", async (t) => {
  const { context } = makeArchivist(t);
  const { archiveId } = createArchive(context, OWNER, { name: "Access" });
  addMember(context, OWNER, { archiveId, userId: MEMBER.userId });
  await assert.rejects(
    createExport(context, MEMBER, { archiveId }),
    (error) => error instanceof ArchivistError && error.code === "forbidden",
  );
  await assert.rejects(
    createExport(context, OTHER, { archiveId }),
    (error) => error instanceof ArchivistError && error.code === "archive_not_found",
  );
  assert.deepEqual(listExports(context, OWNER), []);

  const job = await createExport(context, OWNER, { archiveId });
  assert.throws(
    () => exportStatus(context, MEMBER, { jobId: job.id }),
    (error) => error instanceof ArchivistError && error.code === "forbidden",
  );
  const [listed] = listExports(context, OWNER);
  assert.equal(listed?.id, job.id);
  assert.equal(listed?.archiveName, "Access");
  assert.equal(listed?.onDisk, true);
  assert.ok((listed?.byteLength ?? 0) > 0);
  assert.deepEqual(readdirSync(context.paths.exportsDir), [basename(job.path!)]);

  // Nothing deletes it automatically, even long after.
  context.now = () => new Date(Date.UTC(2030, 0, 1));
  settleInterruptedExports(context);
  assert.equal(existsSync(job.path!), true);
  rmSync(job.path!);
  const removed = exportStatus(context, OWNER, { jobId: job.id });
  assert.equal(removed.state, "ready");
  assert.equal(removed.onDisk, false);
});

test("the snapshot is taken when the export starts", async (t) => {
  const { context } = makeArchivist(t);
  const { archiveId } = createArchive(context, OWNER, { name: "Moment" });
  addMember(context, OWNER, { archiveId, userId: MEMBER.userId });
  await addPhoto(context, archiveId, "Before the export");
  const file = join(createStagingFolder(context), "original");
  await writeImage(file, "png");
  const media = await stageMedia(context, { file, originalFilename: "later.png" });

  const { job, done } = startExport(context, OWNER, { archiveId });
  assert.equal(job.state, "running");
  createArtifact(context, MEMBER, {
    archiveId,
    description: "After the snapshot",
    media,
    source: { provider: "discord_attachment", key: "900000000000000001" },
  });
  const finished = await done;
  const extracted = makeTempDir(t);
  unzip(finished.path!, extracted);
  const db = new Database(join(extracted, archiveId, "archive.db"), { readonly: true });
  t.after(() => db.close());
  assert.deepEqual(db.prepare("SELECT description FROM artifacts").all(), [
    { description: "Before the export" },
  ]);
});

test("exports interrupted by a restart are marked failed, and finished zips are kept", async (t) => {
  const archivist = makeArchivist(t);
  const { archiveId } = createArchive(archivist.context, OWNER, { name: "Interrupted" });
  const kept = await createExport(archivist.context, OWNER, { archiveId });
  archivist.context.botDb
    .prepare(
      "INSERT INTO archivist_export_jobs (id, archive_id, requested_by, state, created_ms, relative_path) VALUES ('j1', ?, ?, 'running', 0, 'Interrupted-j1.zip')",
    )
    .run(archiveId, OWNER.userId);
  const partial = join(archivist.context.paths.exportsDir, "Interrupted-j1.zip.partial");
  writeFileSync(partial, "partial");
  const snapshot = join(archivist.context.paths.tmpDir, "exports", "j1");
  mkdirSync(snapshot, { recursive: true });

  const context = archivist.restart();
  assert.equal(settleInterruptedExports(context), 1);
  assert.equal(existsSync(partial), false);
  assert.equal(existsSync(snapshot), false);
  assert.equal(existsSync(kept.path!), true);
  assert.equal(exportStatus(context, OWNER, { jobId: "j1" }).state, "failed");
});
