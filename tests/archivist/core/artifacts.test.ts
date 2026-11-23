import assert from "node:assert/strict";
import { chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { createArchive } from "../../../src/archivist/archives.js";
import {
  type CreateArtifactInput,
  createArtifact,
  deleteArtifact,
  getArtifact,
  updateArtifact,
} from "../../../src/archivist/artifacts.js";
import type { Actor, ArchivistContext } from "../../../src/archivist/context.js";
import { parseLog } from "../../../src/archivist/edit-log.js";
import {
  createAccount,
  createChannel,
  createCharacter,
  createServer,
  deleteEntity,
} from "../../../src/archivist/entities.js";
import { ArchivistError, type ErrorCode } from "../../../src/archivist/errors.js";
import { createStagingFolder, type StagedMedia, stageMedia } from "../../../src/archivist/media.js";
import { addMember } from "../../../src/archivist/members.js";
import { closeMetadataReader } from "../../../src/archivist/metadata.js";
import { setTimeZone } from "../../../src/archivist/preferences.js";
import { makeArchivist, MEMBER, OTHER, OWNER, type TestArchivist } from "../helpers/context.js";
import { closeFixtureWriter, writeImage } from "../helpers/media.js";

after(async () => {
  await closeMetadataReader();
  await closeFixtureWriter();
});

const CAPTURED = { "ExifIFD:DateTimeOriginal": "2019:07:15 13:45:00" };
let attachmentCounter = 0;

function fails(code: ErrorCode) {
  return (error: unknown) => error instanceof ArchivistError && error.code === code;
}

interface Fixture {
  archivist: TestArchivist;
  context: ArchivistContext;
  archiveId: string;
  folder: string;
}

function setup(t: TestContext): Fixture {
  const archivist = makeArchivist(t);
  const archive = createArchive(archivist.context, OWNER, { name: "History" });
  addMember(archivist.context, OWNER, { archiveId: archive.archiveId, userId: MEMBER.userId });
  return {
    archivist,
    context: archivist.context,
    archiveId: archive.archiveId,
    folder: join(archivist.context.paths.archivesRoot, archive.archiveId),
  };
}

async function photo(
  context: ArchivistContext,
  tags: Record<string, string> = CAPTURED,
): Promise<StagedMedia> {
  const file = join(createStagingFolder(context), "original");
  await writeImage(file, "jpeg", tags);
  return stageMedia(context, { file, originalFilename: "photo.jpg" });
}

function attachment(): CreateArtifactInput["source"] {
  attachmentCounter += 1;
  return { provider: "discord_attachment", key: `9${String(attachmentCounter).padStart(17, "0")}` };
}

async function addArtifact(
  fixture: Fixture,
  extra: Partial<CreateArtifactInput> = {},
  actor: Actor = MEMBER,
) {
  const result = createArtifact(fixture.context, actor, {
    archiveId: fixture.archiveId,
    description: "Group photo at the meetup",
    media: await photo(fixture.context),
    source: attachment(),
    ...extra,
  });
  assert.equal(result.status, "created");
  return result.artifact;
}

function log(fixture: Fixture) {
  return parseLog(readFileSync(join(fixture.folder, "edits.log"), "utf8"));
}

function dateRowCount(fixture: Fixture): number {
  const store = fixture.context.stores.get(fixture.archiveId)!;
  return (store.db.prepare("SELECT count(*) AS n FROM date_values").get() as { n: number }).n;
}

test("a new artifact keeps its original and falls back to the file date", async (t) => {
  const fixture = setup(t);
  const artifact = await addArtifact(fixture);

  assert.equal(artifact.version, 1);
  assert.equal(artifact.createdBy, MEMBER.userId);
  assert.equal(artifact.unidentifiedPeople, false);
  assert.equal(artifact.dates.selected?.basis, "file");
  assert.equal(artifact.dates.selected?.date.archiveDay, "2019-07-15");
  assert.equal(artifact.media.readable, true);
  assert.ok(existsSync(join(fixture.folder, "media/originals", `${artifact.media.id}.jpg`)));
  assert.ok(existsSync(join(fixture.folder, "media/previews", `${artifact.media.id}.webp`)));
  const entry = log(fixture).at(-1)!;
  assert.equal(entry.record, "artifact");
  assert.equal(entry.id, artifact.id);
  assert.equal(entry.editor, MEMBER.userId);
  assert.deepEqual(entry.changes.description, { old: null, new: "Group photo at the meetup" });
});

test("exact beats estimated beats file date, and clearing one restores the next", async (t) => {
  const fixture = setup(t);
  const created = await addArtifact(fixture, {
    exactDate: "2019-07-14",
    estimatedDate: { day: "2019-07-01", reason: "Early July by the decorations" },
  });
  assert.equal(created.dates.selected?.basis, "exact");
  assert.equal(created.dates.selected?.date.archiveDay, "2019-07-14");

  const base = { archiveId: fixture.archiveId, id: created.id };
  const noExact = updateArtifact(fixture.context, MEMBER, {
    ...base,
    expectedVersion: 1,
    exactDate: null,
  });
  assert.equal(noExact.dates.selected?.basis, "estimated");
  assert.equal(noExact.dates.estimated?.reason, "Early July by the decorations");
  assert.ok(noExact.dates.file);

  const onlyFile = updateArtifact(fixture.context, MEMBER, {
    ...base,
    expectedVersion: 2,
    estimatedDate: null,
  });
  assert.equal(onlyFile.dates.selected?.basis, "file");
  assert.equal(dateRowCount(fixture), 1);

  const restored = updateArtifact(fixture.context, MEMBER, {
    ...base,
    expectedVersion: 3,
    exactDate: "2019-07-13",
  });
  assert.equal(restored.dates.selected?.basis, "exact");
  assert.equal(restored.version, 4);
});

test("estimates need a reason, and typed times use the contributor's zone", async (t) => {
  const fixture = setup(t);
  const noBasis = await addArtifact(fixture, { exactDate: "2019-07-14" });
  assert.equal(noBasis.dates.selected?.basis, "exact");
  assert.equal(noBasis.dates.exact?.basis, null);
  await assert.rejects(
    addArtifact(fixture, { estimatedDate: { day: "2019-07-14", reason: "" } }),
    fails("invalid_input"),
  );
  await assert.rejects(
    addArtifact(fixture, { estimatedDate: { day: "2019-02-30", reason: "x" } }),
    fails("invalid_input"),
  );
  await assert.rejects(addArtifact(fixture, { description: "   " }), fails("invalid_input"));

  setTimeZone(fixture.context, MEMBER, "Asia/Tokyo");
  const local = await addArtifact(fixture, {
    exactDate: "2019-07-15 08:00",
  });
  const exact = local.dates.exact!.date;
  assert.equal(exact.kind === "instant" && exact.instantMs, Date.UTC(2019, 6, 14, 23));
  assert.equal(exact.kind === "instant" && exact.timezone, "Asia/Tokyo");
  assert.equal(exact.archiveDay, "2019-07-14");

  const explicit = await addArtifact(fixture, {
    exactDate: "2019-07-15 08:00 -04:00",
  });
  assert.equal(explicit.dates.exact!.date.archiveDay, "2019-07-15");
});

test("an artifact with no dates is undated rather than given an invented day", async (t) => {
  const fixture = setup(t);
  const result = createArtifact(fixture.context, MEMBER, {
    archiveId: fixture.archiveId,
    description: "Undated screenshot",
    media: await photo(fixture.context, {}),
    source: attachment(),
  });
  assert.equal(result.artifact.dates.selected, null);
  assert.equal(result.artifact.media.fileDateStatus, "absent");
});

test("the same source is returned for review instead of archived twice", async (t) => {
  const fixture = setup(t);
  const source = attachment();
  const first = await addArtifact(fixture, { source });
  const originalsBefore = readdirSync(join(fixture.folder, "media/originals")).length;
  const linesBefore = log(fixture).length;

  const again = createArtifact(fixture.context, MEMBER, {
    archiveId: fixture.archiveId,
    description: "Different description",
    media: await photo(fixture.context),
    source,
  });
  assert.equal(again.status, "duplicate");
  assert.equal(again.artifact.id, first.id);
  assert.equal(again.artifact.description, "Group photo at the meetup");
  assert.equal(readdirSync(join(fixture.folder, "media/originals")).length, originalsBefore);
  assert.equal(log(fixture).length, linesBefore);
});

test("re-archiving a deleted artifact's source creates a new ID and keeps the old media", async (t) => {
  const fixture = setup(t);
  const source = attachment();
  const first = await addArtifact(fixture, { source });
  deleteArtifact(fixture.context, MEMBER, {
    archiveId: fixture.archiveId,
    id: first.id,
    expectedVersion: 1,
  });
  assert.throws(
    () => getArtifact(fixture.context, MEMBER, { archiveId: fixture.archiveId, id: first.id }),
    fails("not_found"),
  );

  const second = await addArtifact(fixture, { source });
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.media.id, first.media.id);
  assert.ok(existsSync(join(fixture.folder, "media/originals", `${first.media.id}.jpg`)));
  assert.ok(existsSync(join(fixture.folder, "media/previews", `${first.media.id}.webp`)));
});

