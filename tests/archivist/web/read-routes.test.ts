import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { createArchive } from "../../../src/archivist/archives.js";
import { createArtifact } from "../../../src/archivist/artifacts.js";
import {
  createAccount,
  createCharacter,
  createServer,
  createChannel,
} from "../../../src/archivist/entities.js";
import { addHistory } from "../../../src/archivist/history.js";
import { createEvent } from "../../../src/archivist/events.js";
import { createStagingFolder, stageMedia } from "../../../src/archivist/media.js";
import { addMember, removeMember } from "../../../src/archivist/members.js";
import { closeMetadataReader } from "../../../src/archivist/metadata.js";
import type { ArtifactSummary } from "../../../src/archivist/queries.js";
import { MEMBER, OTHER, OWNER } from "../helpers/context.js";
import { closeFixtureWriter, writeImage, writeWav } from "../helpers/media.js";
import { webHarness, type WebHarness } from "../helpers/web.js";

after(async () => {
  await closeMetadataReader();
  await closeFixtureWriter();
});

let sourceCounter = 0;

async function seed(t: TestContext) {
  const h = await webHarness(t);
  const { context } = h;
  const { archiveId } = createArchive(context, OWNER, { name: "Hangout" });
  addMember(context, OWNER, { archiveId, userId: MEMBER.userId });
  const sam = createCharacter(context, MEMBER, {
    archiveId,
    knownName: "Sam",
    birthDay: "2001-04-12",
  });
  const lee = createCharacter(context, MEMBER, { archiveId, knownName: "Lee" });
  const hangout = createServer(context, MEMBER, {
    archiveId,
    label: "The Hangout",
    discordId: "727573539904815224",
  });
  const general = createChannel(context, MEMBER, {
    archiveId,
    kind: "guild_channel",
    label: "general",
    serverId: hangout.id,
  });
  const trip = createChannel(context, MEMBER, {
    archiveId,
    kind: "group_chat",
    label: "Road Trip",
  });
  const add = async (options: {
    description: string;
    day?: string;
    estimated?: boolean;
    audio?: boolean;
    characters?: string[];
    channels?: string[];
    servers?: string[];
  }) => {
    const file = join(createStagingFolder(context), "original");
    if (options.audio) writeWav(file);
    else await writeImage(file, "png");
    const media = await stageMedia(context, {
      file,
      originalFilename: options.audio ? "a.wav" : "a.png",
    });
    sourceCounter += 1;
    return createArtifact(context, MEMBER, {
      archiveId,
      description: options.description,
      media,
      source: {
        provider: "discord_attachment",
        key: `8${String(sourceCounter).padStart(17, "0")}`,
      },
      exactDate: options.day && !options.estimated ? options.day : undefined,
      estimatedDate:
        options.day && options.estimated ? { day: options.day, reason: "Decorations" } : null,
      links: {
        characters: options.characters ?? [],
        channels: options.channels ?? [],
        servers: options.servers ?? [],
      },
    }).artifact;
  };
  const a1 = await add({
    description: "First meetup photo",
    day: "2019-08-03",
    characters: [sam.id, lee.id],
    channels: [general.id],
  });
  const a2 = await add({
    description: "Road trip clip",
    day: "2020-07-18",
    estimated: true,
    characters: [sam.id],
    channels: [trip.id],
  });
  const a3 = await add({
    description: "Voice note",
    day: "2020-07-18",
    audio: true,
    characters: [lee.id],
  });
  const a4 = await add({ description: "Undated meme", servers: [hangout.id] });
  return { h, archiveId, sam, lee, hangout, general, trip, a1, a2, a3, a4 };
}

async function get(h: WebHarness, url: string, cookie: string) {
  return h.app.inject({ method: "GET", url, cookies: { archivist_session: cookie } });
}

test("archive routes need a session and current access, rechecked on every request", async (t) => {
  const { h, archiveId } = await seed(t);
  assert.equal(
    (await h.app.inject({ method: "GET", url: `/api/archives/${archiveId}` })).statusCode,
    401,
  );

  const outsider = await get(h, `/api/archives/${archiveId}/artifacts`, h.cookie(OTHER));
  assert.equal(outsider.statusCode, 404);
  assert.equal(outsider.json().code, "archive_not_found");
  assert.deepEqual((await get(h, "/api/archives", h.cookie(OTHER))).json(), { archives: [] });

  const member = h.cookie(MEMBER);
  assert.deepEqual((await get(h, "/api/archives", member)).json(), {
    archives: [{ archiveId, name: "Hangout" }],
  });
  assert.equal((await get(h, `/api/archives/${archiveId}`, member)).json().name, "Hangout");

  // Removal applies to the very next request on the same session.
  removeMember(h.context, OWNER, { archiveId, userId: MEMBER.userId });
  assert.equal((await get(h, `/api/archives/${archiveId}/artifacts`, member)).statusCode, 404);
  assert.equal(
    (await get(h, `/api/archives/${archiveId}/artifacts`, h.cookie(OWNER))).statusCode,
    200,
  );
});

