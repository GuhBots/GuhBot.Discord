import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
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
  mov: { mimeType: "video/quicktime", extension: "mov" },
  webm: { mimeType: "video/webm", extension: "webm" },
  mkv: { mimeType: "video/x-matroska", extension: "mkv" },
  avi: { mimeType: "video/x-msvideo", extension: "avi" },
  mp3: { mimeType: "audio/mpeg", extension: "mp3" },
  m4a: { mimeType: "audio/mp4", extension: "m4a" },
  wav: { mimeType: "audio/wav", extension: "wav" },
  ogg: { mimeType: "audio/ogg", extension: "ogg" },
  flac: { mimeType: "audio/flac", extension: "flac" },
};

/** What people are told the bot accepts, matching `detectFormat`. */
export const ACCEPTED_FORMATS_TEXT =
  "images (JPEG, PNG, WebP, GIF), videos (MP4, MOV, WebM, MKV, AVI), and audio (MP3, M4A, WAV, Ogg, FLAC)";

/** Only still images get a preview. Videos and audio are shown by name. */
const IMAGE_FORMATS = new Set<MediaFormat>(["jpeg", "png", "gif", "webp"]);

/** MP4 video brands. HEIF images are not accepted. */
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

/** Apple audio brands in the same container. */
const M4A_BRANDS = new Set(["M4A ", "M4B "]);

/**
 * The first atom of an older QuickTime file that has no `ftyp` atom. These
 * names are QuickTime's own, so such a file is read as a MOV.
 */
const QUICKTIME_ATOMS = new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);

const PREVIEW_SIZE = 1024;
/** Enough for a Matroska header to name its document type. */
const HEADER_BYTES = 64;

/** An MPEG audio layer III frame header, the start of an MP3 without ID3 tags. */
function isMp3Frame(header: Buffer): boolean {
  if (header.length < 3 || header[0] !== 0xff) return false;
  const second = header[1]!;
  const third = header[2]!;
  const syncAndLayer3 = (second & 0xe6) === 0xe2;
  const version = (second >> 3) & 0x03;
  const bitrate = third >> 4;
  const sampleRate = (third >> 2) & 0x03;
  return syncAndLayer3 && version !== 1 && bitrate !== 0 && bitrate !== 15 && sampleRate !== 3;
}

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
  if (ascii.startsWith("RIFF")) {
    const kind = ascii.slice(8, 12);
    if (kind === "WEBP") return "webp";
    if (kind === "AVI ") return "avi";
    if (kind === "WAVE") return "wav";
    return null;
  }
  if (ascii.slice(4, 8) === "ftyp") {
    const brand = ascii.slice(8, 12);
    if (MP4_BRANDS.has(brand)) return "mp4";
    if (brand === "qt  ") return "mov";
    if (M4A_BRANDS.has(brand)) return "m4a";
    return null;
  }
  if (QUICKTIME_ATOMS.has(ascii.slice(4, 8))) return "mov";
  if (header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    // The EBML header names its document type near the start.
    if (ascii.includes("webm")) return "webm";
    if (ascii.includes("matroska")) return "mkv";
    return null;
  }
  if (ascii.startsWith("OggS")) return "ogg";
  if (ascii.startsWith("fLaC")) return "flac";
  if (ascii.startsWith("ID3") || isMp3Frame(header)) return "mp3";
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
      `Only ${ACCEPTED_FORMATS_TEXT} can be archived.`,
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
  if (IMAGE_FORMATS.has(format)) {
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

/**
 * Records a staged file in the `media` table. Runs inside the mutation that
 * also places the file with `placeStagedMedia`.
 */
export function insertMediaRow(
  db: import("better-sqlite3").Database,
  mediaId: string,
  paths: { original: string; preview: string | null },
  media: StagedMedia,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO media (id, original_path, preview_path, original_filename, mime_type, byte_length, sha256, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    mediaId,
    paths.original,
    paths.preview,
    media.originalFilename,
    media.mimeType,
    media.byteLength,
    media.sha256,
    JSON.stringify({ tags: media.tags, fileDate: media.fileDate, readable: media.readable }),
    createdAt,
  );
}

/** Whether a staged file is a still image, as avatars, icons, and pictures must be. */
export function isImage(media: StagedMedia): boolean {
  return IMAGE_FORMATS.has(media.format);
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

/** How long an intake may stay staged, such as while a duplicate review waits. */
export const STAGING_LIFETIME_MS = 15 * 60_000;

/**
 * Removes staging folders older than `maxAgeMs`. Intakes that were cancelled,
 * expired, or interrupted by a restart leave these behind. Returns how many
 * were removed.
 */
export function cleanStaging(context: ArchivistContext, maxAgeMs = STAGING_LIFETIME_MS): number {
  const stagingRoot = join(context.paths.tmpDir, "staging");
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(stagingRoot);
  } catch {
    return 0;
  }
  const cutoff = context.now().getTime() - maxAgeMs;
  for (const entry of entries) {
    const folder = join(stagingRoot, entry);
    if (statSync(folder).mtimeMs < cutoff) {
      rmSync(folder, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}
