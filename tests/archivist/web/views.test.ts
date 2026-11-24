import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { createArchive, updateArchiveSettings } from "../../../src/archivist/archives.js";
import { createArtifact } from "../../../src/archivist/artifacts.js";
import {
  createAccount,
  createChannel,
  createCharacter,
  createServer,
} from "../../../src/archivist/entities.js";
import { createEvent } from "../../../src/archivist/events.js";
import { addHistory } from "../../../src/archivist/history.js";
import { createStagingFolder, stageMedia } from "../../../src/archivist/media.js";
import { addMember } from "../../../src/archivist/members.js";
import { closeMetadataReader } from "../../../src/archivist/metadata.js";
import type { DayCounts, GraphView, TimelineView } from "../../../src/archivist/views.js";
import { MEMBER, OWNER } from "../helpers/context.js";
import { closeFixtureWriter, writeImage } from "../helpers/media.js";
import { webHarness } from "../helpers/web.js";

after(async () => {
  await closeMetadataReader();
  await closeFixtureWriter();
});

let sourceCounter = 0;

async function world(t: TestContext) {
  const h = await webHarness(t);
  const c = h.context;
  const { archiveId } = createArchive(c, OWNER, { name: "Hangout" });
  addMember(c, OWNER, { archiveId, userId: MEMBER.userId });
  const sam = createCharacter(c, MEMBER, { archiveId, knownName: "Sam" });
  const lee = createCharacter(c, MEMBER, { archiveId, knownName: "Lee" });
  const kai = createCharacter(c, MEMBER, { archiveId, knownName: "Kai" });
  const hangout = createServer(c, MEMBER, { archiveId, label: "The Hangout" });
  const owls = createServer(c, MEMBER, { archiveId, label: "Night Owls" });
  const general = createChannel(c, MEMBER, {
    archiveId,
    kind: "guild_channel",
    label: "general",
    serverId: hangout.id,
  });
  const trip = createChannel(c, MEMBER, { archiveId, kind: "group_chat", label: "Road Trip" });
  updateArchiveSettings(c, OWNER, { archiveId, expectedVersion: 1, mainServerId: hangout.id });
  addHistory(c, MEMBER, {
    archiveId,
    kind: "server_name",
    parentId: hangout.id,
    expectedVersion: 1,
    name: "Hangout 2.0",
    date: "2020-03-14",
  });

  const add = async (
    description: string,
    links: Record<string, string[]>,
    day?: string,
    estimated = false,
  ) => {
    const file = join(createStagingFolder(c), "original");
    await writeImage(file, "png");
    sourceCounter += 1;
    return createArtifact(c, MEMBER, {
      archiveId,
      description,
      media: await stageMedia(c, { file, originalFilename: "a.png" }),
      source: {
        provider: "discord_attachment",
        key: `9${String(sourceCounter).padStart(17, "0")}`,
      },
      exactDate: day && !estimated ? day : undefined,
      estimatedDate: day && estimated ? { day, reason: "Decorations" } : null,
      links,
    }).artifact;
  };
  const a1 = await add(
    "Meetup",
    { channels: [general.id], characters: [sam.id, lee.id] },
    "2019-08-03",
  );
  const a2 = await add(
    "Movie night",
    { servers: [hangout.id], characters: [sam.id, lee.id] },
    "2019-08-20",
  );
  const a3 = await add(
    "Summer build",
    { servers: [hangout.id], characters: [sam.id] },
    "2020-06-15",
    true,
  );
  const a4 = await add(
    "Road trip",
    { channels: [trip.id], characters: [sam.id, kai.id] },
    "2020-07-18",
  );
  const a5 = await add("Old meme", {});

  createEvent(c, MEMBER, {
    archiveId,
    title: "Launch",
    description: "Opened",
    dateKind: "single",
    certainty: "exact",
    start: "2019-08-03",
    links: { servers: [hangout.id] },
  });
  createEvent(c, MEMBER, {
    archiveId,
    title: "Summer",
    description: "Season",
    dateKind: "duration",
    certainty: "exact",
    start: "2020-06-01",
    end: "2020-08-31",
    links: { characters: [sam.id, lee.id] },
  });
  createEvent(c, MEMBER, {
    archiveId,
    title: "Exams",
    description: "Busy",
    dateKind: "occurrence_window",
    certainty: "estimated",
    start: "2020-11-15",
    end: "2020-12-15",
  });

  const samAccount = createAccount(c, MEMBER, {
    archiveId,
    kind: "human",
    label: "samwise",
    characterId: sam.id,
  });
  const leeAccount = createAccount(c, MEMBER, {
    archiveId,
    kind: "human",
    label: "leep",
    characterId: lee.id,
  });
  const kaiAccount = createAccount(c, MEMBER, {
    archiveId,
    kind: "human",
    label: "kai",
    characterId: kai.id,
  });
  addHistory(c, MEMBER, {
    archiveId,
    kind: "account_name",
    parentId: samAccount.id,
    expectedVersion: 1,
    name: "sam#1234",
    date: "2019-08-01",
  });
  addHistory(c, MEMBER, {
    archiveId,
    kind: "account_name",
    parentId: samAccount.id,
    expectedVersion: 2,
    name: "samwise",
    date: "2020-04-02",
  });
  for (const [account, server, start, end] of [
    [samAccount, hangout, "2019-08-03", undefined],
    [leeAccount, hangout, "2019-08-05", "2020-01-01"],
    [samAccount, owls, "2019-11-10", "2020-06-01"],
    [leeAccount, owls, "2021-01-01", undefined],
    [kaiAccount, hangout, undefined, undefined],
  ] as const) {
    const version = (
      c.stores
        .get(archiveId)!
        .db.prepare("SELECT version FROM accounts WHERE id = ?")
        .get(account.id) as { version: number }
    ).version;
    addHistory(c, MEMBER, {
      archiveId,
      kind: "membership",
      parentId: account.id,
      expectedVersion: version,
      targetId: server.id,
      start,
      end,
    });
  }
  addHistory(c, MEMBER, {
    archiveId,
    kind: "introduction",
    parentId: sam.id,
    expectedVersion: 1,
    targetId: lee.id,
    date: "2019-08-02",
  });

  const cookie = h.cookie(MEMBER);
  const get = async <T>(path: string) => {
    const response = await h.app.inject({
      method: "GET",
      url: `/api/archives/${archiveId}${path}`,
      cookies: { archivist_session: cookie },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as T;
  };
  return { h, archiveId, get, sam, lee, kai, hangout, owls, trip, samAccount, a1, a2, a3, a4, a5 };
}

test("the timeline returns lanes with activity stretches, shaded dots, arrows, the event band, and markers", async (t) => {
  const { get, hangout, trip, sam, samAccount, h, archiveId } = await world(t);
  const view = await get<TimelineView>(
    "/timeline?fromDay=2019-01-01&toDay=2020-12-31&bucket=month",
  );

  // Unassigned, group chats, other servers, then the main server next to the events.
  assert.deepEqual(
    view.lanes.map((lane) => lane.kind),
    ["unassigned", "group_chat", "server", "server"],
  );
  const main = view.lanes.at(-1)!;
  assert.equal(main.id, hangout.id);
  assert.equal(main.isMain, true);
  assert.deepEqual(main.dots, [
    { start: "2019-08-01", end: "2019-08-31", count: 2, uncertain: false },
    { start: "2020-06-01", end: "2020-06-30", count: 1, uncertain: true },
  ]);
  // A gap over 90 days splits the lane; a stretch with only estimated dates is dashed.
  assert.deepEqual(main.segments, [
    { start: "2019-08-03", end: "2019-08-20", uncertain: false },
    { start: "2020-06-15", end: "2020-06-15", uncertain: true },
  ]);
  assert.deepEqual(main.arrows, [
    {
      kind: "event",
      day: "2019-08-03",
      id: main.arrows[0]!.kind === "event" ? main.arrows[0]!.id : "",
      title: "Launch",
      estimated: false,
    },
    { kind: "name", day: "2020-03-14", name: "Hangout 2.0" },
  ]);
  assert.deepEqual(main.names, [{ name: "Hangout 2.0", day: "2020-03-14" }]);
  assert.deepEqual(
    view.lanes.find((lane) => lane.id === trip.id)!.dots.map((d) => d.start),
    ["2020-07-01"],
  );
  assert.deepEqual(view.lanes[0]!.dots, [], "the undated meme has no dot");
  assert.equal(view.undated, 1);

  assert.deepEqual(
    view.band.map((b) => [b.title, b.dateKind, b.estimated]),
    [
      ["Summer", "duration", false],
      ["Exams", "occurrence_window", true],
    ],
  );
  assert.deepEqual(
    view.markers.map((m) => [m.kind, m.day, m.characterId, m.accountId, m.name]),
    [["account_name", "2020-04-02", sam.id, samAccount.id, "samwise"]],
  );

  // Week buckets start on Monday; filters narrow the counts.
  const weeks = await get<TimelineView>(
    `/timeline?fromDay=2019-08-01&toDay=2019-08-31&bucket=week&character=${sam.id}`,
  );
  assert.deepEqual(
    weeks.lanes.at(-1)!.dots.map((d) => [d.start, d.count]),
    [
      ["2019-07-29", 1],
      ["2019-08-19", 1],
    ],
  );
  const onlyLee = await get<TimelineView>(
    `/timeline?fromDay=2019-01-01&toDay=2020-12-31&bucket=month&character=${"0".repeat(8)}-0000-4000-8000-000000000000`,
  );
  assert.equal(
    onlyLee.lanes.every((lane) => lane.dots.length === 0),
    true,
  );

  // A dot's gallery is the artifact list for that lane and period.
  const gallery = await get<{ items: { description: string }[] }>(
    `/artifacts?lane=${hangout.id}&fromDay=2019-08-01&toDay=2019-08-31`,
  );
  assert.deepEqual(
    gallery.items.map((i) => i.description),
    ["Meetup", "Movie night"],
  );
  const unassigned = await get<{ items: { description: string }[] }>("/artifacts?lane=unassigned");
  assert.deepEqual(
    unassigned.items.map((i) => i.description),
    ["Old meme"],
  );

  for (const bad of [
    "fromDay=2020-01-01&toDay=2019-01-01&bucket=day",
    "fromDay=1900-01-01&toDay=2020-01-01&bucket=month",
    "fromDay=2020-01-01&toDay=2020-02-01&bucket=decade",
  ]) {
    const response = await h.app.inject({
      method: "GET",
      url: `/api/archives/${archiveId}/timeline?${bad}`,
      cookies: { archivist_session: h.cookie(MEMBER) },
    });
    assert.equal(response.statusCode, 400, bad);
  }
});

test("the calendar and heatmap count artifacts and events per day, separately", async (t) => {
  const { get } = await world(t);
  const year = await get<DayCounts>("/heatmap?year=2020");
  assert.deepEqual(year.days, [
    { day: "2020-06-01", artifacts: 0, uncertainArtifacts: 0, events: 1, estimatedEvents: 0 },
    { day: "2020-06-15", artifacts: 1, uncertainArtifacts: 1, events: 0, estimatedEvents: 0 },
    { day: "2020-07-18", artifacts: 1, uncertainArtifacts: 0, events: 0, estimatedEvents: 0 },
    { day: "2020-11-15", artifacts: 0, uncertainArtifacts: 0, events: 1, estimatedEvents: 1 },
  ]);
  assert.equal(year.undated, 1);
  const month = await get<DayCounts>("/calendar?month=2019-08");
  assert.deepEqual(
    month.days.map((d) => [d.day, d.artifacts, d.events]),
    [
      ["2019-08-03", 1, 1],
      ["2019-08-20", 1, 0],
    ],
  );
  assert.equal(
    (await get<DayCounts>("/calendar?month=2019-08&media=video")).days.filter((d) => d.artifacts)
      .length,
    0,
  );
});

test("the graph counts shared artifacts and events, introductions, and overlapping memberships", async (t) => {
  const { get, sam, lee, kai, a1, a2 } = await world(t);
  const graph = await get<GraphView>("/graph");
  const pair = (x: string, y: string) => (x < y ? [x, y] : [y, x]);
  const edges = (list: { a: string; b: string; count: number }[]) =>
    list.map((e) => `${[e.a, e.b].join("|")}:${e.count}`).sort();
  assert.deepEqual(
    graph.nodes.map((n) => n.knownName),
    ["Kai", "Lee", "Sam"],
  );
  assert.deepEqual(
    edges(graph.artifacts),
    [`${pair(sam.id, lee.id).join("|")}:2`, `${pair(sam.id, kai.id).join("|")}:1`].sort(),
  );
  assert.deepEqual(edges(graph.events), [`${pair(sam.id, lee.id).join("|")}:1`]);
  assert.deepEqual(
    graph.introductions.map((i) => [i.from, i.to, i.day]),
    [[lee.id, sam.id, "2019-08-02"]],
  );
  // Sam and Lee overlapped in the Hangout only. Lee joined Night Owls after Sam had left it.
  // Kai's Hangout membership has no join date, so it is left out.
  assert.deepEqual(edges(graph.memberships), [`${pair(sam.id, lee.id).join("|")}:1`]);

  const filtered = await get<GraphView>(`/graph?fromDay=2020-01-01&toDay=2020-12-31`);
  assert.deepEqual(edges(filtered.artifacts), [`${pair(sam.id, kai.id).join("|")}:1`]);

  // A line's album: artifacts with both characters.
  const album = await get<{ items: { id: string }[] }>(
    `/artifacts?withCharacter=${sam.id}&withCharacter=${lee.id}`,
  );
  assert.deepEqual(album.items.map((i) => i.id).sort(), [a1.id, a2.id].sort());
});
