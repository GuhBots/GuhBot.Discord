import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openArchiveDatabase } from "../../../src/archivist/archive-database.js";
import { formatEntries, type LogEntry, parseLog } from "../../../src/archivist/edit-log.js";
import { ArchivistError } from "../../../src/archivist/errors.js";
import {
  type ArchiveStore,
  commitMutation,
  type FollowUp,
  logFile,
  type MutationInput,
  planJournal,
  recoverPendingMutation,
  writeJournal,
} from "../../../src/archivist/mutations.js";
import { makeTempDir } from "../helpers/temp-dir.js";

const NOW = "2026-11-23T00:00:00.000Z";
const EDITOR = "707321853198467163";

function openStore(t: TestContext): ArchiveStore {
  const root = makeTempDir(t);
  const db = openArchiveDatabase(join(root, "archive.db"), { create: true });
  t.after(() => db.close());
  return {
    archiveId: "archive-1",
    folder: root,
    db,
    journalFile: join(root, "tmp", "journals", "archive-1.json"),
  };
}

function insertServer(store: ArchiveStore, id: string, label: string): void {
  store.db
    .prepare(
      `INSERT INTO servers (id, created_at, created_by, updated_at, label, color)
       VALUES (?, ?, ?, ?, ?, '#5865f2')`,
    )
    .run(id, NOW, EDITOR, NOW, label);
}

function entry(id: string, field: string, from: unknown, to: unknown): LogEntry {
  return {
    at: NOW,
    editor: EDITOR,
    record: "server",
    id,
    changes: { [field]: { old: from, new: to } },
  };
}

function rename(store: ArchiveStore, id: string, label: string): MutationInput<void> {
  const current = store.db.prepare("SELECT label, version FROM servers WHERE id = ?").get(id) as {
    label: string;
    version: number;
  };
  return {
    expectations: [{ table: "servers", id, version: current.version + 1 }],
    apply(db) {
      db.prepare("UPDATE servers SET label = ?, version = version + 1 WHERE id = ?").run(label, id);
    },
    append: [entry(id, "label", current.label, label)],
  };
}

function remove(id: string): MutationInput<void> {
  return {
    expectations: [{ table: "servers", id, state: "absent" }],
    apply(db) {
      db.prepare("DELETE FROM servers WHERE id = ?").run(id);
    },
    removeRecords: [{ record: "server", id }],
  };
}

/** Runs a mutation up to and including its database commit, then stops as a crash would. */
function crashAfterCommit(store: ArchiveStore, input: MutationInput<void>): void {
  writeJournal(store, planJournal(store, input));
  store.db.transaction(() => input.apply(store.db))();
}

function labelOf(store: ArchiveStore, id: string): unknown {
  return (
    store.db.prepare("SELECT label FROM servers WHERE id = ?").get(id) as
      { label: string } | undefined
  )?.label;
}

function logIds(store: ArchiveStore): string[] {
  return parseLog(readFileSync(logFile(store), "utf8")).map(
    (line) => `${line.id}:${JSON.stringify(line.changes)}`,
  );
}

test("a committed edit updates the database, appends one log line, and clears the journal", (t) => {
  const store = openStore(t);
  insertServer(store, "s1", "Old Name");
  commitMutation(store, rename(store, "s1", "New Name"));

  assert.equal(labelOf(store, "s1"), "New Name");
  assert.deepEqual(parseLog(readFileSync(logFile(store), "utf8")), [
    entry("s1", "label", "Old Name", "New Name"),
  ]);
  assert.equal(existsSync(store.journalFile), false);
});

test("a failed database change leaves the archive and log untouched", (t) => {
  const store = openStore(t);
  insertServer(store, "s1", "Name");
  const input = rename(store, "s1", "Other");
  assert.throws(() =>
    commitMutation(store, {
      ...input,
      apply(db) {
        input.apply(db);
        throw new ArchivistError("stale_version", "Someone else edited this.");
      },
    }),
  );
  assert.equal(labelOf(store, "s1"), "Name");
  assert.equal(existsSync(logFile(store)), false);
  assert.equal(existsSync(store.journalFile), false);
});

test("a crash before the database commit is discarded on recovery", (t) => {
  const store = openStore(t);
  insertServer(store, "s1", "Name");
  writeJournal(store, planJournal(store, rename(store, "s1", "Never Saved")));

  assert.equal(recoverPendingMutation(store), "discarded");
  assert.equal(labelOf(store, "s1"), "Name");
  assert.equal(existsSync(logFile(store)), false);
  assert.equal(existsSync(store.journalFile), false);
});

