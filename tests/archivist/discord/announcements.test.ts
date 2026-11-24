import assert from "node:assert/strict";
import { test } from "node:test";
import { type Client, DiscordAPIError } from "discord.js";
import type { ArchivistApi } from "../../../src/lib/archivist-api.js";
import {
  announceNow,
  announcementNote,
  claimAndPost,
  postAnnouncement,
  startPoller,
} from "../../../src/lib/archivist-announce.js";
import type { AnnouncementItem } from "../../../src/lib/archivist-types.js";

const ARCHIVE = "70a6c078-8c11-4b87-829a-9493089f7784";
const ARTIFACT = "3f9a1c2e-0000-4000-8000-000000000000";
const CLAIM = "11111111-2222-4333-8444-555555555555";

function item(overrides: Partial<AnnouncementItem> = {}): AnnouncementItem {
  return {
    archiveId: ARCHIVE,
    artifactId: ARTIFACT,
    claimId: CLAIM,
    channel: { guildId: "727573539904815224", channelId: "900000000000000111" },
    archiveName: "Hangout",
    archiveTimeZone: "America/Toronto",
    characterNames: ["Sam"],
    previewPath: `/api/service/announcements/${ARCHIVE}/${ARTIFACT}/preview`,
    artifact: {
      id: ARTIFACT,
      version: 1,
      createdAt: "2026-11-20T00:00:00.000Z",
      createdBy: "200000000000000002",
      updatedAt: "2026-11-20T00:00:00.000Z",
      description: "Meetup photo",
      source: { provider: "web_upload", key: "k", url: null, resourceKey: null },
      submission: { guildId: null, channelId: null, messageId: null },
      media: {
        id: "m1",
        originalFilename: "photo.png",
        mimeType: "image/png",
        byteLength: 10,
        sha256: "0".repeat(64),
        hasPreview: true,
        readable: true,
        fileDateStatus: "none",
      },
      dates: { exact: null, estimated: null, file: null, selected: null },
      unidentifiedCharacters: false,
      links: { characters: ["c1"], accounts: [], servers: [], channels: [], events: [] },
    },
    ...overrides,
  };
}

/** A stand-in for the service, recording reports. */
function fakeApi(items: AnnouncementItem[] = []) {
  const reports: { path: string; body: unknown }[] = [];
  const claims: unknown[] = [];
  const api = {
    async service(_method: string, path: string, body: unknown) {
      if (path.endsWith("/claim")) {
        claims.push(body);
        return { items: items.splice(0) };
      }
      reports.push({ path, body });
      return undefined;
    },
    async bytes() {
      return Buffer.from("RIFF0000WEBP");
    },
  } as unknown as ArchivistApi;
  return { api, reports, claims };
}

/** A client whose one channel posts, refuses, or times out as told. */
function fakeClient(send: () => Promise<{ id: string }>, found = true) {
  const sent: unknown[] = [];
  const channel = {
    isSendable: () => true,
    isDMBased: () => false,
    send: async (payload: unknown) => {
      sent.push(payload);
      return send();
    },
  };
  const client = {
    channels: {
      fetch: async () => {
        if (!found) throw new Error("Unknown Channel");
        return channel;
      },
    },
  } as unknown as Client<true>;
  return { client, sent };
}

test("a sent post is reported with its message, under the claim's ID", async () => {
  const { api, reports } = fakeApi();
  const { client, sent } = fakeClient(async () => ({ id: "1311000000000000001" }));
  assert.deepEqual(await postAnnouncement(client, item(), api), { status: "sent" });
  assert.equal(sent.length, 1);
  const payload = sent[0] as { files: unknown[]; allowedMentions: unknown };
  assert.equal(payload.files.length, 1, "the preview is attached");
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.deepEqual(reports, [
    {
      path: `/api/service/announcements/${ARCHIVE}/${ARTIFACT}/result`,
      body: { claimId: CLAIM, state: "sent", messageId: "1311000000000000001" },
    },
  ]);
});

test("a missing channel or a refusal is a failure, and anything uncertain is indeterminate", async () => {
  const gone = fakeApi();
  const missing = await postAnnouncement(
    fakeClient(async () => ({ id: "1" }), false).client,
    item(),
    gone.api,
  );
  assert.equal(missing.status, "failed");
  assert.equal((gone.reports[0]!.body as { state: string }).state, "failed");

  const refused = fakeApi();
  const denied = new DiscordAPIError(
    { code: 50013, message: "Missing Permissions" },
    50013,
    403,
    "POST",
    "/channels/1/messages",
    {},
  );
  const outcome = await postAnnouncement(
    fakeClient(async () => {
      throw denied;
    }).client,
    item(),
    refused.api,
  );
  assert.equal(outcome.status, "failed");
  assert.match(announcementNote(outcome)!, /Saved, but not announced/);

  const unsure = fakeApi();
  const timedOut = await postAnnouncement(
    fakeClient(async () => {
      throw new Error("Request timed out");
    }).client,
    item(),
    unsure.api,
  );
  assert.equal(timedOut.status, "indeterminate");
  assert.equal((unsure.reports[0]!.body as { state: string }).state, "indeterminate");
});

test("claims post every item they hand out, and the bot's own upload can be claimed by itself", async () => {
  const queued = fakeApi([item(), item({ artifactId: "4f9a1c2e-0000-4000-8000-000000000000" })]);
  const { client, sent } = fakeClient(async () => ({ id: "2" }));
  const outcomes = await claimAndPost(client, {}, queued.api);
  assert.equal(outcomes.length, 2);
  assert.equal(sent.length, 2);
  assert.equal(queued.reports.length, 2);

  assert.deepEqual(await announceNow(client, ARCHIVE, ARTIFACT, "not_configured"), {
    status: "not_configured",
  });
});

test("the poller never runs two rounds at once and logs a failing streak once", async () => {
  let running = 0;
  let most = 0;
  let calls = 0;
  let fail = false;
  const logged: string[] = [];
  let release: () => void = () => undefined;
  const poller = startPoller(
    async () => {
      calls += 1;
      running += 1;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => (release = resolve));
      running -= 1;
      if (fail) throw new Error("down");
    },
    60_000,
    (message) => logged.push(message),
  );
  const first = poller.tick();
  await poller.tick();
  release();
  await first;
  assert.equal(calls, 1, "a tick during a round is skipped");
  assert.equal(most, 1);

  fail = true;
  for (let round = 0; round < 3; round += 1) {
    const tick = poller.tick();
    release();
    await tick;
  }
  assert.equal(logged.length, 1, "one log line for the whole outage");
  poller.stop();
});