test("a stale edit is refused with the current values, and identical edits change nothing", async (t) => {
  const fixture = setup(t);
  const artifact = await addArtifact(fixture);
  const base = { archiveId: fixture.archiveId, id: artifact.id };
  updateArtifact(fixture.context, OWNER, {
    ...base,
    expectedVersion: 1,
    description: "Owner's wording",
  });

  assert.throws(
    () =>
      updateArtifact(fixture.context, MEMBER, { ...base, expectedVersion: 1, description: "Mine" }),
    (error: unknown) =>
      fails("stale_version")(error) &&
      (error as ArchivistError).details.currentVersion === 2 &&
      JSON.stringify((error as ArchivistError).details.current) ===
        '{"description":"Owner\'s wording"}',
  );
  const linesBefore = log(fixture).length;
  const same = updateArtifact(fixture.context, MEMBER, {
    ...base,
    expectedVersion: 2,
    description: "Owner's wording",
  });
  assert.equal(same.version, 2);
  assert.equal(log(fixture).length, linesBefore);
});

test("the unidentified-people flag is set and cleared like any other edit", async (t) => {
  const fixture = setup(t);
  const artifact = await addArtifact(fixture);
  const base = { archiveId: fixture.archiveId, id: artifact.id };
  const flagged = updateArtifact(fixture.context, MEMBER, {
    ...base,
    expectedVersion: 1,
    unidentifiedPeople: true,
  });
  assert.equal(flagged.unidentifiedPeople, true);
  assert.deepEqual(log(fixture).at(-1)?.changes, { unidentifiedPeople: { old: false, new: true } });
  assert.throws(
    () =>
      updateArtifact(fixture.context, MEMBER, {
        ...base,
        expectedVersion: 2,
        unidentifiedPeople: "yes",
      }),
    fails("invalid_input"),
  );
  const cleared = updateArtifact(fixture.context, MEMBER, {
    ...base,
    expectedVersion: 2,
    unidentifiedPeople: false,
  });
  assert.equal(cleared.unidentifiedPeople, false);
  assert.equal(cleared.version, 3);
});

