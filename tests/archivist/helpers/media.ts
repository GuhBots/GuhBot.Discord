import { writeFileSync } from "node:fs";
import { exiftool, type WriteTags } from "exiftool-vendored";
import sharp from "sharp";

/**
 * Builds small media fixtures with known embedded dates at test time, so no
 * binary fixtures are committed and every tag a test relies on is visible.
 */

/** Seconds between the QuickTime epoch (1904) and the Unix epoch. */
const QUICKTIME_EPOCH_OFFSET = 2_082_844_800;

type ImageFormat = "jpeg" | "png" | "webp" | "gif";

export async function writeImage(
  file: string,
  format: ImageFormat,
  tags: Record<string, string> = {},
): Promise<void> {
  const image = sharp({ create: { width: 16, height: 12, channels: 3, background: "#5865f2" } });
  await image.toFormat(format).toFile(file);
  await writeTags(file, tags);
}

export async function writeTags(file: string, tags: Record<string, string>): Promise<void> {
  if (Object.keys(tags).length === 0) return;
  await exiftool.write(file, tags as unknown as WriteTags, {
    writeArgs: ["-overwrite_original"],
  });
}

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
}

/**
 * A minimal MP4 holding only a file-type box and a movie header whose
 * creation time is `createdAtMs`, enough for ExifTool to read and write.
 */
export async function writeMp4(
  file: string,
  createdAtMs: number,
  tags: Record<string, string> = {},
  brand = "isom",
): Promise<void> {
  const fileType = box(
    "ftyp",
    Buffer.from(brand, "latin1"),
    Buffer.from([0, 0, 2, 0]),
    Buffer.from("isomiso2mp41", "latin1"),
  );
  const header = Buffer.alloc(96);
  const seconds = Math.floor(createdAtMs / 1000) + QUICKTIME_EPOCH_OFFSET;
  header.writeUInt32BE(seconds, 0);
  header.writeUInt32BE(seconds, 4);
  header.writeUInt32BE(1000, 8);
  header.writeUInt32BE(0x00010000, 16);
  header.writeUInt16BE(0x0100, 20);
  const identity = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  identity.forEach((value, index) => header.writeUInt32BE(value, 32 + index * 4));
  header.writeUInt32BE(2, 92);
  const movie = box("moov", box("mvhd", Buffer.alloc(4), header));
  writeFileSync(file, Buffer.concat([fileType, movie]));
  await writeTags(file, tags);
}

/** An EBML element: its ID bytes, a one-byte size, and its body. Bodies stay under 127 bytes. */
function ebml(id: number[], ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(id), Buffer.from([0x80 | body.length]), body]);
}

/** Milliseconds from the Unix epoch to Matroska's, 2001-01-01 UTC. */
const MATROSKA_EPOCH_MS = Date.UTC(2001, 0, 1);

/**
 * A minimal WebM or Matroska file: an EBML header naming its document type,
 * and a segment whose info holds `DateUTC` when `createdAtMs` is given.
 */
export function writeMatroska(
  file: string,
  docType: "webm" | "matroska",
  createdAtMs?: number,
): void {
  const header = ebml(
    [0x1a, 0x45, 0xdf, 0xa3],
    ebml([0x42, 0x86], Buffer.from([1])),
    ebml([0x42, 0xf7], Buffer.from([1])),
    ebml([0x42, 0xf2], Buffer.from([4])),
    ebml([0x42, 0xf3], Buffer.from([8])),
    ebml([0x42, 0x82], Buffer.from(docType, "latin1")),
    ebml([0x42, 0x87], Buffer.from([4])),
    ebml([0x42, 0x85], Buffer.from([2])),
  );
  const info: Buffer[] = [ebml([0x2a, 0xd7, 0xb1], Buffer.from([0x0f, 0x42, 0x40]))];
  if (createdAtMs !== undefined) {
    const date = Buffer.alloc(8);
    date.writeBigInt64BE(BigInt(createdAtMs - MATROSKA_EPOCH_MS) * 1_000_000n);
    info.push(ebml([0x44, 0x61], date));
  }
  const segment = ebml([0x18, 0x53, 0x80, 0x67], ebml([0x15, 0x49, 0xa9, 0x66], ...info));
  writeFileSync(file, Buffer.concat([header, segment]));
}

function riffChunk(id: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, "latin1");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/** A short silent WAV, with an INFO creation date (`ICRD`) when one is given. */
export function writeWav(file: string, created?: string): void {
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(1, 2);
  format.writeUInt32LE(8000, 4);
  format.writeUInt32LE(16000, 8);
  format.writeUInt16LE(2, 12);
  format.writeUInt16LE(16, 14);
  const chunks = [riffChunk("fmt ", format), riffChunk("data", Buffer.alloc(160))];
  if (created !== undefined) {
    const info = riffChunk("ICRD", Buffer.from(`${created}\0`, "latin1"));
    chunks.push(riffChunk("LIST", Buffer.concat([Buffer.from("INFO", "latin1"), info])));
  }
  const body = Buffer.concat([Buffer.from("WAVE", "latin1"), ...chunks]);
  writeFileSync(file, riffChunk("RIFF", body));
}

/** A syncsafe ID3 size: seven bits per byte. */
function syncsafe(size: number): Buffer {
  return Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
}

/**
 * A short silent MP3 whose ID3 tag holds a recording year, as music files
 * do. Each frame is MPEG-1 layer III at 128 kbit/s and 44.1 kHz.
 */
export function writeMp3(file: string, recordingYear = "2019"): void {
  const text = Buffer.concat([Buffer.from([3]), Buffer.from(recordingYear, "latin1")]);
  const frame = Buffer.concat([
    Buffer.from("TDRC", "latin1"),
    syncsafe(text.length),
    Buffer.alloc(2),
    text,
  ]);
  const tag = Buffer.concat([
    Buffer.from("ID3", "latin1"),
    Buffer.from([4, 0, 0]),
    syncsafe(frame.length),
    frame,
  ]);
  const audioFrame = Buffer.alloc(417);
  audioFrame.set([0xff, 0xfb, 0x90, 0x64]);
  writeFileSync(file, Buffer.concat([tag, audioFrame, audioFrame, audioFrame]));
}

/** Stops the ExifTool process the fixture writers use. */
export async function closeFixtureWriter(): Promise<void> {
  await exiftool.end();
}
