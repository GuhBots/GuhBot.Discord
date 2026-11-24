import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { createArchive } from "../../../src/archivist/archives.js";
import { createArtifact } from "../../../src/archivist/artifacts.js";
import { createStagingFolder, stageMedia } from "../../../src/archivist/media.js";
import { addMember } from "../../../src/archivist/members.js";
import { closeMetadataReader } from "../../../src/archivist/metadata.js";
import { setDateOrder } from "../../../src/archivist/preferences.js";
import { MEMBER, OTHER, OWNER } from "../helpers/context.js";
import { closeFixtureWriter, writeImage } from "../helpers/media.js";
import { webHarness } from "../helpers/web.js";

after(async () => {
  await closeMetadataReader();
  await closeFixtureWriter();
});

async function setup(t: TestContext) {
  const h = await webHarness(t);
  const { archiveId } = createArchive(h.context, OWNER, { name: "Hangout" });
  addMember(h.context, OWNER, { archiveId, userId: MEMBER.userId });
  const cookie = h.cookie(MEMBER);
  const call = async (
    method: "POST" | "PATCH" | "DELETE" | "GET",
    path: string,
    payload?: unknown,
    who = cookie,
  ) => {
    const response = await h.app.inject({
      method,
      url: `/api/archives/${archiveId}${path}`,
      headers: { origin: h.origin },
      cookies: { archivist_session: who },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: response.statusCode, body: response.body ? response.json() : null };
  };
  return { h, archiveId, call };
}

test("characters are created, edited, given history, merged, and deleted from the website", async (t) => {
  const { h, call } = await setup(t);
  const sam = await call("POST", "/entities/character", {
    knownName: "Sam",
    birthDay: "2001-04-12",
  });
  assert.equal(sam.status, 201);
  assert.equal(sam.body.knownName, "Sam");
  assert.equal(sam.body.version, 1);
  // The archive in the address wins over one in the body.
  const sneaky = await call("POST", "/entities/character", {
    knownName: "Lee",
    archiveId: "someone-else",
  });
  assert.equal(sneaky.status, 201);
  const lee = sneaky.body;

  const edited = await call("PATCH", `/entities/character/${sam.body.id}`, {
    expectedVersion: 1,
    realName: "Samantha Reyes",
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.realName, "Samantha Reyes");
  assert.equal(edited.body.version, 2);
  const stale = await call("PATCH", `/entities/character/${sam.body.id}`, {
    expectedVersion: 1,
    realName: "Sam R",
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "stale_version");
  assert.equal(stale.body.details.currentVersion, 2);

  const alias = await call("POST", `/entities/character/${sam.body.id}/history`, {
    kind: "alias",
    expectedVersion: 2,
    name: "Sammy",
    date: "2020-01-05",
  });
  assert.equal(alias.status, 201);
  assert.deepEqual(
    alias.body.record.history.map((e: { name: string }) => e.name),
    ["Sammy"],
  );
  const removed = await call(
    "DELETE",
    `/entities/character/${sam.body.id}/history/${alias.body.entry.id}?historyKind=alias&expectedVersion=3`,
  );
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.history, []);

  const preview = await call("POST", "/entities/character/merge/preview", {
    survivorId: sam.body.id,
    mergedId: lee.id,
  });
  assert.equal(preview.status, 200);
  assert.deepEqual(
    preview.body.conflicts.map((c: { field: string }) => c.field),
    ["knownName"],
  );
  const missingChoice = await call("POST", "/entities/character/merge", {
    survivorId: sam.body.id,
    survivorVersion: 4,
    mergedId: lee.id,
    mergedVersion: 1,
  });
  assert.equal(missingChoice.status, 400);
  const merged = await call("POST", "/entities/character/merge", {
    survivorId: sam.body.id,
    survivorVersion: 4,
    mergedId: lee.id,
    mergedVersion: 1,
    choices: { knownName: "survivor" },
  });
  assert.equal(merged.status, 200);
  assert.deepEqual(
    merged.body.history.map((e: { kind: string; name: string }) => `${e.kind}:${e.name}`),
    ["alias:Lee"],
  );
  assert.equal((await call("GET", `/entities/character/${lee.id}`)).status, 404);

  const gone = await call("DELETE", `/entities/character/${sam.body.id}?expectedVersion=5`);
  assert.equal(gone.status, 204);
  assert.equal((await call("GET", `/entities/character/${sam.body.id}`)).status, 404);

  // A non-member cannot change anything, and cannot tell the archive exists.
  const outsider = await call(
    "POST",
    "/entities/character",
    { knownName: "Mallory" },
    h.cookie(OTHER),
  );
  assert.equal(outsider.status, 404);
  assert.equal(outsider.body.code, "archive_not_found");
});

test("events, requests, and the board change through the website with the same rules", async (t) => {
  const { h, archiveId, call } = await setup(t);
  // The contributor reads all-number dates day first.
  setDateOrder(h.context, MEMBER, "dmy");
  const sam = (await call("POST", "/entities/character", { knownName: "Sam" })).body;
  const season = await call("POST", "/events", {
    title: "Summer season",
    description: "A shared world",
    dateKind: "duration",
    certainty: "exact",
    start: "01/06/2020",
    end: "31/08/2020",
    links: { characters: [sam.id] },
  });
  assert.equal(season.status, 201, JSON.stringify(season.body));
  assert.equal(season.body.start.calendarDay, "2020-06-01");

  const preview = await call(
    "GET",
    "/date-preview?text=" + encodeURIComponent("03/04/2019 6:30pm"),
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.body.archiveDay, "2019-04-03");
  assert.equal(preview.body.assumedZone, true);

  const photos = await call("POST", "/requests", {
    description: "Photos from the first meetup",
    characters: [sam.id],
    constraint: { kind: "before_event", eventId: season.body.id },
  });
  assert.equal(photos.status, 201);
  assert.match(photos.body.wording, /Before "Summer season"/);
  const blocked = await call("DELETE", `/events/${season.body.id}?expectedVersion=1`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "reference_blocked");

  // Bucket moves have their own route; an edit cannot sneak one in.
  const sneaky = await call("PATCH", `/requests/${photos.body.id}`, {
    expectedVersion: 1,
    status: "unrecoverable",
  });
  assert.equal(sneaky.status, 400);
  const noReason = await call("POST", `/requests/${photos.body.id}/status`, {
    expectedVersion: 1,
    status: "unrecoverable",
  });
  assert.equal(noReason.status, 400);
  const lost = await call("POST", `/requests/${photos.body.id}/status`, {
    expectedVersion: 1,
    status: "unrecoverable",
    unrecoverableReason: "Nobody kept them",
  });
  assert.equal(lost.body.status, "unrecoverable");

  const file = join(createStagingFolder(h.context), "original");
  await writeImage(file, "png");
  const media = await stageMedia(h.context, { file, originalFilename: "a.png" });
  const found = createArtifact(h.context, MEMBER, {
    archiveId,
    description: "The meetup",
    media,
    source: { provider: "discord_attachment", key: "900000000000000001" },
  }).artifact;
  const resolved = await call("POST", `/requests/${photos.body.id}/status`, {
    expectedVersion: 2,
    status: "resolved",
    foundArtifacts: [found.id],
  });
  assert.equal(resolved.body.status, "resolved");
  assert.deepEqual(resolved.body.foundArtifacts, [found.id]);

  // The undated artifact is on the board by itself; a manual flag needs a reason.
  const noFlagReason = await call("POST", "/backlog/flags", {
    kind: "date_research",
    subjectId: found.id,
  });
  assert.equal(noFlagReason.status, 400);
  const flag = await call("POST", "/backlog/flags", {
    kind: "date_research",
    subjectId: found.id,
    reason: "Clock was wrong",
  });
  assert.equal(flag.status, 201);
  const done = await call("PATCH", `/backlog/${flag.body.id}`, {
    expectedVersion: 1,
    status: "resolved",
  });
  assert.equal(done.body.status, "resolved");

  const edited = await call("PATCH", `/artifacts/${found.id}`, {
    expectedVersion: 1,
    description: "The first meetup",
    exactDate: "2019-08-03",
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.dates.selected.basis, "exact");
  assert.equal(
    (await call("DELETE", `/artifacts/${found.id}`, { expectedVersion: 1 })).status,
    409,
  );
  assert.equal(
    (await call("DELETE", `/artifacts/${found.id}`, { expectedVersion: 2 })).status,
    204,
  );
  // Deleting the found artifact sends the request back to Needed.
  assert.equal((await call("GET", `/requests/${photos.body.id}`)).body.status, "needed");
});

test("changes need the website's origin and a JSON object", async (t) => {
  const { h, archiveId, call } = await setup(t);
  const cross = await h.app.inject({
    method: "POST",
    url: `/api/archives/${archiveId}/entities/character`,
    headers: { origin: "https://evil.example" },
    cookies: { archivist_session: h.cookie(MEMBER) },
    payload: { knownName: "Sam" },
  });
  assert.equal(cross.statusCode, 403);
  assert.equal((await call("POST", "/entities/character", [1, 2])).status, 400);
  assert.equal((await call("POST", "/entities/planet", { knownName: "Sam" })).status, 404);
  assert.equal((await call("POST", "/entities/character", { knownName: "" })).status, 400);
});
