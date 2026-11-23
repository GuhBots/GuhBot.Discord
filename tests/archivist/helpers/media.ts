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

/** Stops the ExifTool process the fixture writers use. */
export async function closeFixtureWriter(): Promise<void> {
  await exiftool.end();
}
