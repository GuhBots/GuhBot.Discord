import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { createArchive } from "../../../src/archivist/archives.js";
import type { ArtifactDetails } from "../../../src/archivist/artifacts.js";
import {
  createAccount,
  createChannel,
  createCharacter,
  createServer,
} from "../../../src/archivist/entities.js";
import { addMember } from "../../../src/archivist/members.js";
import { closeMetadataReader } from "../../../src/archivist/metadata.js";
import { MEMBER, OTHER, OWNER } from "../helpers/context.js";
import { closeFixtureWriter, writeImage, writeWav } from "../helpers/media.js";
import { makeTempDir } from "../helpers/temp-dir.js";
import { WEB_SETTINGS, type WebOverrides, webHarness } from "../helpers/web.js";

after(async () => {
  await closeMetadataReader();
  await closeFixtureWriter();
});

const FILE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_-012";

async function pngBytes(t: TestContext): Promise<Buffer> {
  const file = join(makeTempDir(t), "photo.png");
  await writeImage(file, "png");
  return readFileSync(file);
}

/** Google's public download address, serving one PNG. */
function fakeDrive(bytes: Buffer): { fetch: typeof fetch; downloads: () => number } {
  let downloads = 0;
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "drive.usercontent.google.com");
    if (new Headers(init.headers).get("range") === "bytes=0-0") {
      return new Response(bytes.subarray(0, 1), {
        status: 206,
        headers: {
          "content-type": "image/png",
          "content-range": `bytes 0-0/${bytes.length}`,
          "content-disposition": `attachment; filename="trip.png"`,
        },
      });
    }
    downloads += 1;
    return new Response(bytes, {
      headers: { "content-type": "image/png", "content-length": String(bytes.length) },
    });
  }) as typeof fetch;
  return { fetch: fakeFetch, downloads: () => downloads };
}

async function setup(t: TestContext, overrides: WebOverrides = {}) {
  const announced: string[] = [];
  const h = await webHarness(t, WEB_SETTINGS, {
    announce: async (_archiveId, artifact) => {
      announced.push(artifact.id);
      return { status: "sent" };
    },
    ...overrides,
  });
  const { archiveId } = createArchive(h.context, OWNER, { name: "Hangout" });
  addMember(h.context, OWNER, { archiveId, userId: MEMBER.userId });
  const sam = createCharacter(h.context, MEMBER, { archiveId, knownName: "Sam" });
  const cookie = h.cookie(MEMBER);
  /** Sends a form as a browser would, fields before the file. */
  const upload = async (
    fields: Record<string, string | string[]>,
    file?: { name: string; bytes: Buffer },
    who = cookie,
  ) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) {
      for (const item of Array.isArray(value) ? value : [value]) form.append(name, item);
    }
    if (file) form.append("file", new Blob([file.bytes]), file.name);
    const encoded = new Request("http://localhost/", { method: "POST", body: form });
    const response = await h.app.inject({
      method: "POST",
      url: `/api/archives/${archiveId}/artifacts/intake`,
      headers: { origin: h.origin, "content-type": encoded.headers.get("content-type")! },
      cookies: { archivist_session: who },
      payload: Buffer.from(await encoded.arrayBuffer()),
    });
    return { status: response.statusCode, body: response.json() };
  };
  const get = (path: string, headers: Record<string, string> = {}, who = cookie) =>
    h.app.inject({
      method: "GET",
      url: `/api/archives/${archiveId}${path}`,
      headers,
      cookies: { archivist_session: who },
    });
  // Nothing staged yet means the folder does not exist at all.
  const staging = () => {
    const folder = join(h.context.paths.tmpDir, "staging");
    return existsSync(folder) ? readdirSync(folder).length : 0;
  };
  return { h, archiveId, sam, cookie, upload, get, announced, staging };
}

