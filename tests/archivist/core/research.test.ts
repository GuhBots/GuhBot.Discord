import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { createArchive } from "../../../src/archivist/archives.js";
import {
  createArtifact,
  deleteArtifact,
  updateArtifact,
} from "../../../src/archivist/artifacts.js";
import { flagForResearch, listGapCards, updateGapCard } from "../../../src/archivist/board.js";
import type { ArchivistContext } from "../../../src/archivist/context.js";
import { parseLog } from "../../../src/archivist/edit-log.js";
import {
  createAccount,
  createCharacter,
  createServer,
  deleteEntity,
  updateEntity,
} from "../../../src/archivist/entities.js";
import { ArchivistError, type ErrorCode } from "../../../src/archivist/errors.js";
import {
  assertEventDeletable,
  createEvent,
  deleteEvent,
  getEvent,
  updateEvent,
} from "../../../src/archivist/events.js";
import { createStagingFolder, stageMedia } from "../../../src/archivist/media.js";
import { addMember } from "../../../src/archivist/members.js";
import { closeMetadataReader } from "../../../src/archivist/metadata.js";
import { PALETTE } from "../../../src/archivist/palette.js";
import { setDateOrder } from "../../../src/archivist/preferences.js";
import { createRequest, getRequest, updateRequest } from "../../../src/archivist/requests.js";
import { makeArchivist, MEMBER, OWNER } from "../helpers/context.js";
import { closeFixtureWriter, writeImage } from "../helpers/media.js";

after(async () => {
  await closeMetadataReader();
  await closeFixtureWriter();
});

let sourceCounter = 0;

function fails(code: ErrorCode) {
  return (error: unknown) => error instanceof ArchivistError && error.code === code;
}

function setup(t: TestContext) {
  const archivist = makeArchivist(t);
  const { context } = archivist;
  const { archiveId } = createArchive(context, OWNER, { name: "Research" });
  addMember(context, OWNER, { archiveId, userId: MEMBER.userId });
  const db = () => archivist.context.stores.get(archiveId)!.db;
  const log = () =>
    parseLog(readFileSync(join(context.paths.archivesRoot, archiveId, "edits.log"), "utf8"));
  const sam = createCharacter(context, MEMBER, { archiveId, knownName: "Sam" });
  const lee = createCharacter(context, MEMBER, { archiveId, knownName: "Lee" });
  return { archivist, context, archiveId, db, log, sam, lee };
}

async function artifact(
  context: ArchivistContext,
  archiveId: string,
  options: { dated?: boolean; damaged?: boolean; events?: string[] } = {},
) {
  const file = join(createStagingFolder(context), "original");
  if (options.damaged) {
    writeFileSync(
      file,
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]),
    );
  } else {
    await writeImage(
      file,
      "jpeg",
      options.dated === false ? {} : { "ExifIFD:DateTimeOriginal": "2020:06:15 12:00:00" },
    );
  }
  const media = await stageMedia(context, { file, originalFilename: "photo.jpg" });
  sourceCounter += 1;
  return createArtifact(context, MEMBER, {
    archiveId,
    description: "Evidence",
    media,
    source: { provider: "discord_attachment", key: `7${String(sourceCounter).padStart(17, "0")}` },
    links: { events: options.events ?? [] },
  }).artifact;
}

function cards(context: ArchivistContext, archiveId: string) {
  return listGapCards(context, MEMBER, { archiveId }).map(
    (card) => `${card.kind}:${card.status}:${card.subject.id}`,
  );
}

