import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createArchive } from "../../../src/archivist/archives.js";
import { parseLog } from "../../../src/archivist/edit-log.js";
import {
  createAccount,
  createChannel,
  createCharacter,
  createServer,
  updateEntity,
} from "../../../src/archivist/entities.js";
import { ArchivistError, type ErrorCode } from "../../../src/archivist/errors.js";
import { addMember } from "../../../src/archivist/members.js";
import { setDateOrder } from "../../../src/archivist/preferences.js";
import { makeArchivist, MEMBER, OTHER, OWNER } from "../helpers/context.js";

function setup(t: TestContext) {
  const { context } = makeArchivist(t);
  const { archiveId } = createArchive(context, OWNER, { name: "Edits" });
  addMember(context, OWNER, { archiveId, userId: MEMBER.userId });
  const log = () =>
    parseLog(readFileSync(join(context.paths.archivesRoot, archiveId, "edits.log"), "utf8"));
  return { context, archiveId, log };
}

function fails(code: ErrorCode) {
  return (error: unknown) => error instanceof ArchivistError && error.code === code;
}

test("a character's own fields are edited with a version and one log entry", (t) => {
  const { context, archiveId, log } = setup(t);
  const sam = createCharacter(context, MEMBER, { archiveId, knownName: "Sam", realName: "Sam R" });
  setDateOrder(context, MEMBER, "dmy");

  const edited = updateEntity(context, MEMBER, {
    archiveId,
    kind: "character",
    id: sam.id.slice(0, 8),
    expectedVersion: 1,
    knownName: "Samantha",
    realName: "",
    birthDay: "12/04/2001",
    metInPerson: "yes",
  });
  assert.equal(edited.version, 2);
  assert.equal(edited.name, "Samantha");
  const fields = Object.fromEntries(edited.fields);
  assert.equal(fields["Real name"], undefined);
  assert.match(fields["Birth day"] ?? "", /^Apr 12, 2001 \(age \d+\)$/);
  assert.deepEqual(log().at(-1)?.changes, {
    knownName: { old: "Sam", new: "Samantha" },
    realName: { old: "Sam R", new: null },
    birthDay: { old: null, new: "2001-04-12" },
    metInPerson: { old: "unknown", new: "yes" },
  });

  const lines = log().length;
  const same = updateEntity(context, MEMBER, {
    archiveId,
    kind: "character",
    id: sam.id,
    expectedVersion: 2,
    knownName: "Samantha",
  });
  assert.equal(same.version, 2);
  assert.equal(log().length, lines);

  assert.throws(
    () =>
      updateEntity(context, OWNER, {
        archiveId,
        kind: "character",
        id: sam.id,
        expectedVersion: 1,
        knownName: "Sammy",
      }),
    (error: unknown) =>
      fails("stale_version")(error) &&
      (error as ArchivistError).details.currentVersion === 2 &&
      JSON.stringify((error as ArchivistError).details.current) === '{"knownName":"Samantha"}',
  );
  assert.throws(
    () =>
      updateEntity(context, MEMBER, {
        archiveId,
        kind: "character",
        id: sam.id,
        expectedVersion: 2,
        knownName: " ",
      }),
    fails("invalid_input"),
  );
});

test("accounts link and unlink characters, and bots never have one", (t) => {
  const { context, archiveId } = setup(t);
  const sam = createCharacter(context, MEMBER, { archiveId, knownName: "Sam" });
  const account = createAccount(context, MEMBER, {
    archiveId,
    kind: "human",
    label: "samwise",
    discordId: "111111111111111111",
  });
  const other = createAccount(context, MEMBER, {
    archiveId,
    kind: "human",
    label: "lee",
    discordId: "222222222222222222",
  });

  const linked = updateEntity(context, MEMBER, {
    archiveId,
    kind: "account",
    id: account.id,
    expectedVersion: 1,
    characterId: sam.id.slice(0, 8),
    discordId: "111111111111111111",
  });
  assert.equal(Object.fromEntries(linked.fields).Character, "Sam");
  assert.equal(linked.version, 2);

  assert.throws(
    () =>
      updateEntity(context, MEMBER, {
        archiveId,
        kind: "account",
        id: account.id,
        expectedVersion: 2,
        subkind: "bot",
      }),
    fails("invalid_input"),
  );
  assert.throws(
    () =>
      updateEntity(context, MEMBER, {
        archiveId,
        kind: "account",
        id: other.id,
        expectedVersion: 1,
        discordId: "111111111111111111",
      }),
    fails("invalid_input"),
  );
  const bot = updateEntity(context, MEMBER, {
    archiveId,
    kind: "account",
    id: account.id,
    expectedVersion: 2,
    characterId: null,
    subkind: "bot",
  });
  assert.equal(Object.fromEntries(bot.fields).Kind, "bot");
});

test("channels move between places only where their kind allows", (t) => {
  const { context, archiveId } = setup(t);
  const hangout = createServer(context, MEMBER, { archiveId, label: "Hangout" });
  const owls = createServer(context, MEMBER, { archiveId, label: "Night Owls" });
  const general = createChannel(context, MEMBER, {
    archiveId,
    kind: "guild_channel",
    label: "general",
    serverId: hangout.id,
  });
  const thread = createChannel(context, MEMBER, {
    archiveId,
    kind: "thread",
    label: "builds",
    serverId: hangout.id,
    parentChannelId: general.id,
  });
  const chat = createChannel(context, MEMBER, {
    archiveId,
    kind: "group_chat",
    label: "Road Trip",
  });
  const edit = (id: string, expectedVersion: number, fields: Record<string, unknown>) =>
    updateEntity(context, MEMBER, { archiveId, kind: "channel", id, expectedVersion, ...fields });

  assert.throws(() => edit(chat.id, 1, { subkind: "guild_channel" }), fails("invalid_input"));
  const moved = edit(chat.id, 1, { subkind: "guild_channel", serverId: owls.id, color: "#EB459E" });
  assert.equal(moved.version, 2);
  assert.equal(Object.fromEntries(moved.fields).Server, "Night Owls");

  // A channel with threads keeps its server until the threads move.
  assert.throws(() => edit(general.id, 1, { serverId: owls.id }), fails("reference_blocked"));
  assert.throws(() => edit(thread.id, 1, { parentChannelId: chat.id }), fails("invalid_input"));
  assert.throws(() => edit(thread.id, 1, { parentChannelId: thread.id }), fails("invalid_input"));
  const relabeled = edit(general.id, 1, { label: "chat", discordId: "" });
  assert.equal(relabeled.name, "chat");
});

test("servers change label and lane color, and outsiders cannot edit", (t) => {
  const { context, archiveId } = setup(t);
  const server = createServer(context, MEMBER, { archiveId, label: "Hangout" });
  const edited = updateEntity(context, MEMBER, {
    archiveId,
    kind: "server",
    id: server.id,
    expectedVersion: 1,
    label: "Hangout 2.0",
    color: "#00A8FC",
  });
  assert.equal(Object.fromEntries(edited.fields)["Lane color"], "#00a8fc");
  assert.throws(
    () =>
      updateEntity(context, MEMBER, {
        archiveId,
        kind: "server",
        id: server.id,
        expectedVersion: 2,
        color: "blue",
      }),
    fails("invalid_input"),
  );
  assert.throws(
    () =>
      updateEntity(context, OTHER, {
        archiveId,
        kind: "server",
        id: server.id,
        expectedVersion: 2,
        label: "Mine",
      }),
    fails("archive_not_found"),
  );
});
