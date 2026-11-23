import assert from "node:assert/strict";
import { test } from "node:test";
import { createArchive } from "../../../src/archivist/archives.js";
import {
  ageOn,
  createAccount,
  createCharacter,
  createServer,
  deleteEntity,
  getEntity,
} from "../../../src/archivist/entities.js";
import { foldText, searchEntities } from "../../../src/archivist/search.js";
import { makeArchivist, OWNER } from "../helpers/context.js";

test("search folds case and Unicode forms", () => {
  assert.equal(foldText("Ｚoë"), foldText("ZOË"));
  assert.equal(foldText("Straße"), "strasse");
});

test("entities are found by name, alias, Discord ID, or ID prefix", (t) => {
  const { context } = makeArchivist(t);
  const { archiveId } = createArchive(context, OWNER, { name: "Search" });
  const db = context.stores.get(archiveId)!.db;
  const zoe = createCharacter(context, OWNER, { archiveId, knownName: "Zoë" });
  createCharacter(context, OWNER, { archiveId, knownName: "Sam" });
  db.prepare(
    "INSERT INTO character_aliases (id, character_id, name) VALUES ('a', ?, 'Lightning')",
  ).run(zoe.id);
  const server = createServer(context, OWNER, {
    archiveId,
    label: "Main Hangout",
    discordId: "111111111111111111",
  });

  assert.deepEqual(
    searchEntities(db, "character", "ZOE").map((hit) => hit.id),
    [],
  );
  assert.deepEqual(
    searchEntities(db, "character", "ZOË").map((hit) => hit.id),
    [zoe.id],
  );
  assert.deepEqual(
    searchEntities(db, "character", "light").map((hit) => hit.id),
    [zoe.id],
  );
  assert.deepEqual(
    searchEntities(db, "character", zoe.id.slice(0, 6)).map((hit) => hit.id),
    [zoe.id],
  );
  assert.equal(searchEntities(db, "character", "").length, 2);
  assert.deepEqual(
    searchEntities(db, "server", "hangout").map((hit) => hit.id),
    [server.id],
  );
  assert.deepEqual(
    searchEntities(db, "server", "111111111111111111").map((hit) => hit.id),
    [server.id],
  );
});

test("entity details derive age and name linked records", (t) => {
  const { context } = makeArchivist(t);
  const { archiveId } = createArchive(context, OWNER, { name: "Details" });
  const sam = createCharacter(context, OWNER, {
    archiveId,
    knownName: "Sam",
    birthDay: "2000-11-24",
    metInPerson: "yes",
  });
  const account = createAccount(context, OWNER, {
    archiveId,
    kind: "human",
    label: "sam#1234",
    characterId: sam.id,
  });

  const character = getEntity(context, OWNER, {
    archiveId,
    kind: "character",
    id: sam.id.slice(0, 8),
  });
  const fields = Object.fromEntries(character.fields);
  assert.equal(fields["Birth day"], "2000-11-24 (age 25)");
  assert.equal(fields.Accounts, "sam#1234");
  assert.equal(fields["Met in person"], "yes");
  assert.equal(ageOn("2000-11-23", new Date("2026-11-23T12:00:00Z")), 26);

  const accountDetails = getEntity(context, OWNER, { archiveId, kind: "account", id: account.id });
  assert.equal(Object.fromEntries(accountDetails.fields).Character, "Sam");

  deleteEntity(context, OWNER, {
    archiveId,
    kind: "account",
    id: account.id.slice(0, 8),
    expectedVersion: 1,
  });
  assert.throws(() => getEntity(context, OWNER, { archiveId, kind: "account", id: account.id }));
});