test("events take a single day, a duration, or an occurrence window", (t) => {
  const { context, archiveId, sam } = setup(t);
  const launch = createEvent(context, MEMBER, {
    archiveId,
    title: "The Hangout opens",
    description: "Sam made the server.",
    dateKind: "single",
    certainty: "exact",
    start: "Aug 3 2019 7pm",
    links: { characters: [sam.id] },
  });
  assert.equal(launch.start.kind, "instant");
  assert.equal(launch.end, null);
  assert.equal(launch.color, PALETTE[0]);

  const season = createEvent(context, MEMBER, {
    archiveId,
    title: "Summer season",
    description: "A shared world all summer.",
    dateKind: "duration",
    certainty: "exact",
    start: "2020-06-01",
    end: "2020-08-31",
  });
  assert.equal(season.color, PALETTE[1]);
  assert.equal(season.end?.archiveDay, "2020-08-31");

  setDateOrder(context, MEMBER, "dmy");
  const meetup = createEvent(context, MEMBER, {
    archiveId,
    title: "First meetup",
    description: "Sometime in spring.",
    dateKind: "occurrence_window",
    certainty: "estimated",
    start: "01/03/2020",
    end: "31/05/2020",
    color: "#C9CDFB",
  });
  assert.equal(meetup.start.archiveDay, "2020-03-01");
  assert.equal(meetup.color, "#c9cdfb");

  const event = (fields: Record<string, unknown>) =>
    createEvent(context, MEMBER, {
      archiveId,
      title: "x",
      description: "y",
      certainty: "exact",
      ...fields,
    } as never);
  assert.throws(
    () => event({ dateKind: "single", start: "2020-01-01", end: "2020-01-02" }),
    fails("invalid_input"),
  );
  assert.throws(() => event({ dateKind: "duration", start: "2020-01-01" }), fails("invalid_input"));
  assert.throws(
    () => event({ dateKind: "duration", start: "2020-01-05", end: "2020-01-01" }),
    fails("invalid_input"),
  );
  // Occurrence windows and estimates are days, so a time is refused.
  assert.throws(
    () => event({ dateKind: "occurrence_window", start: "2020-01-01 6pm", end: "2020-01-02" }),
    fails("invalid_input"),
  );
  assert.throws(
    () => event({ dateKind: "single", start: "2020-01-01", color: "red" }),
    fails("invalid_input"),
  );
  assert.throws(
    () => event({ dateKind: "single", start: "2020-01-01", description: " " }),
    fails("invalid_input"),
  );
});

test("an event without evidence gets a card that clears and reopens with its links", async (t) => {
  const { context, archiveId, log } = setup(t);
  const outage = createEvent(context, MEMBER, {
    archiveId,
    title: "Server outage",
    description: "Down for a day.",
    dateKind: "single",
    certainty: "estimated",
    start: "2021-02-11",
  });
  const party = createEvent(context, MEMBER, {
    archiveId,
    title: "Party",
    description: "Everyone came.",
    dateKind: "single",
    certainty: "exact",
    start: "2020-06-15",
  });
  assert.deepEqual(
    cards(context, archiveId).sort(),
    [`missing_evidence:needed:${outage.id}`, `missing_evidence:needed:${party.id}`].sort(),
  );
  const card = listGapCards(context, MEMBER, { archiveId }).find(
    (c) => c.subject.id === outage.id,
  )!;
  assert.throws(
    () =>
      updateGapCard(context, MEMBER, {
        archiveId,
        id: card.id,
        expectedVersion: 1,
        status: "resolved",
      }),
    fails("invalid_input"),
  );

  // One artifact supports both events.
  const photo = await artifact(context, archiveId, { events: [outage.id, party.id] });
  assert.deepEqual(getEvent(context, MEMBER, { archiveId, id: outage.id }).supportingArtifacts, [
    photo.id,
  ]);
  assert.deepEqual(
    cards(context, archiveId).sort(),
    [`missing_evidence:resolved:${outage.id}`, `missing_evidence:resolved:${party.id}`].sort(),
  );
  updateArtifact(context, MEMBER, {
    archiveId,
    id: photo.id,
    expectedVersion: 1,
    removeLinks: { events: [outage.id] },
  });
  const reopened = listGapCards(context, MEMBER, { archiveId, status: "needed" });
  assert.deepEqual(
    reopened.map((c) => [c.id, c.subject.id]),
    [[card.id, outage.id]],
  );

  const disputed = updateEvent(context, MEMBER, {
    archiveId,
    id: outage.id,
    expectedVersion: 1,
    disputedReason: "Lee says it was in March.",
  });
  assert.equal(disputed.disputedReason, "Lee says it was in March.");
  assert.throws(
    () =>
      updateEvent(context, OWNER, {
        archiveId,
        id: outage.id,
        expectedVersion: 1,
        title: "Outage",
      }),
    fails("stale_version"),
  );
  const cleared = updateEvent(context, MEMBER, {
    archiveId,
    id: outage.id,
    expectedVersion: 2,
    disputedReason: "",
  });
  assert.equal(cleared.disputedReason, null);
  assert.deepEqual(log().at(-1)?.changes, {
    disputedReason: { old: "Lee says it was in March.", new: null },
  });
});