test("links must name existing records in the same archive", async (t) => {
  const fixture = setup(t);
  const other = createArchive(fixture.context, OWNER, { name: "Elsewhere" });
  const outsider = createCharacter(fixture.context, OWNER, {
    archiveId: other.archiveId,
    knownName: "Outsider",
  });
  const sam = createCharacter(fixture.context, MEMBER, {
    archiveId: fixture.archiveId,
    knownName: "Sam",
  });
  const lee = createCharacter(fixture.context, MEMBER, {
    archiveId: fixture.archiveId,
    knownName: "Lee",
  });

  await assert.rejects(
    addArtifact(fixture, { links: { people: [sam.id, outsider.id] } }),
    (error: unknown) =>
      fails("invalid_input")(error) &&
      JSON.stringify((error as ArchivistError).details.missing) === JSON.stringify([outsider.id]),
  );
  const artifact = await addArtifact(fixture, { links: { people: [sam.id] } });
  const updated = updateArtifact(fixture.context, MEMBER, {
    archiveId: fixture.archiveId,
    id: artifact.id,
    expectedVersion: 1,
    addLinks: { people: [lee.id] },
    removeLinks: { people: [sam.id] },
  });
  assert.deepEqual(updated.links.people, [lee.id]);
  assert.deepEqual(log(fixture).at(-1)?.changes.people, { old: [sam.id], new: [lee.id] });
});

