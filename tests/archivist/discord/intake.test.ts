import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { ArchivistApi } from "../../../src/lib/archivist-api.js";
import { ArchivistError } from "../../../src/lib/archivist-errors.js";
import {
  downloadAttachment,
  intakeForm,
  type IntakeFields,
  MAX_MEDIA_BYTES,
  submitIntake,
} from "../../../src/lib/archivist-intake.js";

const ARCHIVE = "70a6c078-8c11-4b87-829a-9493089f7784";
const ATTACHMENT_URL =
  "https://cdn.discordapp.com/attachments/900000000000000111/1311000000000000002/meetup.png?ex=1&hm=2";

const FIELDS: IntakeFields = {
  description: "Meetup photo",
  characters: ["c1", "c2"],
  events: ["e1"],
  exactDate: "2019-07-15 6:30pm",
  guildId: "727573539904815224",
  channelId: "900000000000000111",
};

function uploadFolders(): number {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("archivist-upload-")).length;
}

function cdn(bytes: Uint8Array, headers: Record<string, string> = {}) {
  return (async (input: string | URL | Request) => {
    assert.equal(new URL(String(input)).hostname, "cdn.discordapp.com");
    return new Response(bytes, { headers });
  }) as typeof fetch;
}

test("the form lists every field before the file, with the bot's own fields", () => {
  assert.deepEqual(intakeForm(FIELDS, true), [
    ["description", "Meetup photo"],
    ["characters", "c1"],
    ["characters", "c2"],
    ["events", "e1"],
    ["exactDate", "2019-07-15 6:30pm"],
    ["zoneConfirmed", "true"],
    ["submissionGuildId", "727573539904815224"],
    ["submissionChannelId", "900000000000000111"],
  ]);
  assert.ok(!intakeForm(FIELDS, false).some(([name]) => name === "zoneConfirmed"));
});

test("an attachment is forwarded byte for byte, with its Discord identity, and nothing is left behind", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
  const before = uploadFolders();
  let sent: FormData | undefined;
  let path: string | undefined;
  let received: Uint8Array | undefined;
  const api = {
    async upload(_user: string, to: string, form: FormData) {
      path = to;
      sent = form;
      // The file is read while the request is sent, before its temporary copy is removed.
      received = new Uint8Array(await (form.get("file") as File).arrayBuffer());
      return { status: "created" };
    },
  } as unknown as ArchivistApi;
  await submitIntake(
    { userId: "200000000000000002" },
    ARCHIVE,
    FIELDS,
    {
      kind: "attachment",
      id: "1311000000000000002",
      url: ATTACHMENT_URL,
      size: 8,
      name: "meetup.png",
    },
    false,
    api,
    cdn(bytes),
  );
  assert.equal(path, `/api/archives/${ARCHIVE}/artifacts/intake`);
  const entries = [...sent!.entries()];
  const names = entries.map(([name]) => name);
  assert.equal(names.at(-1), "file", "the file comes last");
  assert.deepEqual(sent!.getAll("discordAttachmentId"), ["1311000000000000002"]);
  assert.deepEqual(sent!.getAll("discordAttachmentUrl"), [ATTACHMENT_URL]);
  const file = sent!.get("file") as File;
  assert.equal(file.name, "meetup.png");
  assert.deepEqual(received, bytes);
  assert.equal(uploadFolders(), before);
});

test("the temporary copy is removed even when the service refuses the upload", async () => {
  const before = uploadFolders();
  const api = {
    async upload() {
      throw new ArchivistError("invalid_input", "Refused.");
    },
  } as unknown as ArchivistApi;
  await assert.rejects(
    submitIntake(
      { userId: "200000000000000002" },
      ARCHIVE,
      FIELDS,
      { kind: "attachment", id: "1", url: ATTACHMENT_URL, size: 3, name: "a.png" },
      false,
      api,
      cdn(new Uint8Array([1, 2, 3])),
    ),
  );
  assert.equal(uploadFolders(), before);
});

test("a Drive link goes to the service as JSON for it to fetch", async () => {
  let body: Record<string, unknown> | undefined;
  const api = {
    async post(_user: string, _path: string, json: Record<string, unknown>) {
      body = json;
      return { status: "created" };
    },
  } as unknown as ArchivistApi;
  await submitIntake(
    { userId: "200000000000000002" },
    ARCHIVE,
    { ...FIELDS, characters: ["c1"] },
    { kind: "drive", link: "https://drive.google.com/file/d/abc/view" },
    true,
    api,
  );
  assert.equal(body!.driveLink, "https://drive.google.com/file/d/abc/view");
  assert.deepEqual(body!.characters, ["c1"], "one character is still a list");
  assert.equal(body!.zoneConfirmed, "true");
  assert.equal(body!.submissionGuildId, "727573539904815224");
});

test("downloads come only from Discord's file host and refuse files over the limit", async () => {
  await assert.rejects(
    downloadAttachment("https://evil.example/a.png", "/nonexistent", cdn(new Uint8Array())),
    (error: unknown) => error instanceof ArchivistError && error.code === "invalid_input",
  );
  await assert.rejects(
    downloadAttachment(
      ATTACHMENT_URL,
      "/nonexistent",
      cdn(new Uint8Array([1]), { "content-length": String(MAX_MEDIA_BYTES + 1) }),
    ),
    (error: unknown) => error instanceof ArchivistError && error.code === "media_too_large",
  );
});
