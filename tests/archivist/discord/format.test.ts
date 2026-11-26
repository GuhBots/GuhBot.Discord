import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { ArchivistError } from "../../../src/lib/archivist-errors.js";
import type {
  ArtifactDetails,
  EventDetails,
  RequestDetails,
} from "../../../src/lib/archivist-types.js";
import {
  artifactEmbed,
  dateText,
  differenceOption,
  EMBED_DESCRIPTION_LIMIT,
  eventEmbed,
  eventWhen,
  interpretationNote,
  charactersText,
  requestEmbed,
  selectedDateText,
} from "../../../src/lib/archivist-format.js";
import { PENDING_LIFETIME_MS, recall, remember } from "../../../src/lib/archivist-pending.js";

const TORONTO = "America/Toronto";

function artifact(overrides: Partial<ArtifactDetails> = {}): ArtifactDetails {
  return {
    id: "3f9a1c2e-0000-4000-8000-000000000000",
    version: 1,
    createdAt: "2026-11-20T00:00:00.000Z",
    createdBy: "200000000000000002",
    updatedAt: "2026-11-20T00:00:00.000Z",
    description: "Group photo at the meetup",
    source: { provider: "discord_attachment", key: "1", url: null, resourceKey: null },
    submission: { guildId: null, channelId: null, messageId: null },
    media: {
      id: "m1",
      originalFilename: "photo.jpg",
      mimeType: "image/jpeg",
      byteLength: 10,
      sha256: "0".repeat(64),
      hasPreview: true,
      readable: true,
      fileDateStatus: "found",
    },
    dates: { exact: null, estimated: null, file: null, selected: null },
    unidentifiedCharacters: false,
    links: { characters: [], accounts: [], servers: [], channels: [], events: [] },
    ...overrides,
  };
}

const fileDate = {
  id: "d1",
  kind: "unknown_local" as const,
  originalText: "2019:07:15 13:45:00",
  calendarDay: "2019-07-15",
  localDateTime: "2019-07-15T13:45:00",
  archiveDay: "2019-07-15",
};

test("file dates are labeled as unverified and unknown zones are said plainly", () => {
  const dated = artifact({
    dates: {
      exact: null,
      estimated: null,
      file: fileDate,
      selected: { basis: "file", date: fileDate },
    },
  });
  assert.equal(
    selectedDateText(dated, TORONTO),
    "Jul 15, 2019, 13:45 (timezone unknown) (from file metadata, not verified)",
  );
  assert.equal(selectedDateText(artifact(), TORONTO), "Unknown");
  const conflicted = artifact({ media: { ...artifact().media, fileDateStatus: "conflict" } });
  assert.match(selectedDateText(conflicted, TORONTO), /disagree/);
});

test("exact and estimated dates show their basis or reason", () => {
  const exactDate = {
    id: "e",
    kind: "day" as const,
    originalText: "2019-07-14",
    calendarDay: "2019-07-14",
    archiveDay: "2019-07-14",
  };
  const exact = artifact({
    dates: {
      exact: { date: exactDate, basis: "Chat log" },
      estimated: null,
      file: null,
      selected: { basis: "exact", date: exactDate },
    },
  });
  assert.equal(selectedDateText(exact, TORONTO), "Jul 14, 2019 (exact: Chat log)");
  const noBasis = artifact({ dates: { ...exact.dates, exact: { date: exactDate, basis: null } } });
  assert.equal(selectedDateText(noBasis, TORONTO), "Jul 14, 2019 (exact)");
  const estimated = artifact({
    dates: {
      exact: null,
      estimated: { date: exactDate, reason: "Decorations" },
      file: null,
      selected: { basis: "estimated", date: exactDate },
    },
  });
  assert.equal(
    selectedDateText(estimated, TORONTO),
    "around Jul 14, 2019 (estimated: Decorations)",
  );
});

test("instants show in the archive's timezone, and typed times explain how they were read", () => {
  const instant = {
    id: "i",
    kind: "instant" as const,
    originalText: "2019-07-15 08:00",
    instantMs: Date.UTC(2019, 6, 14, 23),
    timezone: "Asia/Tokyo",
    archiveDay: "2019-07-14",
  };
  assert.equal(dateText(instant, TORONTO), "Jul 14, 2019, 19:00 America/Toronto");
  const typed = artifact({
    dates: {
      exact: { date: instant, basis: "Chat" },
      estimated: null,
      file: null,
      selected: { basis: "exact", date: instant },
    },
  });
  assert.equal(
    interpretationNote(typed),
    '"2019-07-15 08:00" was read as Jul 15, 2019, 08:00 Asia/Tokyo.',
  );
  const offset = artifact({
    dates: {
      exact: { date: { ...instant, timezone: "-04:00" }, basis: "Chat" },
      estimated: null,
      file: null,
      selected: null,
    },
  });
  assert.match(interpretationNote(offset) ?? "", /its own offset, -04:00/);
});

test("the characters field notes an unidentified character", () => {
  assert.equal(charactersText([], false), "No characters linked yet");
  assert.equal(charactersText(["Sam"], false), "Sam");
  assert.equal(charactersText([], true), "An unidentified character");
  assert.equal(charactersText(["Sam", "Lee"], true), "Sam, Lee, and an unidentified character");
});