test("deleting an artifact keeps its media and removes only its own log lines", async (t) => {
  const fixture = setup(t);
  const sam = createCharacter(fixture.context, MEMBER, {
    archiveId: fixture.archiveId,
    knownName: "Sam",
  });
  const kept = await addArtifact(fixture, { links: { people: [sam.id] } });
  const removed = await addArtifact(fixture, {
    links: { people: [sam.id] },
    exactDate: "2019-07-14",
  });
  updateArtifact(fixture.context, MEMBER, {
    archiveId: fixture.archiveId,
    id: removed.id,
    expectedVersion: 1,
    description: "Edited first",
  });
  const datesBefore = dateRowCount(fixture);

  assert.throws(
    () =>
      deleteArtifact(fixture.context, MEMBER, {
        archiveId: fixture.archiveId,
        id: removed.id,
        expectedVersion: 1,
      }),
    fails("stale_version"),
  );
  deleteArtifact(fixture.context, MEMBER, {
    archiveId: fixture.archiveId,
    id: removed.id,
    expectedVersion: 2,
  });

  const ids = log(fixture).map((entry) => entry.id);
  assert.equal(ids.includes(removed.id), false);
  assert.ok(ids.includes(kept.id));
  assert.ok(ids.includes(sam.id));
  assert.ok(existsSync(join(fixture.folder, "media/originals", `${removed.media.id}.jpg`)));
  assert.equal(dateRowCount(fixture), datesBefore - 2);
  assert.deepEqual(
    getArtifact(fixture.context, MEMBER, { archiveId: fixture.archiveId, id: kept.id }).links
      .people,
    [sam.id],
  );
});

test("deleting a resolved request's last found artifact reopens it", async (t) => {
  const fixture = setup(t);
  const artifact = await addArtifact(fixture);
  const store = fixture.context.stores.get(fixture.archiveId)!;
  store.db
    .prepare(
      `INSERT INTO research_requests (id, created_at, created_by, updated_at, description, constraint_kind, start_day, status)
       VALUES ('r1', 'now', ?, 'now', 'The beach trip photos', 'approximate_day', '2019-07-15', 'resolved')`,
    )
    .run(MEMBER.userId);
  store.db
    .prepare("INSERT INTO request_artifacts (request_id, artifact_id) VALUES ('r1', ?)")
    .run(artifact.id);

  deleteArtifact(fixture.context, MEMBER, {
    archiveId: fixture.archiveId,
    id: artifact.id,
    expectedVersion: 1,
  });
  assert.deepEqual(
    store.db.prepare("SELECT status, version, start_day FROM research_requests").get(),
    {
      status: "needed",
      version: 2,
      start_day: "2019-07-15",
    },
  );
  assert.deepEqual(log(fixture).at(-1)?.changes.status, { old: "resolved", new: "needed" });
});

