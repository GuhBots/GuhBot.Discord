import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFileDate } from "../../../src/archivist/metadata.js";

test("an IPTC date without a time is a calendar-only file date", () => {
  const date = extractFileDate("jpeg", { "IPTC:DateCreated": "2010:05:06" });
  assert.deepEqual(date.value, {
    kind: "day",
    originalText: "2010:05:06",
    calendarDay: "2010-05-06",
  });
});

test("an IPTC date uses its own time and offset", () => {
  const date = extractFileDate("jpeg", {
    "IPTC:DateCreated": "2010:05:06",
    "IPTC:TimeCreated": "08:30:00+02:00",
  });
  assert.equal(date.value?.kind === "instant" && date.value.instantMs, Date.UTC(2010, 4, 6, 6, 30));
});

test("zeroed placeholder dates count as absent, so creation tags are used", () => {
  const date = extractFileDate("jpeg", {
    "ExifIFD:DateTimeOriginal": "0000:00:00 00:00:00",
    "ExifIFD:CreateDate": "2011:01:01 10:00:00",
  });
  assert.equal(date.status, "found");
  assert.equal(date.tier, "creation");
});

test("a damaged capture date needs review instead of falling back", () => {
  const date = extractFileDate("jpeg", {
    "ExifIFD:DateTimeOriginal": "2019:13:45 10:00:00",
    "ExifIFD:CreateDate": "2011:01:01 10:00:00",
  });
  assert.equal(date.status, "malformed");
  assert.equal(date.tier, "capture");
  assert.equal(date.value, null);
  assert.equal(
    extractFileDate("jpeg", {
      "ExifIFD:DateTimeOriginal": "2019:01:01 10:00:00",
      "ExifIFD:OffsetTimeOriginal": "nonsense",
    }).status,
    "malformed",
  );
});

test("agreeing capture tags pick the one with the most detail", () => {
  const date = extractFileDate("jpeg", {
    "IPTC:DateCreated": "2019:07:15",
    "ExifIFD:DateTimeOriginal": "2019:07:15 13:45:00",
    "XMP-exif:DateTimeOriginal": "2019:07:15 13:45:00-04:00",
  });
  assert.equal(date.status, "found");
  assert.equal(date.sourceTag, "XMP-exif:DateTimeOriginal");
  assert.equal(date.candidates.length, 3);
});

test("tags agreeing on the time but not the offset conflict", () => {
  const date = extractFileDate("jpeg", {
    "ExifIFD:DateTimeOriginal": "2019:07:15 13:45:00",
    "ExifIFD:OffsetTimeOriginal": "-04:00",
    "XMP-exif:DateTimeOriginal": "2019:07:15 13:45:00+02:00",
  });
  assert.equal(date.status, "conflict");
});

test("an MP4 creation date counts only with its own offset", () => {
  const withoutOffset = extractFileDate("mp4", {
    "Keys:CreationDate": "2019:07:15 13:45:00",
    "QuickTime:CreateDate": "2019:07:15 17:45:00",
  });
  assert.equal(withoutOffset.tier, "creation");
  assert.equal(withoutOffset.sourceTag, "QuickTime:CreateDate");
});

test("formats ignore tags outside their field map", () => {
  const gif = extractFileDate("gif", { "ExifIFD:DateTimeOriginal": "2019:07:15 13:45:00" });
  assert.equal(gif.status, "absent");
  const png = extractFileDate("png", { "PNG:ModifyDate": "2015:05:05 05:05:05" });
  assert.equal(png.status, "absent");
});
