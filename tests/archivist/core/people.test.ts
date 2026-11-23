import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { createArchive } from "../../../src/archivist/archives.js";
import {
  applyDuplicateReview,
  checkIntake,
  createArtifact,
  duplicateDifferences,
  type IntakeInput,
} from "../../../src/archivist/artifacts.js";
import { createCharacter } from "../../../src/archivist/entities.js";
import { addMember } from "../../../src/archivist/members.js";
import { ArchivistError, type ErrorCode } from "../../../src/archivist/errors.js";
import { createStagingFolder, stageMedia } from "../../../src/archivist/media.js";
import { closeMetadataReader } from "../../../src/archivist/metadata.js";
import { resolvePeople, resolveShortId, suggestPeople } from "../../../src/archivist/people.js";
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
  const { archiveId } = createArchive(context, OWNER, { name: "People" });
  addMember(context, OWNER, { archiveId, userId: MEMBER.userId });
  const store = context.stores.get(archiveId)!;
  const make = (knownName: string) => createCharacter(context, OWNER, { archiveId, knownName }).id;
  const sam = make("Sam");
  const lee = make("Lee");
  const alexOne = make("Alex");
  const alexTwo = make("Alex");
  store.db
    .prepare("INSERT INTO character_aliases (id, character_id, name) VALUES ('a1', ?, 'Sammy')")
    .run(sam);
  return { context, archiveId, db: store.db, sam, lee, alexOne, alexTwo };
}

test("people are resolved by known name or alias, ignoring case", (t) => {
  const { db, sam, lee } = setup(t);
  assert.deepEqual(resolvePeople(db, " sam, LEE "), [sam, lee]);
  assert.deepEqual(resolvePeople(db, "Sammy, Sam"), [sam]);
  assert.deepEqual(resolvePeople(db, ""), []);
});

test("unknown and shared names are refused, and short IDs pick one", (t) => {
  const { db, alexTwo } = setup(t);
  assert.throws(
    () => resolvePeople(db, "Sam, Alicia"),
    (error: unknown) =>
      fails("invalid_input")(error) && (error as ArchivistError).details.name === "Alicia",
  );
  assert.throws(() => resolvePeople(db, "Alex"), fails("invalid_input"));
  assert.deepEqual(resolvePeople(db, `Alex (${alexTwo.slice(0, 8)})`), [alexTwo]);
});

test("suggestions complete the last name and keep the ones already typed", (t) => {
  const { db, alexOne, alexTwo } = setup(t);
  const afterSam = suggestPeople(db, "Sam, le").map((choice) => choice.value);
  assert.equal(afterSam[0], "Sam, Lee");
  assert.equal(afterSam.length, 3);
  const alexes = suggestPeople(db, "ale")
    .map((choice) => choice.value)
    .sort();
  assert.deepEqual(
    alexes,
    [`Alex (${alexOne.slice(0, 8)})`, `Alex (${alexTwo.slice(0, 8)})`].sort(),
  );
  assert.equal(suggestPeople(db, "Sam, sa").length, 0);
});

test("short IDs need eight characters and must be unique", (t) => {
  const { db, sam } = setup(t);
  assert.equal(resolveShortId(db, "characters", sam.slice(0, 8).toUpperCase(), "character"), sam);
  assert.equal(resolveShortId(db, "characters", sam, "character"), sam);
  assert.throws(
    () => resolveShortId(db, "characters", sam.slice(0, 7), "character"),
    fails("invalid_input"),
  );
  assert.throws(
    () => resolveShortId(db, "characters", "ffffffff", "character"),
    fails("not_found"),
  );
});

test("a duplicate review lists only supplied changes and applies only ticked ones", async (t) => {
  const { context, archiveId, sam, lee } = setup(t);
  const file = join(createStagingFolder(context), "original");
  await writeImage(file, "jpeg");
  const media = await stageMedia(context, { file, originalFilename: "a.jpg" });
  const source = { provider: "discord_attachment" as const, key: "123456789012345678" };
  const created = createArtifact(context, MEMBER, {
    archiveId,
    description: "Meetup",
    media,
    source,
    links: { people: [sam] },
  });
  assert.equal(created.status, "created");

  const resubmission: IntakeInput = {
    archiveId,
    description: "Group photo at the meetup",
    source,
    exactDate: "2019-07-15",
    links: { people: [sam, lee] },
  };
  const differences = duplicateDifferences(
    created.artifact,
    checkIntake(context, MEMBER, resubmission),
  );
  assert.deepEqual(
    differences.map((difference) => difference.key),
    ["description", "exactDate", "people"],
  );
  assert.equal(differences[2]!.proposed, lee);

  const applied = applyDuplicateReview(context, MEMBER, {
    intake: resubmission,
    artifactId: created.artifact.id,
    expectedVersion: 1,
    selected: ["people"],
  });
  assert.equal(applied.description, "Meetup");
  assert.equal(applied.dates.exact, null);
  assert.deepEqual(applied.links.people, [sam, lee].sort());

  assert.throws(
    () =>
      applyDuplicateReview(context, MEMBER, {
        intake: resubmission,
        artifactId: created.artifact.id,
        expectedVersion: 1,
        selected: ["description"],
      }),
    fails("stale_version"),
  );
  const nothing = duplicateDifferences(
    applied,
    checkIntake(context, MEMBER, { archiveId, description: "Meetup", source }),
  );
  assert.deepEqual(nothing, []);
});