test("linked people, accounts, servers, and channels cannot be deleted until unlinked", async (t) => {
  const fixture = setup(t);
  const archiveId = fixture.archiveId;
  const sam = createCharacter(fixture.context, MEMBER, { archiveId, knownName: "Sam" });
  const server = createServer(fixture.context, MEMBER, { archiveId, label: "Main Hangout" });
  const channel = createChannel(fixture.context, MEMBER, {
    archiveId,
    kind: "guild_channel",
    label: "general",
    serverId: server.id,
  });
  const account = createAccount(fixture.context, MEMBER, {
    archiveId,
    kind: "human",
    label: "sam#1234",
    characterId: sam.id,
  });
  const artifact = await addArtifact(fixture, {
    links: {
      people: [sam.id],
      servers: [server.id],
      channels: [channel.id],
      accounts: [account.id],
    },
  });

  assert.throws(
    () =>
      deleteEntity(fixture.context, MEMBER, {
        archiveId,
        kind: "character",
        id: sam.id,
        expectedVersion: 1,
      }),
    (error: unknown) =>
      fails("reference_blocked")(error) &&
      JSON.stringify((error as ArchivistError).details.references) ===
        '{"artifacts":1,"accounts":1}',
  );
  assert.throws(
    () =>
      deleteEntity(fixture.context, MEMBER, {
        archiveId,
        kind: "server",
        id: server.id,
        expectedVersion: 1,
      }),
    fails("reference_blocked"),
  );
  assert.throws(
    () =>
      deleteEntity(fixture.context, MEMBER, {
        archiveId,
        kind: "channel",
        id: channel.id,
        expectedVersion: 1,
      }),
    fails("reference_blocked"),
  );

  updateArtifact(fixture.context, MEMBER, {
    archiveId,
    id: artifact.id,
    expectedVersion: 1,
    removeLinks: {
      people: [sam.id],
      servers: [server.id],
      channels: [channel.id],
      accounts: [account.id],
    },
  });
  deleteEntity(fixture.context, MEMBER, {
    archiveId,
    kind: "account",
    id: account.id,
    expectedVersion: 1,
  });
  deleteEntity(fixture.context, MEMBER, {
    archiveId,
    kind: "character",
    id: sam.id,
    expectedVersion: 1,
  });
  deleteEntity(fixture.context, MEMBER, {
    archiveId,
    kind: "channel",
    id: channel.id,
    expectedVersion: 1,
  });
  deleteEntity(fixture.context, MEMBER, {
    archiveId,
    kind: "server",
    id: server.id,
    expectedVersion: 1,
  });

  const entries = log(fixture);
  assert.equal(
    entries.some((entry) => entry.id === sam.id),
    false,
  );
  const artifactEntry = entries.findLast(
    (entry) => entry.id === artifact.id && entry.changes.people,
  );
  assert.deepEqual(artifactEntry?.changes.people, { old: [sam.id], new: [] });
  assert.ok(getArtifact(fixture.context, MEMBER, { archiveId, id: artifact.id }));
});

test("entity rules for channels, accounts, Discord IDs, and colors", (t) => {
  const fixture = setup(t);
  const archiveId = fixture.archiveId;
  const first = createServer(fixture.context, MEMBER, {
    archiveId,
    label: "One",
    discordId: "111111111111111111",
  });
  const second = createServer(fixture.context, MEMBER, { archiveId, label: "Two" });
  const store = fixture.context.stores.get(archiveId)!;
  const colors = store.db.prepare("SELECT color FROM servers ORDER BY created_at, rowid").all();
  assert.notDeepEqual(colors[0], colors[1]);

  assert.throws(
    () =>
      createServer(fixture.context, MEMBER, {
        archiveId,
        label: "Copy",
        discordId: "111111111111111111",
      }),
    fails("invalid_input"),
  );
  assert.throws(
    () => createChannel(fixture.context, MEMBER, { archiveId, kind: "guild_channel", label: "x" }),
    fails("invalid_input"),
  );
  assert.throws(
    () =>
      createChannel(fixture.context, MEMBER, {
        archiveId,
        kind: "group_chat",
        label: "x",
        serverId: first.id,
      }),
    fails("invalid_input"),
  );
  const general = createChannel(fixture.context, MEMBER, {
    archiveId,
    kind: "guild_channel",
    label: "general",
    serverId: first.id,
  });
  assert.throws(
    () =>
      createChannel(fixture.context, MEMBER, {
        archiveId,
        kind: "thread",
        label: "t",
        serverId: second.id,
        parentChannelId: general.id,
      }),
    fails("invalid_input"),
  );
  createChannel(fixture.context, MEMBER, {
    archiveId,
    kind: "thread",
    label: "t",
    serverId: first.id,
    parentChannelId: general.id,
  });
  createChannel(fixture.context, MEMBER, { archiveId, kind: "group_chat", label: "the gc" });

  const sam = createCharacter(fixture.context, MEMBER, { archiveId, knownName: "Sam" });
  assert.throws(
    () =>
      createAccount(fixture.context, MEMBER, {
        archiveId,
        kind: "bot",
        label: "Helper",
        characterId: sam.id,
      }),
    fails("invalid_input"),
  );
  assert.throws(
    () =>
      createCharacter(fixture.context, MEMBER, {
        archiveId,
        knownName: "Sam",
        birthDay: "2001-02-30",
      }),
    fails("invalid_input"),
  );
});

