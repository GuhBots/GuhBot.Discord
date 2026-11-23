import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { ArchivistError } from "./errors.js";

/**
 * Where Archivist keeps its files under the bot's data directory. Each archive
 * folder is portable. Temporary staging and export jobs live beside the
 * archives, never inside them, so they never end up in an export.
 */
export interface ArchivistPaths {
  dataDir: string;
  archivesRoot: string;
  tmpDir: string;
  exportsDir: string;
}

export function archivistPaths(dataDir: string): ArchivistPaths {
  const root = resolve(dataDir);
  return {
    dataDir: root,
    archivesRoot: join(root, "archives"),
    tmpDir: join(root, "archivist-tmp"),
    exportsDir: join(root, "archivist-exports"),
  };
}

const ARCHIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Rejects anything but a generated archive ID, so an ID can never name another path. */
export function archiveIdValue(field: string, value: unknown): string {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!ARCHIVE_ID.test(id)) {
    throw new ArchivistError("invalid_input", `${field} must be an archive ID.`, { field });
  }
  return id;
}

/** The folder of an archive, named by its stable ID. Renaming never moves it. */
export function archiveFolder(paths: ArchivistPaths, archiveId: string): string {
  return join(paths.archivesRoot, archiveIdValue("archiveId", archiveId));
}

/** The archive's path relative to the data directory, as the registry stores it. */
export function archiveRelativePath(archiveId: string): string {
  return `archives/${archiveIdValue("archiveId", archiveId)}`;
}

/**
 * Resolves a path stored in an archive, which is always relative to the
 * archive folder. Absolute paths and paths that climb out of the folder are
 * rejected, so a damaged or hostile archive cannot reach other files.
 */
export function insideArchive(folder: string, storedPath: string): string {
  const cleaned = normalize(storedPath);
  const target = resolve(folder, cleaned);
  const fromFolder = relative(folder, target);
  if (
    !storedPath ||
    isAbsolute(storedPath) ||
    storedPath.includes("\\") ||
    fromFolder === "" ||
    fromFolder.startsWith(`..${sep}`) ||
    fromFolder === ".." ||
    isAbsolute(fromFolder)
  ) {
    throw new ArchivistError("invalid_input", "A stored media path points outside its archive.", {
      field: "path",
    });
  }
  return target;
}