test("artifact lists filter by every shared category, sort, and page without repeats", async (t) => {
  const { h, archiveId, sam, lee, hangout, general, trip, a1, a2, a3, a4 } = await seed(t);
  const cookie = h.cookie(MEMBER);
  const list = async (query: string) => {
    const response = await get(h, `/api/archives/${archiveId}/artifacts?${query}`, cookie);
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as { items: ArtifactSummary[]; next: string | null; total: number };
  };
  const ids = async (query: string) => (await list(query)).items.map((item) => item.id);

  // Oldest first, undated last; newest first keeps undated last; recently added is submission order.
  assert.deepEqual(await ids(""), await ids("sort=oldest"));
  const oldest = await ids("sort=oldest");
  assert.equal(oldest[0], a1.id);
  assert.deepEqual(new Set(oldest.slice(1, 3)), new Set([a2.id, a3.id]));
  assert.equal(oldest[3], a4.id);
  const newest = await ids("sort=newest");
  assert.deepEqual(new Set(newest.slice(0, 2)), new Set([a2.id, a3.id]));
  assert.deepEqual(newest.slice(2), [a1.id, a4.id]);
  assert.equal((await list("sort=added")).total, 4);

  // Within a category any value matches; across categories every one must.
  assert.deepEqual(new Set(await ids(`character=${sam.id}`)), new Set([a1.id, a2.id]));
  assert.deepEqual(
    new Set(await ids(`character=${sam.id}&character=${lee.id}`)),
    new Set([a1.id, a2.id, a3.id]),
  );
  assert.deepEqual(await ids(`character=${lee.id}&media=audio`), [a3.id]);
  assert.deepEqual(new Set(await ids(`server=${hangout.id}`)), new Set([a1.id, a4.id]));
  assert.deepEqual(await ids(`channel=${general.id}`), [a1.id]);
  assert.deepEqual(await ids("basis=estimated"), [a2.id]);
  assert.deepEqual(await ids("basis=undated"), [a4.id]);
  assert.deepEqual(
    new Set(await ids("fromDay=2020-01-01&toDay=2020-12-31")),
    new Set([a2.id, a3.id]),
  );
  assert.deepEqual(await ids("q=MEETUP"), [a1.id]);
  assert.deepEqual(await ids("unidentified=true"), []);

  // Each item says which lanes it belongs to.
  const items = new Map((await list("")).items.map((item) => [item.id, item]));
  assert.deepEqual(items.get(a1.id)!.lanes, [hangout.id]);
  assert.deepEqual(items.get(a2.id)!.lanes, [trip.id]);
  assert.deepEqual(items.get(a3.id)!.lanes, ["unassigned"]);
  assert.equal(items.get(a3.id)!.media.kind, "audio");
  assert.equal(items.get(a2.id)!.basis, "estimated");
  assert.equal(items.get(a2.id)!.day, "2020-07-18");

  // Pages of one cover everything once, in order.
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await list(`sort=newest&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(page.total, 4);
    seen.push(...page.items.map((item) => item.id));
    cursor = page.next;
  } while (cursor);
  assert.deepEqual(seen, newest);

  for (const bad of [
    "limit=0",
    "limit=101",
    "media=gif",
    "basis=maybe",
    "character=sam",
    "fromDay=2020-02-30",
    "cursor=nonsense",
    "sort=random",
    "fromDay=2021-01-01&toDay=2020-01-01",
  ]) {
    const response = await get(h, `/api/archives/${archiveId}/artifacts?${bad}`, cookie);
    assert.equal(response.statusCode, 400, bad);
    assert.equal(response.json().code, "invalid_input", bad);
  }
});

test("places, characters, records, events, and search fill the website's columns and pages", async (t) => {
  const { h, archiveId, sam, lee, hangout, trip } = await seed(t);
  const cookie = h.cookie(MEMBER);
  const account = createAccount(h.context, MEMBER, {
    archiveId,
    kind: "human",
    label: "samwise",
    discordId: "175928847299117063",
    characterId: sam.id,
  });
  addHistory(h.context, MEMBER, {
    archiveId,
    kind: "account_name",
    parentId: account.id,
    expectedVersion: 1,
    name: "sam#1234",
    date: "2019-08-01",
  });
  addHistory(h.context, MEMBER, {
    archiveId,
    kind: "server_name",
    parentId: hangout.id,
    expectedVersion: 1,
    name: "Hangout 2.0",
    date: "2020-03-14",
  });

  const places = (await get(h, `/api/archives/${archiveId}/places?day=2019-09-01`, cookie)).json()
    .places;
  assert.deepEqual(
    places.map((p: { name: string; kind: string }) => [p.kind, p.name]),
    [
      ["group_chat", "Road Trip"],
      ["server", "The Hangout"],
    ],
  );
  const later = (await get(h, `/api/archives/${archiveId}/places?day=2020-06-01`, cookie)).json()
    .places;
  assert.equal(later.find((p: { id: string }) => p.id === hangout.id).name, "Hangout 2.0");

  const characters = (await get(h, `/api/archives/${archiveId}/entities/character`, cookie)).json();
  assert.deepEqual(
    characters.items.map((c: { knownName: string }) => c.knownName),
    ["Lee", "Sam"],
  );
  assert.deepEqual(characters.items[0].picture, { source: "initials" });
  const firstPage = (
    await get(h, `/api/archives/${archiveId}/entities/character?limit=1`, cookie)
  ).json();
  const secondPage = (
    await get(
      h,
      `/api/archives/${archiveId}/entities/character?limit=1&cursor=${firstPage.next}`,
      cookie,
    )
  ).json();
  assert.deepEqual(
    [firstPage.items[0].id, secondPage.items[0].id, secondPage.next],
    [lee.id, sam.id, null],
  );
  const found = (await get(h, `/api/archives/${archiveId}/entities/account?q=SAMW`, cookie)).json();
  assert.deepEqual(found.items, [{ id: account.id, label: "samwise" }]);

  const view = (
    await get(h, `/api/archives/${archiveId}/entities/character/${sam.id.slice(0, 8)}`, cookie)
  ).json();
  assert.equal(view.knownName, "Sam");
  assert.equal(view.birthDay, "2001-04-12");
  assert.equal(view.accounts[0].label, "samwise");
  // Discord's own documented example ID decodes to this moment.
  assert.equal(view.accounts[0].discordCreatedAt, "2016-04-30T11:18:25.796Z");
  assert.equal(view.accounts[0].history[0].name, "sam#1234");
  const server = (
    await get(h, `/api/archives/${archiveId}/entities/server/${hangout.id}`, cookie)
  ).json();
  assert.equal(server.discordCreatedAt, "2020-06-30T17:17:29.576Z");
  assert.deepEqual(
    server.channels.map((c: { label: string }) => c.label),
    ["general"],
  );
  assert.equal(
    (await get(h, `/api/archives/${archiveId}/entities/planet/${sam.id}`, cookie)).statusCode,
    404,
  );

  createEvent(h.context, MEMBER, {
    archiveId,
    title: "Summer season",
    description: "A shared world",
    dateKind: "duration",
    certainty: "exact",
    start: "2020-06-01",
    end: "2020-08-31",
    links: { characters: [sam.id], channels: [trip.id] },
  });
  createEvent(h.context, MEMBER, {
    archiveId,
    title: "Launch",
    description: "Opened",
    dateKind: "single",
    certainty: "exact",
    start: "2019-08-03",
  });
  const events = (
    await get(h, `/api/archives/${archiveId}/events?fromDay=2020-07-01&toDay=2020-07-31`, cookie)
  ).json();
  assert.deepEqual(
    events.items.map((e: { title: string }) => e.title),
    ["Summer season"],
  );
  assert.equal(
    (await get(h, `/api/archives/${archiveId}/events?character=${lee.id}`, cookie)).json().total,
    0,
  );

  const search = (await get(h, `/api/archives/${archiveId}/search?q=road`, cookie)).json();
  assert.deepEqual(
    search.places.map((p: { label: string }) => p.label),
    ["Road Trip"],
  );
  assert.deepEqual(
    search.artifacts.map((a: { label: string }) => a.label),
    ["Road trip clip"],
  );
  assert.deepEqual(
    (await get(h, `/api/archives/${archiveId}/search`, cookie)).json().artifacts,
    [],
  );
  // The undated meme, and the two events with no supporting artifact yet.
  const backlog = (await get(h, `/api/archives/${archiveId}/backlog?status=needed`, cookie)).json();
  assert.deepEqual(backlog.items.map((c: { kind: string }) => c.kind).sort(), [
    "missing_evidence",
    "missing_evidence",
    "undated",
  ]);
  assert.equal(
    (await get(h, `/api/archives/${archiveId}/backlog?status=maybe`, cookie)).statusCode,
    400,
  );
});