test("an upload from the website becomes an announced artifact, and its media streams to members only", async (t) => {
  const { h, archiveId, sam, upload, get, announced, staging } = await setup(t);
  const bytes = await pngBytes(t);

  const made = await upload(
    { description: "Meetup photo", exactDate: "2019-08-03", characters: [sam.id] },
    { name: "meetup.png", bytes },
  );
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const artifact = made.body.artifact as ArtifactDetails;
  assert.equal(made.body.status, "created");
  assert.deepEqual(made.body.announcement, { status: "sent" });
  assert.deepEqual(announced, [artifact.id]);
  assert.equal(artifact.source.provider, "web_upload");
  assert.deepEqual(artifact.links.characters, [sam.id]);
  assert.equal(artifact.media.originalFilename, "meetup.png");
  assert.equal(staging(), 0);

  const original = await get(`/media/${artifact.media.id}`);
  assert.equal(original.statusCode, 200);
  assert.equal(original.headers["content-type"], "image/png");
  assert.equal(original.headers["cache-control"], "private, no-cache");
  assert.match(String(original.headers["content-disposition"]), /^inline; filename="meetup.png"/);
  assert.deepEqual(original.rawPayload, bytes);
  const part = await get(`/media/${artifact.media.id}`, { range: "bytes=0-7" });
  assert.equal(part.statusCode, 206);
  assert.deepEqual(part.rawPayload, bytes.subarray(0, 8));
  const download = await get(`/media/${artifact.media.id}?download=1`);
  assert.match(String(download.headers["content-disposition"]), /^attachment;/);
  const preview = await get(`/media/${artifact.media.id}/preview`);
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.headers["content-type"], "image/webp");

  assert.equal((await get(`/media/${artifact.media.id}`, {}, h.cookie(OTHER))).statusCode, 404);
  assert.equal((await get("/media/00000000-0000-4000-8000-000000000000")).statusCode, 404);

  // Deleting the artifact keeps its media, which members can still download.
  const deleted = await h.app.inject({
    method: "DELETE",
    url: `/api/archives/${archiveId}/artifacts/${artifact.id}?expectedVersion=1`,
    headers: { origin: h.origin },
    cookies: { archivist_session: h.cookie(MEMBER) },
  });
  assert.equal(deleted.statusCode, 204);
  assert.equal((await get(`/media/${artifact.media.id}`)).statusCode, 200);

  const log = await get("/edit-log");
  assert.equal(log.statusCode, 200);
  assert.match(
    String(log.headers["content-disposition"]),
    /^attachment; filename="Hangout edits.log"/,
  );
  assert.match(log.body, new RegExp(sam.id));
});

test("uploads are checked before the file is kept, and a time without a zone must be confirmed", async (t) => {
  const { h, upload, staging, announced } = await setup(t);
  const bytes = await pngBytes(t);
  const file = { name: "a.png", bytes };

  const noDescription = await upload({ exactDate: "2019-08-03" }, file);
  assert.equal(noDescription.status, 400);
  assert.equal(noDescription.body.details.field, "description");
  const badLink = await upload(
    { description: "x", characters: ["00000000-0000-4000-8000-000000000000"] },
    file,
  );
  assert.equal(badLink.status, 400);
  const unconfirmed = await upload(
    { description: "Late night", exactDate: "2019-07-15 6:30pm" },
    file,
  );
  assert.equal(unconfirmed.status, 400);
  assert.equal(unconfirmed.body.details.reason, "zone_unconfirmed");
  assert.equal(staging(), 0);
  assert.deepEqual(announced, []);

  const confirmed = await upload(
    { description: "Late night", exactDate: "2019-07-15 6:30pm", zoneConfirmed: "true" },
    file,
  );
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.body.artifact.dates.exact.date.kind, "instant");

  assert.equal((await upload({ description: "Nothing" })).status, 400);
  const both = await upload(
    { description: "Both", driveLink: `https://drive.google.com/file/d/${FILE_ID}/view` },
    file,
  );
  assert.equal(both.status, 400);
  const outsider = await upload({ description: "Sneaky" }, file, h.cookie(OTHER));
  assert.equal(outsider.status, 404);
});