test("missing-media requests take each temporal form, and event anchors follow corrections", (t) => {
  const { context, archiveId, db, sam, lee } = setup(t);
  const season = createEvent(context, MEMBER, {
    archiveId,
    title: "Summer season",
    description: "All summer.",
    dateKind: "duration",
    certainty: "exact",
    start: "2020-06-01",
    end: "2020-08-31",
  });
  const window = createEvent(context, MEMBER, {
    archiveId,
    title: "First meetup",
    description: "Spring.",
    dateKind: "occurrence_window",
    certainty: "estimated",
    start: "2020-03-01",
    end: "2020-05-31",
  });
  const request = (constraint: Record<string, unknown>) =>
    createRequest(context, MEMBER, {
      archiveId,
      description: "Photos",
      characters: [sam.id],
      constraint,
    } as never);

  assert.equal(
    request({ kind: "approximate_day", day: "Dec 5 2020" }).wording,
    "Around Dec 5, 2020",
  );
  const range = request({ kind: "date_range", start: "2020-03-01", end: "2020-03-14" });
  assert.deepEqual(range.window, { from: "2020-03-01", to: "2020-03-14" });
  assert.deepEqual(request({ kind: "before_date", day: "2019-11-15" }).window, {
    before: "2019-11-15",
  });
  const before = request({ kind: "before_event", eventId: season.id.slice(0, 8) });
  assert.equal(before.wording, 'Before "Summer season" (it starts Jun 1, 2020)');
  const afterWindow = request({ kind: "after_event", eventId: window.id });
  // An occurrence window's latest possible day bounds an after-event request.
  assert.deepEqual(afterWindow.window, { after: "2020-05-31" });
  assert.throws(
    () => request({ kind: "date_range", start: "2020-03-14", end: "2020-03-01" }),
    fails("invalid_input"),
  );
  assert.throws(() => request({ kind: "sometime" }), fails("invalid_input"));
  assert.throws(
    () =>
      createRequest(context, MEMBER, {
        archiveId,
        description: "Photos",
        characters: [],
        constraint: { kind: "approximate_day", day: "2020-01-01" },
      }),
    fails("invalid_input"),
  );
  assert.throws(
    () =>
      createRequest(context, MEMBER, {
        archiveId,
        description: " ",
        characters: [lee.id],
        constraint: { kind: "approximate_day", day: "2020-01-01" },
      }),
    fails("invalid_input"),
  );

  updateEvent(context, MEMBER, {
    archiveId,
    id: season.id,
    expectedVersion: 1,
    start: "2020-05-15",
  });
  assert.deepEqual(getRequest(context, MEMBER, { archiveId, id: before.id }).window, {
    before: "2020-05-15",
  });

  assert.throws(
    () => deleteEvent(context, MEMBER, { archiveId, id: season.id, expectedVersion: 2 }),
    (error: unknown) =>
      fails("reference_blocked")(error) &&
      (error as ArchivistError).details.references !== undefined,
  );
  // Discord runs the same check before showing the confirmation button.
  assert.throws(() => assertEventDeletable(db(), season.id), fails("reference_blocked"));
  updateRequest(context, MEMBER, {
    archiveId,
    id: before.id,
    expectedVersion: 1,
    constraint: { kind: "before_date", day: "2020-06-01" },
  });
  deleteEvent(context, MEMBER, { archiveId, id: season.id, expectedVersion: 2 });
});