test("people outside the archive cannot add or read artifacts", async (t) => {
  const fixture = setup(t);
  const artifact = await addArtifact(fixture);
  await assert.rejects(addArtifact(fixture, {}, OTHER), fails("archive_not_found"));
  assert.throws(
    () => getArtifact(fixture.context, OTHER, { archiveId: fixture.archiveId, id: artifact.id }),
    fails("archive_not_found"),
  );
});

test("artifacts survive a restart", async (t) => {
  const fixture = setup(t);
  const artifact = await addArtifact(fixture, {
    exactDate: "2019-07-14",
  });
  const context = fixture.archivist.restart();
  const reloaded = getArtifact(context, MEMBER, { archiveId: fixture.archiveId, id: artifact.id });
  assert.deepEqual(reloaded, artifact);
});

const canTestPermissions = process.getuid?.() !== 0;

/**
 * Makes the rename that installs a rewritten edit log fail, as if the
 * process stopped right after the database committed a deletion.
 */
function failLogRename(): () => void {
  const writableFs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  const original = writableFs.renameSync;
  writableFs.renameSync = ((from: import("node:fs").PathLike, to: import("node:fs").PathLike) => {
    if (String(to).endsWith("edits.log")) throw new Error("Simulated crash before the log rewrite");
    return original(from, to);
  }) as typeof original;
  syncBuiltinESMExports();
  return () => {
    writableFs.renameSync = original;
    syncBuiltinESMExports();
  };
}

test("an interrupted deletion is completed after a restart", async (t) => {
  const fixture = setup(t);
  const kept = await addArtifact(fixture);
  const removed = await addArtifact(fixture);
  const restore = failLogRename();
  try {
    assert.throws(
      () =>
        deleteArtifact(fixture.context, MEMBER, {
          archiveId: fixture.archiveId,
          id: removed.id,
          expectedVersion: 1,
        }),
      fails("dependency_unavailable"),
    );
  } finally {
    restore();
  }
  assert.ok(log(fixture).some((entry) => entry.id === removed.id));

  const context = fixture.archivist.restart();
  assert.throws(
    () => getArtifact(context, MEMBER, { archiveId: fixture.archiveId, id: removed.id }),
    fails("not_found"),
  );
  const ids = log(fixture).map((entry) => entry.id);
  assert.equal(ids.includes(removed.id), false);
  assert.ok(ids.includes(kept.id));
});

test(
  "an edit whose log line could not be written gets it on the next change",
  { skip: !canTestPermissions },
  async (t) => {
    const fixture = setup(t);
    const artifact = await addArtifact(fixture);
    const logPath = join(fixture.folder, "edits.log");
    chmodSync(logPath, 0o444);
    try {
      assert.throws(
        () =>
          updateArtifact(fixture.context, MEMBER, {
            archiveId: fixture.archiveId,
            id: artifact.id,
            expectedVersion: 1,
            description: "Saved before the log failed",
          }),
        fails("dependency_unavailable"),
      );
    } finally {
      chmodSync(logPath, 0o644);
    }
    updateArtifact(fixture.context, MEMBER, {
      archiveId: fixture.archiveId,
      id: artifact.id,
      expectedVersion: 2,
      description: "Next edit",
    });
    const descriptions = log(fixture)
      .filter((entry) => entry.id === artifact.id && entry.changes.description)
      .map((entry) => entry.changes.description!.new);
    assert.deepEqual(descriptions, [
      "Group photo at the meetup",
      "Saved before the log failed",
      "Next edit",
    ]);
  },
);
