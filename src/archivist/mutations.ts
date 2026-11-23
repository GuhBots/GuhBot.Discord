import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, truncateSync } from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import {
  appendDurably,
  formatEntries,
  type LogEntry,
  readLog,
  type RecordRef,
  removeRecordLines,
  syncDirectory,
  writeFileAtomic,
} from "./edit-log.js";
import { ArchivistError } from "./errors.js";
import { insideArchive } from "./paths.js";

/**
 * Archive mutations that keep the database, the edit log, and any bot-database
 * follow-up consistent across crashes.
 *
 * Before changing anything, a mutation writes a journal outside the portable
 * folder. The journal states what the database will look like once the change
 * commits, such as "artifact X is at version 4" or "character Y is gone".
 * The database change then commits in one transaction, the log is updated,
 * and the journal is deleted. If the process stops part-way, recovery reads
 * the journal, checks the database to learn whether the change committed, and
 * then finishes the log update or discards the attempt. Recovery runs before
 * every later write and export, so no half-applied change is ever exported.
 *
 * Mutations run synchronously, so two mutations of one archive never
 * interleave in this single-process bot.
 */

/** An open archive, as the mutation engine needs it. */
export interface ArchiveStore {
  archiveId: string;
  folder: string;
  db: Database.Database;
  /** The pending-mutation journal, kept outside the portable folder. */
  journalFile: string;
}

const VERSIONED_TABLES = {
  archive_meta: "archive_id",
  artifacts: "id",
  accounts: "id",
  channels: "id",
  characters: "id",
  events: "id",
  gap_cards: "id",
  research_requests: "id",
  servers: "id",
} as const;

export type VersionedTable = keyof typeof VERSIONED_TABLES;

/** The state one parent record has once the mutation has committed. */
export type Expectation =
  | { table: VersionedTable; id: string; state: "present" | "absent" }
  | { table: VersionedTable; id: string; version: number };

/** A change to bot-database state that must follow a committed archive change. */
export interface FollowUp {
  kind: string;
  [key: string]: unknown;
}

export interface MutationHooks {
  /** Applies a follow-up. It must be safe to run more than once. */
  applyFollowUp?(followUp: FollowUp): void;
}

export interface Journal {
  format: 1;
  archiveId: string;
  expectations: Expectation[];
  logSizeBefore: number;
  append: LogEntry[];
  removeRecords: RecordRef[];
  /** For removals, the hash of the complete rewritten log. */
  finalLogHash: string | null;
  followUps: FollowUp[];
  /** Files the mutation adds inside the archive folder, removed if it is discarded. */
  newFiles: string[];
}

export interface MutationInput<T> {
  expectations: Expectation[];
  /** Makes the database change. Runs inside one transaction. Throwing cancels the mutation. */
  apply(db: Database.Database): T;
  append?: LogEntry[];
  /** Records whose own log lines are removed, because they were permanently deleted. */
  removeRecords?: RecordRef[];
  followUps?: FollowUp[];
  /** Paths relative to the archive folder that `placeFiles` creates. */
  newFiles?: string[];
  /**
   * Puts new files, such as an original upload, into the archive folder. Runs
   * after the journal is written and before the database change, so a crash
   * in between leaves files that recovery removes rather than orphans.
   */
  placeFiles?(): void;
}

export function logFile(store: ArchiveStore): string {
  return join(store.folder, "edits.log");
}