test("requests move between Needed, Unrecoverable, and Resolved", async (t) => {
  const { context, archiveId, sam, lee, log } = setup(t);
  const request = createRequest(context, MEMBER, {
    archiveId,
    description: "Recording of the birthday stream\nIt ran six hours.",
    characters: [sam.id],
    constraint: { kind: "approximate_day", day: "2020-12-05" },
    researchNotes: "Ask Theo.",
  });
  assert.equal(request.status, "needed");
  assert.equal(request.label, "Recording of the birthday stream");
  const move = (expectedVersion: number, fields: Record<string, unknown>) =>
    updateRequest(context, MEMBER, { archiveId, id: request.id, expectedVersion, ...fields });

  assert.throws(() => move(1, { status: "unrecoverable" }), fails("invalid_input"));
  assert.throws(() => move(1, { status: "resolved" }), fails("invalid_input"));
  assert.throws(() => move(1, { removeCharacters: [sam.id] }), fails("invalid_input"));
  const lost = move(1, {
    status: "unrecoverable",
    unrecoverableReason: "The stream was never saved.",
  });
  assert.equal(lost.status, "unrecoverable");

  const found = await artifact(context, archiveId);
  const resolved = move(2, {
    status: "resolved",
    foundArtifacts: [found.id],
    addCharacters: [lee.id],
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.unrecoverableReason, null);
  assert.deepEqual(resolved.foundArtifacts, [found.id]);
  assert.equal(resolved.wording, "Around Dec 5, 2020");
  assert.throws(
    () => move(3, { status: "unrecoverable", unrecoverableReason: "x" }),
    fails("invalid_input"),
  );
  assert.throws(() => move(2, { priority: "high" }), fails("stale_version"));

  const reopened = move(3, { status: "needed" });
  assert.equal(reopened.status, "needed");
  assert.deepEqual(reopened.foundArtifacts, []);
  assert.equal(reopened.description, request.description);
  assert.deepEqual(log().at(-1)?.changes, {
    status: { old: "resolved", new: "needed" },
    foundArtifacts: { old: [found.id], new: [] },
  });

  // Deleting the only found artifact of a resolved request reopens it.
  move(4, { status: "resolved", foundArtifacts: [found.id] });
  deleteArtifact(context, MEMBER, { archiveId, id: found.id, expectedVersion: 1 });
  assert.equal(getRequest(context, MEMBER, { archiveId, id: request.id }).status, "needed");
});

test("derived cards follow the data, and manual flags need a reason", async (t) => {
  const { archivist, context, archiveId, db, log, sam } = setup(t);
  const undated = await artifact(context, archiveId, { dated: false });
  const damaged = await artifact(context, archiveId, { damaged: true });
  const account = createAccount(context, MEMBER, {
    archiveId,
    kind: "human",
    label: "xX_gamer_Xx",
  });
  createAccount(context, MEMBER, { archiveId, kind: "bot", label: "MusicBot" });
  const dated = await artifact(context, archiveId);
  updateArtifact(context, MEMBER, {
    archiveId,
    id: dated.id,
    expectedVersion: 1,
    unidentifiedCharacters: true,
  });

  // Highest priority first. The test clock is frozen, so equal priorities are compared as a set.
  const listed = listGapCards(context, MEMBER, { archiveId }).map((card) =>
    [card.priority, card.kind, card.subject.id].join(" "),
  );
  assert.deepEqual(
    listed.map((line) => line.split(" ")[0]),
    ["critical", "high", "high", "medium", "medium"],
  );
  assert.deepEqual(
    listed.sort(),
    [
      `critical unreadable_media ${damaged.id}`,
      `high account_character ${account.id}`,
      `high missing_characters ${dated.id}`,
      `medium undated ${damaged.id}`,
      `medium undated ${undated.id}`,
    ].sort(),
  );

  // Filling a gap resolves its card, and a returning gap reopens the same card.
  const linked = updateEntity(context, MEMBER, {
    archiveId,
    kind: "account",
    id: account.id,
    expectedVersion: 1,
    characterId: sam.id,
  });
  const accountCard = () =>
    listGapCards(context, MEMBER, { archiveId }).find((card) => card.kind === "account_character")!;
  assert.equal(accountCard().status, "resolved");
  const cardId = accountCard().id;
  updateEntity(context, MEMBER, {
    archiveId,
    kind: "account",
    id: account.id,
    expectedVersion: linked.version,
    characterId: null,
  });
  assert.equal(accountCard().status, "needed");
  assert.equal(accountCard().id, cardId);
  const lost = updateGapCard(context, MEMBER, {
    archiveId,
    id: cardId,
    expectedVersion: accountCard().version,
    status: "unrecoverable",
    reason: "Nobody remembers who this was.",
  });
  assert.equal(lost.status, "unrecoverable");

  // Manual flags.
  assert.throws(
    () =>
      flagForResearch(context, MEMBER, {
        archiveId,
        kind: "date_research",
        subjectId: dated.id,
        reason: " ",
      }),
    fails("invalid_input"),
  );
  const flag = flagForResearch(context, MEMBER, {
    archiveId,
    kind: "date_research",
    subjectId: dated.id.slice(0, 8),
    reason: "The phone's clock was wrong.",
  });
  assert.equal(flag.field, "date");
  assert.throws(
    () =>
      flagForResearch(context, MEMBER, {
        archiveId,
        kind: "date_research",
        subjectId: dated.id,
        reason: "Again",
      }),
    fails("invalid_input"),
  );
  const custom = flagForResearch(context, MEMBER, {
    archiveId,
    kind: "custom",
    subjectKind: "character",
    subjectId: sam.id,
    field: "location",
    reason: "Where did Sam live in 2020?",
  });
  assert.equal(custom.priority, "low");
  const done = updateGapCard(context, MEMBER, {
    archiveId,
    id: flag.id,
    expectedVersion: 1,
    status: "resolved",
  });
  assert.equal(done.status, "resolved");
  const again = flagForResearch(context, MEMBER, {
    archiveId,
    kind: "date_research",
    subjectId: dated.id,
    reason: "Still wrong.",
  });
  assert.equal(again.id, flag.id);
  assert.equal(again.status, "needed");

  // Deleting a record removes its cards and their log lines.
  deleteArtifact(context, MEMBER, { archiveId, id: dated.id, expectedVersion: 2 });
  assert.equal(
    listGapCards(context, MEMBER, { archiveId }).some((card) => card.subject.id === dated.id),
    false,
  );
  assert.equal(
    log().some((entry) => entry.id === flag.id),
    false,
  );
  deleteEntity(context, MEMBER, { archiveId, kind: "account", id: account.id, expectedVersion: 3 });

  // Archives opened for the first time get their cards, such as ones from before the board.
  db().prepare("DELETE FROM gap_cards").run();
  const restarted = archivist.restart();
  assert.deepEqual(
    cards(restarted, archiveId).sort(),
    [
      `undated:needed:${damaged.id}`,
      `undated:needed:${undated.id}`,
      `unreadable_media:needed:${damaged.id}`,
    ].sort(),
  );
  createServer(restarted, MEMBER, { archiveId, label: "Hangout" });
});
