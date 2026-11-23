import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { createArchive } from "../../../src/archivist/archives.js";
import { createArtifact } from "../../../src/archivist/artifacts.js";
import { parseLog } from "../../../src/archivist/edit-log.js";
import {
  createAccount,
  createCharacter,
  getEntity,
  updateEntity,
} from "../../../src/archivist/entities.js";
import { ArchivistError, type ErrorCode } from "../../../src/archivist/errors.js";
import { addHistory, listHistory } from "../../../src/archivist/history.js";
import { createStagingFolder, stageMedia } from "../../../src/archivist/media.js";
import { addMember } from "../../../src/archivist/members.js";
import { mergeCharacters, previewMerge } from "../../../src/archivist/merge.js";
import { closeMetadataReader } from "../../../src/archivist/metadata.js";
import { makeArchivist, MEMBER, OWNER } from "../helpers/context.js";
import { closeFixtureWriter, writeImage } from "../helpers/media.js";

after(async () => {
  await closeMetadataReader();
  await closeFixtureWriter();
});

function fails(code: ErrorCode) {
  return (error: unknown) => error instanceof ArchivistError && error.code === code;
}

function setup(t: TestContext) {
  const { context } = makeArchivist(t);
  const { archiveId } = createArchive(context, OWNER, { name: "Merge" });
  addMember(context, OWNER, { archiveId, userId: MEMBER.userId });
  const db = context.stores.get(archiveId)!.db;
  const log = () =>
    parseLog(readFileSync(join(context.paths.archivesRoot, archiveId, "edits.log"), "utf8"));
  return { context, archiveId, db, log };
}

test("a merge is reviewed, then moves every link to the surviving character", async (t) => {
  const { context, archiveId, db, log } = setup(t);
  const sam = createCharacter(context, MEMBER, {
    archiveId,
    knownName: "Sam",
    birthDay: "2001-04-12",
  });
  const samantha = createCharacter(context, MEMBER, {
    archiveId,
    knownName: "Samantha",
    realName: "Samantha Reyes",
    birthDay: "2001-04-13",
    metInPerson: "yes",
  });
  const lee = createCharacter(context, MEMBER, { archiveId, knownName: "Lee" });
  addHistory(context, MEMBER, {
    archiveId,
    kind: "alias",
    parentId: samantha.id,
    expectedVersion: 1,
    name: "Sammy",
  });
  const account = createAccount(context, MEMBER, {
    archiveId,
    kind: "human",
    label: "samwise",
    characterId: samantha.id,
  });
  addHistory(context, MEMBER, {
    archiveId,
    kind: "introduction",
    parentId: samantha.id,
    expectedVersion: 2,
    targetId: sam.id,
  });
  addHistory(context, MEMBER, {
    archiveId,
    kind: "introduction",
    parentId: lee.id,
    expectedVersion: 1,
    targetId: samantha.id,
  });
  const file = join(createStagingFolder(context), "original");
  await writeImage(file, "png");
  const shared = createArtifact(context, MEMBER, {
    archiveId,
    description: "Both records tagged",
    media: await stageMedia(context, { file, originalFilename: "a.png" }),
    source: { provider: "discord_attachment", key: "600000000000000001" },
    links: { people: [sam.id, samantha.id] },
  }).artifact;

  const preview = previewMerge(context, MEMBER, {
    archiveId,
    survivorId: sam.id,
    mergedId: samantha.id.slice(0, 8),
  });
  assert.deepEqual(
    preview.conflicts.map((conflict) => conflict.field),
    ["knownName", "birthDay"],
  );
  assert.deepEqual(preview.moves, {
    artifacts: 1,
    accounts: 1,
    "introductions made": 1,
    "introductions received": 1,
    aliases: 1,
  });

  const merge = (choices: Record<string, string>, survivorVersion = 1, mergedVersion = 3) =>
    mergeCharacters(context, MEMBER, {
      archiveId,
      survivorId: sam.id,
      survivorVersion,
      mergedId: samantha.id,
      mergedVersion,
      choices,
    } as never);
  assert.throws(() => merge({ knownName: "survivor" }), fails("invalid_input"));
  assert.throws(
    () => merge({ knownName: "survivor", birthDay: "merged" }, 1, 1),
    fails("stale_version"),
  );
  assert.throws(
    () => previewMerge(context, MEMBER, { archiveId, survivorId: sam.id, mergedId: sam.id }),
    fails("invalid_input"),
  );

  const result = merge({ knownName: "survivor", birthDay: "merged" });
  assert.equal(result.knownName, "Sam");
  assert.equal(result.version, 2);
  const fields = Object.fromEntries(
    getEntity(context, MEMBER, { archiveId, kind: "character", id: sam.id }).fields,
  );
  assert.equal(fields["Real name"], "Samantha Reyes");
  assert.match(fields["Birth day"] ?? "", /^Apr 13, 2001/);
  assert.equal(fields["Met in person"], "yes");
  assert.equal(fields.Accounts, "samwise");
  assert.deepEqual(
    listHistory(db, "character", sam.id)
      .filter((entry) => entry.kind === "alias")
      .map((entry) => entry.name)
      .sort(),
    ["Samantha", "Sammy"],
  );
  // The shared artifact keeps one link, and the introduction between the two is gone.
  assert.deepEqual(
    db
      .prepare("SELECT character_id AS id FROM artifact_people WHERE artifact_id = ?")
      .all(shared.id),
    [{ id: sam.id }],
  );
  assert.deepEqual(
    db.prepare("SELECT introducer_id AS a, introduced_id AS b FROM introductions").all(),
    [{ a: sam.id, b: lee.id }],
  );
  assert.equal(db.prepare("SELECT 1 FROM characters WHERE id = ?").get(samantha.id), undefined);
  assert.equal(
    log().some((entry) => entry.id === samantha.id),
    false,
  );
  assert.deepEqual(log().at(-1)?.changes.merged, { old: null, new: `Samantha (${samantha.id})` });

  // The moved account can be edited under its new character.
  updateEntity(context, MEMBER, {
    archiveId,
    kind: "account",
    id: account.id,
    expectedVersion: 1,
    label: "samwise_",
  });
});
