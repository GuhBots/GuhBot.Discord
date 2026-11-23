import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { createArchive } from "../../../src/archivist/archives.js";
import type { ArchivistContext } from "../../../src/archivist/context.js";
import { parseLog } from "../../../src/archivist/edit-log.js";
import {
  createAccount,
  createChannel,
  createCharacter,
  createServer,
  deleteEntity,
  entityBlockers,
} from "../../../src/archivist/entities.js";
import { ArchivistError, type ErrorCode } from "../../../src/archivist/errors.js";
import {
  addHistory,
  characterPictureAt,
  listHistory,
  mainAccountAt,
  nameAt,
  removeHistory,
  serverIconAt,
  setPicture,
} from "../../../src/archivist/history.js";
import { createStagingFolder, stageMedia } from "../../../src/archivist/media.js";
import { addMember } from "../../../src/archivist/members.js";
import { closeMetadataReader } from "../../../src/archivist/metadata.js";
import { setDateOrder } from "../../../src/archivist/preferences.js";
import { makeArchivist, MEMBER, OTHER, OWNER } from "../helpers/context.js";
import { closeFixtureWriter, writeImage, writeMp4 } from "../helpers/media.js";

after(async () => {
  await closeMetadataReader();
  await closeFixtureWriter();
});

function setup(t: TestContext) {
  const { context } = makeArchivist(t);
  const { archiveId } = createArchive(context, OWNER, { name: "History" });
  addMember(context, OWNER, { archiveId, userId: MEMBER.userId });
  const db = context.stores.get(archiveId)!.db;
  const log = () =>
    parseLog(readFileSync(join(context.paths.archivesRoot, archiveId, "edits.log"), "utf8"));
  const version = (table: string, id: string) =>
    (db.prepare(`SELECT version FROM ${table} WHERE id = ?`).get(id) as { version: number })
      .version;
  return { context, archiveId, db, log, version };
}

function fails(code: ErrorCode) {
  return (error: unknown) => error instanceof ArchivistError && error.code === code;
}

async function image(context: ArchivistContext) {
  const file = join(createStagingFolder(context), "original");
  await writeImage(file, "png");
  return stageMedia(context, { file, originalFilename: "avatar.png" });
}

test("aliases are history of the character, with its version and log", (t) => {
  const { context, archiveId, db, log, version } = setup(t);
  const sam = createCharacter(context, MEMBER, { archiveId, knownName: "Sam" });
  setDateOrder(context, MEMBER, "mdy");

  const sammy = addHistory(context, MEMBER, {
    archiveId,
    kind: "alias",
    parentId: sam.id.slice(0, 8),
    expectedVersion: 1,
    name: "Sammy",
    date: "09/01/2019",
  });
  assert.equal(sammy.date?.archiveDay, "2019-09-01");
  assert.equal(version("characters", sam.id), 2);
  assert.deepEqual(log().at(-1), {
    ...log().at(-1),
    record: "character",
    id: sam.id,
    changes: { alias: { old: null, new: { name: "Sammy", date: "09/01/2019" } } },
  });
  addHistory(context, MEMBER, {
    archiveId,
    kind: "alias",
    parentId: sam.id,
    expectedVersion: 2,
    name: "samwise",
  });
  assert.throws(
    () =>
      addHistory(context, MEMBER, {
        archiveId,
        kind: "alias",
        parentId: sam.id,
        expectedVersion: 3,
        name: "samwise",
      }),
    fails("invalid_input"),
  );
  assert.throws(
    () =>
      addHistory(context, MEMBER, {
        archiveId,
        kind: "alias",
        parentId: sam.id,
        expectedVersion: 2,
        name: "Lex",
      }),
    fails("stale_version"),
  );

  removeHistory(context, MEMBER, {
    archiveId,
    kind: "alias",
    parentId: sam.id,
    entryId: sammy.id,
    expectedVersion: 3,
  });
  assert.equal(version("characters", sam.id), 4);
  assert.deepEqual(
    listHistory(db, "character", sam.id).map((entry) => entry.name),
    ["samwise"],
  );
  assert.deepEqual(log().at(-1)?.changes, {
    alias: { old: { name: "Sammy", date: "09/01/2019" }, new: null },
  });
  // The removed alias's date row is gone with it.
  assert.equal((db.prepare("SELECT count(*) AS n FROM date_values").get() as { n: number }).n, 0);
});