function rewriteTempFile(store: ArchiveStore): string {
  return `${logFile(store)}.rewrite`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fileSize(file: string): number {
  return existsSync(file) ? statSync(file).size : 0;
}

/** Builds the journal for a mutation from the archive's current log. */
export function planJournal(store: ArchiveStore, input: MutationInput<unknown>): Journal {
  if (input.expectations.length === 0) {
    throw new Error("A mutation needs at least one expectation to make recovery possible.");
  }
  const append = input.append ?? [];
  const removeRecords = input.removeRecords ?? [];
  const logSizeBefore = fileSize(logFile(store));
  let finalLogHash: string | null = null;
  if (removeRecords.length > 0) {
    const current = readLog(logFile(store));
    finalLogHash = sha256(removeRecordLines(current, removeRecords) + formatEntries(append));
  }
  return {
    format: 1,
    archiveId: store.archiveId,
    expectations: input.expectations,
    logSizeBefore,
    append,
    removeRecords,
    finalLogHash,
    followUps: input.followUps ?? [],
    newFiles: (input.newFiles ?? []).map((path) => {
      insideArchive(store.folder, path);
      return path;
    }),
  };
}

export function writeJournal(store: ArchiveStore, journal: Journal): void {
  mkdirSync(dirname(store.journalFile), { recursive: true });
  writeFileAtomic(store.journalFile, JSON.stringify(journal));
}

export function readJournal(store: ArchiveStore): Journal | null {
  if (!existsSync(store.journalFile)) return null;
  return JSON.parse(readFileSync(store.journalFile, "utf8")) as Journal;
}

function deleteJournal(store: ArchiveStore): void {
  rmSync(store.journalFile, { force: true });
  syncDirectory(dirname(store.journalFile));
}

function expectationHolds(db: Database.Database, expectation: Expectation): boolean {
  const idColumn = VERSIONED_TABLES[expectation.table];
  const row = db
    .prepare(`SELECT version FROM ${expectation.table} WHERE ${idColumn} = ?`)
    .get(expectation.id) as { version: number } | undefined;
  if ("version" in expectation) return row?.version === expectation.version;
  return expectation.state === "present" ? row !== undefined : row === undefined;
}

function removeNewFiles(store: ArchiveStore, journal: Journal): void {
  for (const path of journal.newFiles ?? []) {
    rmSync(insideArchive(store.folder, path), { force: true });
  }
}

function needsRepair(store: ArchiveStore, reason: string): ArchivistError {
  return new ArchivistError(
    "dependency_unavailable",
    "This archive has an unfinished change that could not be completed automatically. Ask the bot owner to check the archive.",
    { archiveId: store.archiveId, reason },
  );
}

/**
 * Brings the log to the state the journal describes. Safe to repeat, so a
 * crash during this step is repaired by running it again.
 */
export function completeLog(store: ArchiveStore, journal: Journal): void {
  const file = logFile(store);
  if (journal.finalLogHash === null) {
    // Only appends happened since the journal was written. Cutting back to
    // the recorded size removes a torn line before appending again.
    if (fileSize(file) > journal.logSizeBefore) truncateSync(file, journal.logSizeBefore);
    appendDurably(file, formatEntries(journal.append));
    return;
  }
  const current = readLog(file);
  if (sha256(current) === journal.finalLogHash) return;
  const rewritten =
    removeRecordLines(current, journal.removeRecords) + formatEntries(journal.append);
  if (sha256(rewritten) !== journal.finalLogHash) {
    throw needsRepair(store, "edit_log_changed");
  }
  writeFileAtomic(file, rewritten, rewriteTempFile(store));
}

function finish(store: ArchiveStore, journal: Journal, hooks: MutationHooks): void {
  completeLog(store, journal);
  for (const followUp of journal.followUps) {
    if (!hooks.applyFollowUp) throw needsRepair(store, "missing_follow_up_handler");
    hooks.applyFollowUp(followUp);
  }
  deleteJournal(store);
}

/**
 * Finishes or discards a mutation that an earlier run left unfinished.
 * Returns what it did, for logging.
 */
export function recoverPendingMutation(
  store: ArchiveStore,
  hooks: MutationHooks = {},
): "none" | "completed" | "discarded" {
  const journal = readJournal(store);
  rmSync(rewriteTempFile(store), { force: true });
  if (!journal) return "none";
  if (journal.archiveId !== store.archiveId) throw needsRepair(store, "journal_mismatch");

  const committed = journal.expectations.map((expectation) =>
    expectationHolds(store.db, expectation),
  );
  if (committed.every(Boolean)) {
    finish(store, journal, hooks);
    return "completed";
  }
  if (committed.some(Boolean)) throw needsRepair(store, "partial_expectations");
  if (journal.finalLogHash === null && fileSize(logFile(store)) > journal.logSizeBefore) {
    truncateSync(logFile(store), journal.logSizeBefore);
  }
  removeNewFiles(store, journal);
  deleteJournal(store);
  return "discarded";
}

/**
 * Runs one archive mutation. Any unfinished earlier mutation is completed
 * first. If the database change fails, nothing is changed. If the change
 * commits but the log cannot be written, the error says so and the next
 * mutation or export finishes it.
 */
export function commitMutation<T>(
  store: ArchiveStore,
  input: MutationInput<T>,
  hooks: MutationHooks = {},
): T {
  recoverPendingMutation(store, hooks);
  const journal = planJournal(store, input);
  writeJournal(store, journal);

  let result: T;
  try {
    input.placeFiles?.();
    result = store.db.transaction(() => input.apply(store.db))();
  } catch (error) {
    removeNewFiles(store, journal);
    deleteJournal(store);
    throw error;
  }

  try {
    finish(store, journal, hooks);
  } catch (error) {
    if (error instanceof ArchivistError) throw error;
    throw new ArchivistError(
      "dependency_unavailable",
      "The change was saved, but the edit log could not be updated. It will be finished before the next change.",
      { archiveId: store.archiveId },
    );
  }
  return result;
}
