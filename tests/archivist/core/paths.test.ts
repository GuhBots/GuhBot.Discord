import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ArchivistError } from "../../../src/archivist/errors.js";
import {
  archiveFolder,
  archiveIdValue,
  archiveRelativePath,
  archivistPaths,
  insideArchive,
} from "../../../src/archivist/paths.js";

const ARCHIVE_ID = "0b6f7c1e-3f1d-4c55-9c1a-2a7e5d9b8c10";

const isInvalid = (error: unknown) =>
  error instanceof ArchivistError && error.code === "invalid_input";

test("archives, staging, and exports live in separate folders under the data directory", () => {
  const paths = archivistPaths("data");
  assert.equal(paths.archivesRoot, resolve("data", "archives"));
  assert.equal(paths.tmpDir, resolve("data", "archivist-tmp"));
  assert.equal(paths.exportsDir, resolve("data", "archivist-exports"));
  assert.equal(archiveFolder(paths, ARCHIVE_ID), join(paths.archivesRoot, ARCHIVE_ID));
  assert.equal(archiveRelativePath(ARCHIVE_ID.toUpperCase()), `archives/${ARCHIVE_ID}`);
});

test("only generated archive IDs can name an archive folder", () => {
  assert.equal(archiveIdValue("archiveId", ` ${ARCHIVE_ID} `), ARCHIVE_ID);
  for (const bad of ["../escape", "archive", `${ARCHIVE_ID}/..`, "", undefined]) {
    assert.throws(() => archiveIdValue("archiveId", bad), isInvalid, String(bad));
  }
});

test("stored media paths stay inside their archive", () => {
  const folder = resolve("data/archives", ARCHIVE_ID);
  assert.equal(
    insideArchive(folder, "media/originals/a.png"),
    join(folder, "media/originals/a.png"),
  );
  for (const bad of [
    "/etc/passwd",
    "../other-archive/media/a.png",
    "media/../../escape.png",
    "media\\originals\\a.png",
    ".",
    "",
  ]) {
    assert.throws(() => insideArchive(folder, bad), isInvalid, bad);
  }
});