test("a main account must be one the character owns or owned", (t) => {
  const { context, archiveId } = setup(t);
  const sam = createCharacter(context, MEMBER, { archiveId, knownName: "Sam" });
  const lee = createCharacter(context, MEMBER, { archiveId, knownName: "Lee" });
  const linked = createAccount(context, MEMBER, {
    archiveId,
    kind: "human",
    label: "samwise",
    characterId: sam.id,
  });
  const old = createAccount(context, MEMBER, { archiveId, kind: "human", label: "sam_old" });
  const bot = createAccount(context, MEMBER, { archiveId, kind: "bot", label: "MusicBot" });
  const main = (accountId: string, expectedVersion: number) =>
    addHistory(context, MEMBER, {
      archiveId,
      kind: "main_account",
      parentId: sam.id,
      expectedVersion,
      targetId: accountId,
    });

  assert.throws(() => main(old.id, 1), fails("invalid_input"));
  assert.throws(() => main(bot.id, 1), fails("invalid_input"));
  main(linked.id, 1);
  addHistory(context, MEMBER, {
    archiveId,
    kind: "ownership",
    parentId: old.id,
    expectedVersion: 1,
    targetId: sam.id,
    start: "2018-01-01",
    end: "2019-01-01",
  });
  main(old.id.slice(0, 8), 2);
  assert.throws(
    () =>
      addHistory(context, MEMBER, {
        archiveId,
        kind: "ownership",
        parentId: old.id,
        expectedVersion: 2,
        targetId: lee.id,
        start: "2019-05-01",
        end: "2019-04-01",
      }),
    fails("invalid_input"),
  );
  assert.throws(
    () =>
      addHistory(context, MEMBER, {
        archiveId,
        kind: "ownership",
        parentId: bot.id,
        expectedVersion: 1,
        targetId: lee.id,
      }),
    fails("invalid_input"),
  );
});

test("a character's picture follows their main account's avatar, then the fallback, then initials", async (t) => {
  const { context, archiveId, db } = setup(t);
  const sam = createCharacter(context, MEMBER, { archiveId, knownName: "Sam" });
  const first = createAccount(context, MEMBER, {
    archiveId,
    kind: "human",
    label: "samwise",
    characterId: sam.id,
  });
  const second = createAccount(context, MEMBER, {
    archiveId,
    kind: "human",
    label: "sam_alt",
    characterId: sam.id,
  });
  assert.deepEqual(characterPictureAt(db, sam.id, "2020-01-01"), { source: "initials" });

  setPicture(context, MEMBER, {
    archiveId,
    kind: "character",
    id: sam.id,
    expectedVersion: 1,
    media: await image(context),
  });
  const fallback = characterPictureAt(db, sam.id, "2020-01-01");
  assert.equal(fallback.source, "fallback");

  addHistory(context, MEMBER, {
    archiveId,
    kind: "main_account",
    parentId: sam.id,
    expectedVersion: 2,
    targetId: first.id,
    date: "2019-08-01",
  });
  addHistory(context, MEMBER, {
    archiveId,
    kind: "main_account",
    parentId: sam.id,
    expectedVersion: 3,
    targetId: second.id,
    date: "2021-01-10",
  });
  const early = addHistory(context, MEMBER, {
    archiveId,
    kind: "avatar",
    parentId: first.id,
    expectedVersion: 1,
    date: "2019-08-01",
    media: await image(context),
  });
  const later = addHistory(context, MEMBER, {
    archiveId,
    kind: "avatar",
    parentId: second.id,
    expectedVersion: 1,
    date: "2021-01-05",
    media: await image(context),
  });

  assert.equal(mainAccountAt(db, sam.id, "2019-07-31"), null);
  assert.deepEqual(characterPictureAt(db, sam.id, "2019-07-31"), fallback);
  assert.deepEqual(characterPictureAt(db, sam.id, "2020-06-01"), {
    source: "avatar",
    accountId: first.id,
    mediaId: early.mediaId,
  });
  assert.deepEqual(characterPictureAt(db, sam.id, "2021-02-01"), {
    source: "avatar",
    accountId: second.id,
    mediaId: later.mediaId,
  });
  // Outside the timeline, the latest known picture is used.
  assert.equal(characterPictureAt(db, sam.id).source, "avatar");

  const clip = join(createStagingFolder(context), "original");
  await writeMp4(clip, Date.UTC(2020, 0, 1));
  const video = await stageMedia(context, { file: clip, originalFilename: "clip.mp4" });
  assert.throws(
    () =>
      addHistory(context, MEMBER, {
        archiveId,
        kind: "avatar",
        parentId: first.id,
        expectedVersion: 2,
        media: video,
      }),
    fails("invalid_input"),
  );
});