test("a Drive link already in the archive opens a review that only its contributor can apply, once", async (t) => {
  const bytes = await pngBytes(t);
  const drive = fakeDrive(bytes);
  const { h, archiveId, sam, upload, announced } = await setup(t, { fetch: drive.fetch });
  const link = `https://drive.google.com/file/d/${FILE_ID}/view`;

  const first = await upload({ description: "Road trip", driveLink: link });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const original = first.body.artifact as ArtifactDetails;
  assert.equal(original.source.provider, "drive");
  assert.equal(original.media.originalFilename, "trip.png");
  assert.equal(drive.downloads(), 1);

  const again = await upload({
    description: "Road trip, day two",
    driveLink: link,
    characters: [sam.id],
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.status, "duplicate");
  assert.equal(again.body.artifact.id, original.id);
  assert.deepEqual(again.body.differences.map((d: { key: string }) => d.key).sort(), [
    "characters",
    "description",
  ]);
  assert.equal(drive.downloads(), 1, "the file is not downloaded again");
  assert.deepEqual(announced, [original.id], "a duplicate is not announced");

  const apply = (token: string, who: string) =>
    h.app.inject({
      method: "POST",
      url: `/api/archives/${archiveId}/artifacts/reviews/${token}/apply`,
      headers: { origin: h.origin },
      cookies: { archivist_session: who },
      payload: { selected: ["characters"] },
    });
  // Someone else cannot use the review, and using it does not burn it for its owner.
  assert.equal((await apply(again.body.reviewToken, h.cookie(OWNER))).statusCode, 404);
  const applied = await apply(again.body.reviewToken, h.cookie(MEMBER));
  assert.equal(applied.statusCode, 200);
  // Only the ticked difference changed: the character link was added, the description kept.
  assert.deepEqual(applied.json().links.characters, [sam.id]);
  assert.equal(applied.json().description, "Road trip");
  assert.equal((await apply(again.body.reviewToken, h.cookie(MEMBER))).statusCode, 404);

  // A matching resubmission has nothing to review.
  const same = await upload({ description: "Road trip", driveLink: link, characters: [sam.id] });
  assert.equal(same.body.status, "duplicate");
  assert.equal(same.body.reviewToken, null);
});

test("the logs channel is set through the bot's channel check, or refused without the bot", async (t) => {
  const checks: string[] = [];
  const { h, archiveId } = await setup(t, {
    checkAnnouncementChannel: async (userId, channelId) => {
      checks.push(`${userId}:${channelId}`);
      return { guildId: "727573539904815224" };
    },
  });
  const send = (method: "GET" | "PUT" | "DELETE", payload?: object) =>
    h.app.inject({
      method,
      url: `/api/archives/${archiveId}/artifact-logs-channel`,
      headers: { origin: h.origin },
      cookies: { archivist_session: h.cookie(MEMBER) },
      ...(payload ? { payload } : {}),
    });
  assert.deepEqual((await send("GET")).json(), { channel: null });
  assert.equal((await send("PUT", { channelId: "nope" })).statusCode, 400);
  const set = await send("PUT", { channelId: "900000000000000123" });
  assert.equal(set.statusCode, 200);
  assert.deepEqual(set.json().channel, {
    guildId: "727573539904815224",
    channelId: "900000000000000123",
  });
  assert.deepEqual(checks, [`${MEMBER.userId}:900000000000000123`]);
  assert.deepEqual((await send("DELETE")).json(), { removed: true });

  const without = await setup(t);
  const refused = await without.h.app.inject({
    method: "PUT",
    url: `/api/archives/${without.archiveId}/artifact-logs-channel`,
    headers: { origin: without.h.origin },
    cookies: { archivist_session: without.cookie },
    payload: { channelId: "900000000000000123" },
  });
  assert.equal(refused.statusCode, 503);
});

test("pictures for records upload with the same checks: dated avatars and icons, current fallbacks", async (t) => {
  const { h, archiveId, sam, staging } = await setup(t);
  const account = createAccount(h.context, MEMBER, {
    archiveId,
    kind: "human",
    label: "samwise",
    characterId: sam.id,
  });
  const bytes = await pngBytes(t);
  const send = async (
    kind: string,
    id: string,
    fields: Record<string, string>,
    file: { name: string; bytes: Buffer },
    who = h.cookie(MEMBER),
    trailingFields: Record<string, string> = {},
  ) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    form.append("file", new Blob([file.bytes]), file.name);
    for (const [name, value] of Object.entries(trailingFields)) form.append(name, value);
    const encoded = new Request("http://localhost/", { method: "POST", body: form });
    const response = await h.app.inject({
      method: "POST",
      url: `/api/archives/${archiveId}/entities/${kind}/${id}/picture`,
      headers: { origin: h.origin, "content-type": encoded.headers.get("content-type")! },
      cookies: { archivist_session: who },
      payload: Buffer.from(await encoded.arrayBuffer()),
    });
    return { status: response.statusCode, body: response.json() };
  };

  const avatar = await send(
    "account",
    account.id,
    { purpose: "avatar", expectedVersion: "1", date: "2019-08-01" },
    { name: "me.png", bytes },
  );
  assert.equal(avatar.status, 201, JSON.stringify(avatar.body));
  const entry = avatar.body.history.find((e: { kind: string }) => e.kind === "avatar");
  assert.equal(entry.date.archiveDay, "2019-08-01");
  const media = await h.app.inject({
    method: "GET",
    url: `/api/archives/${archiveId}/media/${entry.mediaId}`,
    cookies: { archivist_session: h.cookie(MEMBER) },
  });
  assert.deepEqual(media.rawPayload, bytes);

  const fallback = await send(
    "character",
    sam.id,
    { purpose: "fallback", expectedVersion: "1" },
    { name: "sam.png", bytes },
  );
  assert.equal(fallback.status, 201);
  assert.ok(fallback.body.fallbackMediaId);
  assert.equal(fallback.body.pictures.at(-1).mediaId, fallback.body.fallbackMediaId);

  const server = createServer(h.context, MEMBER, { archiveId, label: "Hangout" });
  const icon = await send(
    "server",
    server.id,
    { purpose: "server_icon", expectedVersion: "1", date: "2020-09-01" },
    { name: "server.png", bytes },
  );
  assert.equal(icon.status, 201, JSON.stringify(icon.body));
  assert.equal(
    icon.body.history.find((entry: { kind: string }) => entry.kind === "server_icon").date
      .archiveDay,
    "2020-09-01",
  );
  const chat = createChannel(h.context, MEMBER, { archiveId, kind: "group_chat", label: "Trip" });
  const chatIcon = await send(
    "channel",
    chat.id,
    { purpose: "icon", expectedVersion: "1" },
    { name: "chat.png", bytes },
  );
  assert.equal(chatIcon.status, 201, JSON.stringify(chatIcon.body));
  assert.ok(chatIcon.body.iconMediaId);

  const changedPurpose = await send(
    "character",
    sam.id,
    { purpose: "fallback", expectedVersion: "2" },
    { name: "late.png", bytes },
    h.cookie(MEMBER),
    { purpose: "server_icon" },
  );
  assert.equal(changedPurpose.status, 400);
  assert.equal(changedPurpose.body.code, "invalid_input");
  assert.equal(staging(), 0);

  assert.equal(
    (
      await send(
        "character",
        sam.id,
        { purpose: "avatar", expectedVersion: "2" },
        { name: "x.png", bytes },
      )
    ).status,
    400,
  );
  const wav = join(makeTempDir(t), "a.wav");
  writeWav(wav);
  assert.equal(
    (
      await send(
        "character",
        sam.id,
        { purpose: "fallback", expectedVersion: "2" },
        { name: "a.wav", bytes: readFileSync(wav) },
      )
    ).status,
    415,
  );
  assert.equal(
    (
      await send(
        "character",
        sam.id,
        { purpose: "fallback", expectedVersion: "1" },
        { name: "late.png", bytes },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await send(
        "character",
        sam.id,
        { purpose: "fallback", expectedVersion: "2" },
        { name: "x.png", bytes },
        h.cookie(OTHER),
      )
    ).status,
    404,
  );
});
