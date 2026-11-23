import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import sharp from "sharp";
import type { ArchivistContext } from "./context.js";
import { syncDirectory } from "./edit-log.js";
import { ArchivistError } from "./errors.js";
import {
  extractFileDate,
  type FileDate,
  type MediaFormat,
  type RawTags,
  readRawMetadata,
} from "./metadata.js";
import { insideArchive } from "./paths.js";

/**
 * Media intake. A source is first written into a staging folder outside every
 * archive. Staging checks the real format from the file's bytes, hashes it,
 * reads its embedded metadata, and makes a preview. The original is never
 * changed or re-encoded. It is moved into the archive only as part of the
 * mutation that records it, so a failed intake leaves no archive files.
 */

export const MAX_MEDIA_BYTES = 104_857_600;

export const MEDIA_TYPES: Record<MediaFormat, { mimeType: string; extension: string }> = {
  jpeg: { mimeType: "image/jpeg", extension: "jpg" },
  png: { mimeType: "image/png", extension: "png" },
  gif: { mimeType: "image/gif", extension: "gif" },
  webp: { mimeType: "image/webp", extension: "webp" },
  mp4: { mimeType: "video/mp4", extension: "mp4" },
};

/** MP4 brands. QuickTime (`qt  `), HEIF, and audio-only brands are not accepted. */
const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "M4V ",
  "MSNV",
  "dash",
  "mmp4",
]);

const PREVIEW_SIZE = 1024;
const HEADER_BYTES = 32;

/** Identifies a supported format from a file's first bytes, ignoring its name. */
export function detectFormat(header: Buffer): MediaFormat | null {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "jpeg";
  }
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  const ascii = header.toString("latin1");
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "webp";
  if (ascii.slice(4, 8) === "ftyp" && MP4_BRANDS.has(ascii.slice(8, 12))) return "mp4";
  return null;
}

function readHeader(file: string): Buffer {
  const fd = openSync(file, "r");
  try {
    const header = Buffer.alloc(HEADER_BYTES);
    const length = readSync(fd, header, 0, HEADER_BYTES, 0);
    return header.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function flushFile(file: string): void {
  const fd = openSync(file, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A folder for one intake under `archivist-tmp/staging`. Remove it with `discardStaging`. */
export function createStagingFolder(context: ArchivistContext): string {
  const folder = join(context.paths.tmpDir, "staging", randomUUID());
  mkdirSync(folder, { recursive: true });
  return folder;
}

export function discardStaging(context: ArchivistContext, folder: string): void {
  const stagingRoot = join(context.paths.tmpDir, "staging");
  const fromRoot = relative(stagingRoot, folder);
  if (!fromRoot || fromRoot.startsWith("..") || fromRoot.includes(sep)) {
    throw new Error("Only a staging folder can be discarded.");
  }
  rmSync(folder, { recursive: true, force: true });
}

export interface StagedMedia {
  folder: string;
  originalFile: string;
  previewFile: string | null;
  originalFilename: string;
  format: MediaFormat;
  mimeType: string;
  extension: string;
  byteLength: number;
  sha256: string;
  tags: RawTags;
  fileDate: FileDate;
  /** False when the original could not be decoded, which makes it a critical research card. */
  readable: boolean;
}

function cleanFilename(name: unknown, extension: string): string {
  const base = typeof name === "string" ? basename(name.replaceAll("\\", "/")).trim() : "";
  const safe = Array.from(base.replace(/[\u0000-\u001f]/g, ""))
    .slice(0, 255)
    .join("");
  return safe || `original.${extension}`;
}

/**
 * Checks and describes a file that an intake adapter wrote into a staging
 * folder. Fails without changing anything when the file is empty, too large,
 * or not a supported format. A preview failure does not fail staging.
 */
export async function stageMedia(
  context: ArchivistContext,
  input: { file: string; originalFilename: unknown },
): Promise<StagedMedia> {
  const folder = dirname(input.file);
  const stagingRoot = join(context.paths.tmpDir, "staging");
  if (relative(stagingRoot, folder).startsWith("..")) {
    throw new Error("Media must be staged inside the staging folder.");
  }
  const byteLength = statSync(input.file).size;
  if (byteLength === 0) {
    throw new ArchivistError("invalid_input", "The file is empty.", { field: "file" });
  }
  if (byteLength > MAX_MEDIA_BYTES) {
    throw new ArchivistError("media_too_large", "Files can be at most 100 MiB.", {
      field: "file",
      maxBytes: MAX_MEDIA_BYTES,
    });
  }
  const format = detectFormat(readHeader(input.file));
  if (!format) {
    throw new ArchivistError(
      "unsupported_media_type",
      "Only JPEG, PNG, WebP, GIF, and MP4 files can be archived.",
      { field: "file" },
    );
  }
  flushFile(input.file);
  const { mimeType, extension } = MEDIA_TYPES[format];
  const sha256 = await hashFile(input.file);
  const metadata = await readRawMetadata(input.file);
  const fileDate = extractFileDate(format, metadata.tags);

  let previewFile: string | null = null;
  let readable = metadata.errors.length === 0;
  if (format !== "mp4") {
    const target = join(folder, "preview.webp");
    try {
      await sharp(input.file, { animated: false, failOn: "error" })
        .rotate()
        .resize({
          width: PREVIEW_SIZE,
          height: PREVIEW_SIZE,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .toFile(target);
      flushFile(target);
      previewFile = target;
    } catch {
      rmSync(target, { force: true });
      readable = false;
    }
  }

  return {
    folder,
    originalFile: input.file,
    previewFile,
    originalFilename: cleanFilename(input.originalFilename, extension),
    format,
    mimeType,
    extension,
    byteLength,
    sha256,
    tags: metadata.tags,
    fileDate,
    readable,
  };
}

/** Where a media record's files live, relative to its archive folder. */
export function mediaPaths(mediaId: string, extension: string, hasPreview: boolean) {
  return {
    original: `media/originals/${mediaId}.${extension}`,
    preview: hasPreview ? `media/previews/${mediaId}.webp` : null,
  };
}

function moveFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    // Staging on another filesystem. Copy, flush, then remove the staged copy.
    copyFileSync(from, to);
    flushFile(to);
    rmSync(from);
  }
  syncDirectory(dirname(to));
}

/** Moves a staged original and preview into an archive. Used as a mutation's `placeFiles`. */
export function placeStagedMedia(
  folder: string,
  staged: StagedMedia,
  paths: { original: string; preview: string | null },
): void {
  moveFile(staged.originalFile, insideArchive(folder, paths.original));
  if (staged.previewFile && paths.preview) {
    moveFile(staged.previewFile, insideArchive(folder, paths.preview));
  }
}