test("long descriptions are shortened only in the embed, with a pointer to the full text", () => {
  const long = artifact({ description: "x".repeat(25_000) });
  const embed = artifactEmbed(long, {
    archiveName: "History",
    archiveTimeZone: TORONTO,
    characterNames: [],
    hasPreviewAttachment: false,
  }).toJSON();
  assert.ok(embed.description!.length <= EMBED_DESCRIPTION_LIMIT);
  assert.match(embed.description!, /artifact show/);
  assert.equal(long.description.length, 25_000);
});

test("embeds name unknown characters and missing previews plainly", () => {
  const embed = artifactEmbed(
    artifact({ media: { ...artifact().media, hasPreview: false, readable: false } }),
    {
      archiveName: "History",
      archiveTimeZone: TORONTO,
      characterNames: [],
      hasPreviewAttachment: false,
      addedBy: "200000000000000002",
    },
  ).toJSON();
  const fields = Object.fromEntries(embed.fields!.map((field) => [field.name, field.value]));
  assert.equal(fields.Characters, "No characters linked yet");
  assert.equal(fields["Added by"], "<@200000000000000002>");
  assert.match(fields.File!, /no preview/);
  assert.equal(embed.title, "History - artifact 3f9a1c2e");
});

test("review options fit Discord's limits", () => {
  const option = differenceOption(
    { key: "description", current: "a".repeat(200), proposed: "b" },
    () => [],
  );
  assert.equal(option.label, "Description");
  assert.ok(option.description.length <= 100);
  const characters = differenceOption(
    { key: "characters", current: "", proposed: "id1,id2" },
    (_, ids) => ids.map((id) => `name-${id}`),
  );
  assert.equal(characters.description, "name-id1, name-id2");
});

test("pending forms belong to one person, are used once, and expire", () => {
  mock.timers.enable({ apis: ["Date"], now: 0 });
  try {
    const token = remember("user-1", { step: 1 });
    assert.throws(
      () => recall(token, "user-2"),
      (error) => error instanceof ArchivistError && error.code === "forbidden",
    );
    assert.deepEqual(recall(token, "user-1", false), { step: 1 });
    assert.deepEqual(recall(token, "user-1"), { step: 1 });
    assert.throws(
      () => recall(token, "user-1"),
      (error) => error instanceof ArchivistError && error.code === "invalid_input",
    );

    const later = remember("user-1", { step: 2 });
    mock.timers.tick(PENDING_LIFETIME_MS + 1);
    assert.throws(
      () => recall(later, "user-1"),
      (error) => error instanceof ArchivistError && error.code === "invalid_input",
    );
  } finally {
    mock.timers.reset();
  }
});

test("events say what their range means, and say when nothing supports them", () => {
  const day = (text: string) => ({
    id: text,
    kind: "day" as const,
    originalText: text,
    calendarDay: text,
    archiveDay: text,
  });
  const event: EventDetails = {
    id: "9b1c2d3e-0000-4000-8000-000000000000",
    version: 1,
    createdAt: "2026-11-20T00:00:00.000Z",
    createdBy: "200000000000000002",
    updatedAt: "2026-11-20T00:00:00.000Z",
    title: "First meetup",
    description: "Sometime in spring.",
    dateKind: "occurrence_window",
    certainty: "estimated",
    start: day("2020-03-01"),
    end: day("2020-05-31"),
    exactBasis: null,
    disputedReason: "Lee says it was June.",
    color: "#eb459e",
    links: { characters: [], servers: [], channels: [] },
    supportingArtifacts: [],
  };
  assert.equal(
    eventWhen(event, TORONTO),
    "Happened sometime between Mar 1, 2020 and May 31, 2020 (estimated)",
  );
  assert.equal(
    eventWhen({ ...event, dateKind: "duration", certainty: "exact" }, TORONTO),
    "Lasted from Mar 1, 2020 to May 31, 2020",
  );
  assert.equal(
    eventWhen({ ...event, dateKind: "single", end: null }, TORONTO),
    "Mar 1, 2020 (estimated)",
  );
  const embed = eventEmbed(event, {
    archiveName: "History",
    archiveTimeZone: TORONTO,
    characterNames: ["Sam"],
    placeNames: [],
  }).toJSON();
  const fields = Object.fromEntries(embed.fields!.map((field) => [field.name, field.value]));
  assert.equal(fields.Evidence, "No supporting artifacts");
  assert.equal(fields.Places, "None linked");
  assert.equal(fields.Disputed, "Lee says it was June.");
  assert.equal(embed.color, 0xeb459e);
});

test("a request shows its bucket and the reason it cannot be found", () => {
  const request: RequestDetails = {
    id: "5d6e7f80-0000-4000-8000-000000000000",
    version: 2,
    createdAt: "2026-11-20T00:00:00.000Z",
    createdBy: "200000000000000002",
    updatedAt: "2026-11-21T00:00:00.000Z",
    description: "Photos from the first meetup",
    label: "Photos from the first meetup",
    constraint: { kind: "before_event", startDay: null, endDay: null, anchorEventId: "e1" },
    window: { before: "2020-06-01" },
    wording: 'Before "Summer season" (it starts Jun 1, 2020)',
    status: "unrecoverable",
    priority: "medium",
    researchNotes: null,
    unrecoverableReason: "Nobody kept them.",
    characters: ["c1"],
    events: [],
  };
  const fields = Object.fromEntries(
    requestEmbed(request, { archiveName: "History", characterNames: ["Sam"], eventNames: [] })
      .toJSON()
      .fields!.map((field) => [field.name, field.value]),
  );
  assert.equal(fields.Status, "Unrecoverable: Nobody kept them.");
});
