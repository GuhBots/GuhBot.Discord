import assert from "node:assert/strict";
import { test } from "node:test";
import { ArchivistError } from "../../../src/archivist/errors.js";
import {
  colorValue,
  discordId,
  nameKey,
  optionalText,
  requiredText,
  TEXT_LIMITS,
  timestamp,
} from "../../../src/archivist/fields.js";

function isInvalid(field: string) {
  return (error: unknown) =>
    error instanceof ArchivistError &&
    error.code === "invalid_input" &&
    error.status === 400 &&
    error.details.field === field;
}

test("required text is trimmed and rejected when blank", () => {
  assert.equal(requiredText("description", "  A photo \n", TEXT_LIMITS.description), "A photo");
  assert.throws(() => requiredText("description", " \n\t ", 10), isInvalid("description"));
  assert.throws(() => requiredText("description", undefined, 10), isInvalid("description"));
});

test("text limits count characters, not UTF-16 units", () => {
  const hundredEmoji = "😀".repeat(TEXT_LIMITS.name);
  assert.equal(hundredEmoji.length, 200);
  assert.equal(requiredText("name", hundredEmoji, TEXT_LIMITS.name), hundredEmoji);
  assert.throws(
    () => requiredText("name", `${hundredEmoji}😀`, TEXT_LIMITS.name),
    isInvalid("name"),
  );
});

test("blank optional text becomes null", () => {
  assert.equal(optionalText("realName", undefined, TEXT_LIMITS.name), null);
  assert.equal(optionalText("realName", null, TEXT_LIMITS.name), null);
  assert.equal(optionalText("realName", "   ", TEXT_LIMITS.name), null);
  assert.equal(optionalText("realName", " Sam ", TEXT_LIMITS.name), "Sam");
  assert.throws(() => optionalText("realName", 5, TEXT_LIMITS.name), isInvalid("realName"));
});

test("colors are stored as lowercase #rrggbb", () => {
  assert.equal(colorValue("color", " #5865F2 "), "#5865f2");
  assert.throws(() => colorValue("color", "#fff"), isInvalid("color"));
  assert.throws(() => colorValue("color", "blue"), isInvalid("color"));
});

test("Discord IDs must be snowflakes", () => {
  assert.equal(discordId("userId", "707321853198467163"), "707321853198467163");
  assert.throws(() => discordId("userId", "12345"), isInvalid("userId"));
  assert.throws(() => discordId("userId", "<@707321853198467163>"), isInvalid("userId"));
});

test("archive name keys ignore case and Unicode form", () => {
  assert.equal(nameKey("Straße"), nameKey("STRASSE"));
  assert.equal(nameKey("Ärchiv"), nameKey("ärchiv"));
  assert.equal(nameKey("ＧｕｈＢｏｔ"), nameKey("guhbot"));
  assert.notEqual(nameKey("Archive One"), nameKey("Archive Two"));
});

test("errors serialize to the web error body", () => {
  const error = new ArchivistError("stale_version", "Someone else edited this.", { version: 3 });
  assert.equal(error.status, 409);
  assert.deepEqual(JSON.parse(JSON.stringify(error)), {
    code: "stale_version",
    message: "Someone else edited this.",
    details: { version: 3 },
  });
});

test("timestamps use a zero offset", () => {
  assert.equal(timestamp(new Date(Date.UTC(2026, 10, 23, 5, 6, 7))), "2026-11-23T05:06:07.000Z");
});