test("a crash after the database commit writes the missing log line on recovery", (t) => {
  const store = openStore(t);
  insertServer(store, "s1", "Old");
  crashAfterCommit(store, rename(store, "s1", "New"));

  assert.equal(recoverPendingMutation(store), "completed");
  assert.deepEqual(logIds(store), [`s1:{"label":{"old":"Old","new":"New"}}`]);
  assert.equal(existsSync(store.journalFile), false);
});

test("a torn log line from an interrupted append is replaced by the full line", (t) => {
  const store = openStore(t);
  insertServer(store, "s1", "A");
  commitMutation(store, rename(store, "s1", "B"));
  const input = rename(store, "s1", "C");
  crashAfterCommit(store, input);
  appendFileSync(logFile(store), formatEntries(input.append!).slice(0, 25));

  recoverPendingMutation(store);
  assert.deepEqual(logIds(store), [
    `s1:{"label":{"old":"A","new":"B"}}`,
    `s1:{"label":{"old":"B","new":"C"}}`,
  ]);
});

test("the next mutation finishes an interrupted one first, keeping log order", (t) => {
  const store = openStore(t);
  insertServer(store, "s1", "A");
  crashAfterCommit(store, rename(store, "s1", "B"));
  commitMutation(store, rename(store, "s1", "C"));

  assert.deepEqual(logIds(store), [
    `s1:{"label":{"old":"A","new":"B"}}`,
    `s1:{"label":{"old":"B","new":"C"}}`,
  ]);
});

test("deleting a record removes its own log lines and keeps other records' lines", (t) => {
  const store = openStore(t);
  insertServer(store, "s1", "One");
  insertServer(store, "s2", "Two");
  commitMutation(store, rename(store, "s1", "One B"));
  commitMutation(store, rename(store, "s2", "Two B"));
  commitMutation(store, remove("s1"));

  assert.equal(labelOf(store, "s1"), undefined);
  assert.deepEqual(logIds(store), [`s2:{"label":{"old":"Two","new":"Two B"}}`]);
});

for (const point of [
  "before the rewrite",
  "with the rewrite written but not renamed",
  "after the rename",
]) {
  test(`an interrupted deletion ${point} is completed on recovery`, (t) => {
    const store = openStore(t);
    insertServer(store, "s1", "One");
    insertServer(store, "s2", "Two");
    commitMutation(store, rename(store, "s1", "One B"));
    commitMutation(store, rename(store, "s2", "Two B"));
    const input = remove("s1");
    crashAfterCommit(store, input);
    const expected = `${JSON.stringify(parseLog(readFileSync(logFile(store), "utf8"))[1])}\n`;
    if (point === "with the rewrite written but not renamed") {
      writeFileSync(`${logFile(store)}.rewrite`, expected);
    }
    if (point === "after the rename") writeFileSync(logFile(store), expected);

    assert.equal(recoverPendingMutation(store), "completed");
    assert.deepEqual(logIds(store), [`s2:{"label":{"old":"Two","new":"Two B"}}`]);
    assert.equal(existsSync(`${logFile(store)}.rewrite`), false);
    assert.equal(existsSync(store.journalFile), false);
  });
}

test("follow-ups run once the archive change has committed, including on recovery", (t) => {
  const store = openStore(t);
  insertServer(store, "s1", "Old");
  const applied: FollowUp[] = [];
  const hooks = { applyFollowUp: (followUp: FollowUp) => applied.push(followUp) };
  const input = { ...rename(store, "s1", "New"), followUps: [{ kind: "rename", name: "New" }] };
  crashAfterCommit(store, input);

  recoverPendingMutation(store, hooks);
  assert.deepEqual(applied, [{ kind: "rename", name: "New" }]);
});

test("an inconsistent journal stops further writes instead of guessing", (t) => {
  const store = openStore(t);
  insertServer(store, "s1", "Name");
  insertServer(store, "s2", "Name");
  const input: MutationInput<void> = {
    expectations: [
      { table: "servers", id: "s1", state: "absent" },
      { table: "servers", id: "s2", state: "present" },
    ],
    apply() {},
  };
  writeJournal(store, planJournal(store, input));

  assert.throws(
    () => recoverPendingMutation(store),
    (error) => error instanceof ArchivistError && error.code === "dependency_unavailable",
  );
  assert.throws(() => commitMutation(store, rename(store, "s1", "Blocked")));
  assert.equal(labelOf(store, "s1"), "Name");
});
