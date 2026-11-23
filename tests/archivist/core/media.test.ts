import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { createArchive } from "../../../src/archivist/archives.js";
import type { ArchivistContext } from "../../../src/archivist/context.js";
import { ArchivistError, type ErrorCode } from "../../../src/archivist/errors.js";
import {
  createStagingFolder,
  detectFormat,
  MAX_MEDIA_BYTES,
  mediaPaths,
  placeStagedMedia,
  type StagedMedia,
  stageMedia,
} from "../../../src/archivist/media.js";
import { closeMetadataReader } from "../../../src/archivist/metadata.js";
import {
  commitMutation,
  planJournal,
  recoverPendingMutation,
  writeJournal,
} from "../../../src/archivist/mutations.js";
import { makeArchivist, OWNER } from "../helpers/context.js";
import { closeFixtureWriter, writeImage, writeMp4 } from "../helpers/media.js";

after(async () => {
  await closeMetadataReader();
  await closeFixtureWriter();
});

function fails(code: ErrorCode) {
  return (error: unknown) => error instanceof ArchivistError && error.code === code;
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Writes a fixture into a fresh staging folder and returns its path. */
async function staged(
  context: ArchivistContext,
  write: (file: string) => Promise<void> | void,
): Promise<string> {
  const file = join(createStagingFolder(context), "original");
  await write(file);
  return file;
}

test("formats are recognized from their bytes, not their names", () => {
  assert.equal(detectFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
  assert.equal(detectFormat(Buffer.from("GIF89a")), "gif");
  assert.equal(detectFormat(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "webp");
  assert.equal(detectFormat(Buffer.from("\0\0\0\x18ftypmp42")), "mp4");
  assert.equal(detectFormat(Buffer.from("\0\0\0\x18ftypqt  ")), null);
  assert.equal(detectFormat(Buffer.from("\0\0\0\x18ftypheic")), null);
  assert.equal(detectFormat(Buffer.from("<html>")), null);
});

test("a JPEG keeps its bytes, gets a preview, and dates from its original-capture tags", async (t: TestContext) => {
  const { context } = makeArchivist(t);
  const file = await staged(context, (target) =>
    writeImage(target, "jpeg", {
      "ExifIFD:DateTimeOriginal": "2019:07:15 13:45:10",
      "ExifIFD:SubSecTimeOriginal": "25",
      "ExifIFD:OffsetTimeOriginal": "-04:00",
      "ExifIFD:CreateDate": "2019:07:15 13:45:10",
    }),
  );
  utimesSync(file, new Date("2001-01-01"), new Date("2001-01-01"));
  const before = sha256(file);

  const media = await stageMedia(context, { file, originalFilename: "C:\\Users\\me\\photo.png" });
  assert.equal(media.format, "jpeg");
  assert.equal(media.mimeType, "image/jpeg");
  assert.equal(media.originalFilename, "photo.png");
  assert.equal(media.sha256, before);
  assert.equal(sha256(file), before);
  assert.equal(media.readable, true);
  assert.ok(media.previewFile && existsSync(media.previewFile));
  assert.equal(media.fileDate.status, "found");
  assert.equal(media.fileDate.tier, "capture");
  assert.equal(media.fileDate.sourceTag, "ExifIFD:DateTimeOriginal");
  assert.deepEqual(media.fileDate.value, {
    kind: "instant",
    originalText: "2019:07:15 13:45:10.25 -04:00",
    instantMs: Date.UTC(2019, 6, 15, 17, 45, 10, 250),
    timezone: "-04:00",
  });
  assert.equal(media.tags["ExifIFD:DateTimeOriginal"], "2019:07:15 13:45:10");
  assert.equal(
    Object.keys(media.tags).some((tag) => tag.startsWith("System:")),
    false,
  );
});

test("an offset is never borrowed from another field", async (t) => {
  const { context } = makeArchivist(t);
  const file = await staged(context, (target) =>
    writeImage(target, "jpeg", {
      "ExifIFD:DateTimeOriginal": "2019:07:15 13:45:00",
      "ExifIFD:OffsetTimeDigitized": "-04:00",
    }),
  );
  const media = await stageMedia(context, { file, originalFilename: "a.jpg" });
  assert.deepEqual(media.fileDate.value, {
    kind: "unknown_local",
    originalText: "2019:07:15 13:45:00",
    calendarDay: "2019-07-15",
    localDateTime: "2019-07-15T13:45:00",
  });
});

test("disagreeing capture tags leave the date for a person to review", async (t) => {
  const { context } = makeArchivist(t);
  const file = await staged(context, (target) =>
    writeImage(target, "jpeg", {
      "ExifIFD:DateTimeOriginal": "2019:07:15 13:45:00",
      "XMP-exif:DateTimeOriginal": "2018:01:02 03:04:05",
      "ExifIFD:CreateDate": "2019:07:15 13:45:00",
    }),
  );
  const media = await stageMedia(context, { file, originalFilename: "a.jpg" });
  assert.equal(media.fileDate.status, "conflict");
  assert.equal(media.fileDate.value, null);
  assert.equal(media.fileDate.candidates.length, 2);
});

test("creation tags are used only when no capture tag holds a date", async (t) => {
  const { context } = makeArchivist(t);
  const file = await staged(context, (target) =>
    writeImage(target, "webp", { "ExifIFD:CreateDate": "2020:02:29 23:59:59" }),
  );
  const media = await stageMedia(context, { file, originalFilename: "a.webp" });
  assert.equal(media.format, "webp");
  assert.equal(media.fileDate.tier, "creation");
  assert.equal(media.fileDate.sourceTag, "ExifIFD:CreateDate");
  assert.equal(media.fileDate.value?.kind, "unknown_local");
});

test("PNG modification times and filesystem dates never become the file date", async (t) => {
  const { context } = makeArchivist(t);
  const modified = await staged(context, (target) =>
    writeImage(target, "png", { "PNG:ModifyDate": "2015:05:05 05:05:05" }),
  );
  utimesSync(modified, new Date("2003-03-03"), new Date("2003-03-03"));
  const plain = await stageMedia(context, { file: modified, originalFilename: "a.png" });
  assert.equal(plain.fileDate.status, "absent");

  const dated = await staged(context, (target) =>
    writeImage(target, "png", { "ExifIFD:DateTimeOriginal": "2016:06:06 06:06:06" }),
  );
  const withExif = await stageMedia(context, { file: dated, originalFilename: "b.png" });
  assert.equal(withExif.fileDate.status, "found");
  assert.equal(withExif.fileDate.value?.kind, "unknown_local");
});

test("a GIF without embedded dates stays undated, and XMP dates are read when present", async (t) => {
  const { context } = makeArchivist(t);
  const bare = await staged(context, (target) => writeImage(target, "gif"));
  const undated = await stageMedia(context, { file: bare, originalFilename: "a.gif" });
  assert.equal(undated.format, "gif");
  assert.equal(undated.fileDate.status, "absent");
  assert.ok(undated.previewFile);

  const tagged = await staged(context, (target) =>
    writeImage(target, "gif", { "XMP-xmp:CreateDate": "2012:12:12 12:12:12+01:00" }),
  );
  const dated = await stageMedia(context, { file: tagged, originalFilename: "b.gif" });
  assert.equal(dated.fileDate.tier, "creation");
  assert.equal(dated.fileDate.value?.kind, "instant");
});

test("an MP4's container date stays local, and an offset creation date wins", async (t) => {
  const { context } = makeArchivist(t);
  const created = Date.UTC(2019, 6, 15, 17, 45);
  const plain = await staged(context, (target) => writeMp4(target, created));
  const containerOnly = await stageMedia(context, { file: plain, originalFilename: "a.mp4" });
  assert.equal(containerOnly.format, "mp4");
  assert.equal(containerOnly.readable, true);
  assert.equal(containerOnly.previewFile, null);
  assert.equal(containerOnly.fileDate.tier, "creation");
  assert.deepEqual(containerOnly.fileDate.value, {
    kind: "unknown_local",
    originalText: "2019:07:15 17:45:00",
    calendarDay: "2019-07-15",
    localDateTime: "2019-07-15T17:45:00",
  });

  const keyed = await staged(context, (target) =>
    writeMp4(target, created, { "Keys:CreationDate": "2019:07:15 13:45:00-04:00" }),
  );
  const capture = await stageMedia(context, { file: keyed, originalFilename: "b.mp4" });
  assert.equal(capture.fileDate.tier, "capture");
  assert.equal(capture.fileDate.sourceTag, "Keys:CreationDate");
  assert.equal(
    capture.fileDate.value?.kind === "instant" && capture.fileDate.value.instantMs,
    created,
  );
});

test("empty, oversized, and unsupported files are refused", async (t) => {
  const { context } = makeArchivist(t);
  const empty = await staged(context, (target) => writeFileSync(target, ""));
  await assert.rejects(
    stageMedia(context, { file: empty, originalFilename: "a.jpg" }),
    fails("invalid_input"),
  );

  const big = await staged(context, (target) => {
    writeFileSync(target, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    truncateSync(target, MAX_MEDIA_BYTES + 1);
  });
  await assert.rejects(
    stageMedia(context, { file: big, originalFilename: "a.jpg" }),
    fails("media_too_large"),
  );

  const text = await staged(context, (target) => writeFileSync(target, "not an image"));
  await assert.rejects(
    stageMedia(context, { file: text, originalFilename: "a.jpg" }),
    fails("unsupported_media_type"),
  );
  const movie = await staged(context, (target) => writeMp4(target, 0, {}, "qt  "));
  await assert.rejects(
    stageMedia(context, { file: movie, originalFilename: "a.mp4" }),
    fails("unsupported_media_type"),
  );
});

test("a damaged image is kept but marked unreadable, without a preview", async (t) => {
  const { context } = makeArchivist(t);
  const file = await staged(context, async (target) => {
    await writeImage(target, "jpeg");
    const bytes = readFileSync(target);
    writeFileSync(target, bytes.subarray(0, 40));
  });
  const media = await stageMedia(context, { file, originalFilename: "broken.jpg" });
  assert.equal(media.format, "jpeg");
  assert.equal(media.readable, false);
  assert.equal(media.previewFile, null);
});

async function stagedPhoto(context: ArchivistContext): Promise<StagedMedia> {
  const file = await staged(context, (target) => writeImage(target, "jpeg"));
  return stageMedia(context, { file, originalFilename: "a.jpg" });
}

function insertMedia(media: StagedMedia, mediaId: string, paths: ReturnType<typeof mediaPaths>) {
  return (db: import("better-sqlite3").Database) =>
    db
      .prepare(
        `INSERT INTO media (id, original_path, preview_path, original_filename, mime_type, byte_length, sha256, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 'now')`,
      )
      .run(
        mediaId,
        paths.original,
        paths.preview,
        media.originalFilename,
        media.mimeType,
        media.byteLength,
        media.sha256,
      );
}

test("placing media keeps the original byte-for-byte and its preview", async (t) => {
  const { context } = makeArchivist(t);
  const archive = createArchive(context, OWNER, { name: "Media" });
  const store = context.stores.get(archive.archiveId)!;
  const media = await stagedPhoto(context);
  const source = join(context.paths.tmpDir, "copy.jpg");
  copyFileSync(media.originalFile, source);
  const paths = mediaPaths("m1", media.extension, media.previewFile !== null);

  commitMutation(store, {
    expectations: [{ table: "archive_meta", id: archive.archiveId, version: 1 }],
    newFiles: [paths.original, paths.preview!],
    placeFiles: () => placeStagedMedia(store.folder, media, paths),
    apply: insertMedia(media, "m1", paths),
  });
  assert.deepEqual(readFileSync(join(store.folder, paths.original)), readFileSync(source));
  assert.ok(existsSync(join(store.folder, paths.preview!)));
});

test("a failed or interrupted intake leaves no files in the archive", async (t) => {
  const { context } = makeArchivist(t);
  const archive = createArchive(context, OWNER, { name: "Media" });
  const store = context.stores.get(archive.archiveId)!;

  const rejected = await stagedPhoto(context);
  const rejectedPaths = mediaPaths("m1", rejected.extension, true);
  assert.throws(() =>
    commitMutation(store, {
      expectations: [{ table: "archive_meta", id: archive.archiveId, version: 1 }],
      newFiles: [rejectedPaths.original, rejectedPaths.preview!],
      placeFiles: () => placeStagedMedia(store.folder, rejected, rejectedPaths),
      apply() {
        throw new ArchivistError("invalid_input", "Rejected after the files were placed.");
      },
    }),
  );
  assert.equal(existsSync(join(store.folder, rejectedPaths.original)), false);
  assert.equal(existsSync(join(store.folder, rejectedPaths.preview!)), false);

  const interrupted = await stagedPhoto(context);
  const paths = mediaPaths("m2", interrupted.extension, true);
  const input = {
    expectations: [{ table: "artifacts" as const, id: "never-created", state: "present" as const }],
    newFiles: [paths.original, paths.preview!],
    apply() {},
  };
  writeJournal(store, planJournal(store, input));
  placeStagedMedia(store.folder, interrupted, paths);
  assert.equal(recoverPendingMutation(store), "discarded");
  assert.equal(existsSync(join(store.folder, paths.original)), false);
  assert.equal(existsSync(join(store.folder, paths.preview!)), false);
});