test("server and channel names and icons are looked up by day", async (t) => {
  const { context, archiveId, db } = setup(t);
  const server = createServer(context, MEMBER, { archiveId, label: "Hangout 2.0" });
  const add = (kind: string, expectedVersion: number, fields: Record<string, unknown>) =>
    addHistory(context, MEMBER, {
      archiveId,
      kind,
      parentId: server.id,
      expectedVersion,
      ...fields,
    });
  add("server_name", 1, { name: "The Hangout", date: "Aug 3 2019" });
  add("server_name", 2, { name: "Hangout 2.0", date: "Mar 14 2020" });
  add("server_name", 3, { name: "Hangout (unknown date)" });
  const icon = add("server_icon", 4, { date: "2020-09-01", media: await image(context) });

  assert.equal(nameAt(db, "server", server.id, "2019-07-01"), null);
  assert.equal(nameAt(db, "server", server.id, "2019-12-31"), "The Hangout");
  assert.equal(nameAt(db, "server", server.id, "2020-03-14"), "Hangout 2.0");
  assert.equal(nameAt(db, "server", server.id), "Hangout 2.0");
  assert.equal(serverIconAt(db, server.id, "2020-08-31"), null);
  assert.equal(serverIconAt(db, server.id, "2020-09-01"), icon.mediaId);

  const chat = createChannel(context, MEMBER, {
    archiveId,
    kind: "group_chat",
    label: "Road Trip GC",
  });
  addHistory(context, MEMBER, {
    archiveId,
    kind: "channel_name",
    parentId: chat.id,
    expectedVersion: 1,
    name: "Beach Trip",
    date: "2021-05-01",
  });
  assert.equal(nameAt(db, "channel", chat.id, "2021-06-01"), "Beach Trip");
  // Only an undated name exists for the account, so it is used outside the timeline only.
  const account = createAccount(context, MEMBER, { archiveId, kind: "human", label: "lee" });
  addHistory(context, MEMBER, {
    archiveId,
    kind: "account_name",
    parentId: account.id,
    expectedVersion: 1,
    name: "leep",
    discriminator: "0420",
  });
  assert.equal(nameAt(db, "account", account.id), "leep");
  assert.equal(nameAt(db, "account", account.id, "2020-01-01"), null);
  assert.throws(
    () =>
      addHistory(context, MEMBER, {
        archiveId,
        kind: "account_name",
        parentId: account.id,
        expectedVersion: 2,
        name: "x",
        discriminator: "12345",
      }),
    fails("invalid_input"),
  );
});

test("memberships, owners, and introductions link records and block their deletion", (t) => {
  const { context, archiveId, db, log } = setup(t);
  const sam = createCharacter(context, MEMBER, { archiveId, knownName: "Sam" });
  const lee = createCharacter(context, MEMBER, { archiveId, knownName: "Lee" });
  const account = createAccount(context, MEMBER, { archiveId, kind: "human", label: "samwise" });
  const bot = createAccount(context, MEMBER, { archiveId, kind: "bot", label: "MusicBot" });
  const server = createServer(context, MEMBER, { archiveId, label: "Hangout" });

  const membership = addHistory(context, MEMBER, {
    archiveId,
    kind: "membership",
    parentId: account.id,
    expectedVersion: 1,
    targetId: server.id,
    start: "2019-08-03",
  });
  addHistory(context, MEMBER, {
    archiveId,
    kind: "account_name",
    parentId: account.id,
    expectedVersion: 2,
    name: "sam#1234",
    date: "2019-08-01",
  });
  assert.deepEqual(entityBlockers(db, "server", server.id), { "server memberships": 1 });
  assert.deepEqual(entityBlockers(db, "account", account.id), { "server memberships": 1 });

  addHistory(context, MEMBER, {
    archiveId,
    kind: "bot_owner",
    parentId: bot.id,
    expectedVersion: 1,
    targetId: sam.id,
  });
  assert.throws(
    () =>
      addHistory(context, MEMBER, {
        archiveId,
        kind: "bot_owner",
        parentId: bot.id,
        expectedVersion: 2,
        targetId: sam.id,
      }),
    fails("invalid_input"),
  );
  assert.throws(
    () =>
      addHistory(context, MEMBER, {
        archiveId,
        kind: "bot_owner",
        parentId: account.id,
        expectedVersion: 3,
        targetId: sam.id,
      }),
    fails("invalid_input"),
  );
  addHistory(context, MEMBER, {
    archiveId,
    kind: "server_owner",
    parentId: server.id,
    expectedVersion: 1,
    targetId: lee.id,
    date: "2019-08-03",
  });
  addHistory(context, MEMBER, {
    archiveId,
    kind: "introduction",
    parentId: lee.id,
    expectedVersion: 1,
    targetId: sam.id,
  });
  assert.throws(
    () =>
      addHistory(context, MEMBER, {
        archiveId,
        kind: "introduction",
        parentId: lee.id,
        expectedVersion: 2,
        targetId: lee.id,
      }),
    fails("invalid_input"),
  );
  assert.deepEqual(entityBlockers(db, "character", sam.id), {
    "bot owner records": 1,
    introductions: 1,
  });

  // Owned history goes with its parent once the links are gone.
  removeHistory(context, MEMBER, {
    archiveId,
    kind: "membership",
    parentId: account.id,
    entryId: membership.id,
    expectedVersion: 3,
  });
  removeHistory(context, MEMBER, {
    archiveId,
    kind: "bot_owner",
    parentId: bot.id,
    entryId: sam.id,
    expectedVersion: 2,
  });
  deleteEntity(context, MEMBER, { archiveId, kind: "account", id: account.id, expectedVersion: 4 });
  assert.equal((db.prepare("SELECT count(*) AS n FROM account_names").get() as { n: number }).n, 0);
  assert.equal(
    log().some((entry) => entry.id === account.id),
    false,
  );
  assert.throws(
    () =>
      addHistory(context, OTHER, {
        archiveId,
        kind: "alias",
        parentId: sam.id,
        expectedVersion: 1,
        name: "S",
      }),
    fails("archive_not_found"),
  );
});
