import type Database from "better-sqlite3";
import { requireArchiveAccess, type RegisteredArchive } from "./access.js";
import { archiveDetails, type ArchiveDetails } from "./archives.js";
import { type Actor, type ArchivistContext, openStore } from "./context.js";
import type { FieldChange, LogEntry } from "./edit-log.js";
import { ArchivistError } from "./errors.js";
import { timestamp } from "./fields.js";
import type { ArchiveStore } from "./mutations.js";

/** Helpers shared by the operations on archive records. */

const MAX_IDS = 100;

export interface ArchiveSession {
  archive: RegisteredArchive;
  store: ArchiveStore;
  details: ArchiveDetails;
}

/** Checks the actor can open the archive, then opens it. */
export function openForActor(
  context: ArchivistContext,
  actor: Actor,
  archiveId: unknown,
): ArchiveSession {
  const archive = requireArchiveAccess(context, actor, archiveId);
  const store = openStore(context, archive.archiveId);
  return { archive, store, details: archiveDetails(store) };
}

export function logEntry(
  context: ArchivistContext,
  actor: Actor,
  record: string,
  id: string,
  changes: Record<string, FieldChange>,
): LogEntry {
  return { at: timestamp(context.now()), editor: actor.userId, record, id, changes };
}

/** Reads a list of record IDs, dropping duplicates. */
export function idList(field: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id.trim())) {
    throw new ArchivistError("invalid_input", `${field} must be a list of record IDs.`, { field });
  }
  const ids = [...new Set(value.map((id: string) => id.trim()))];
  if (ids.length > MAX_IDS) {
    throw new ArchivistError("invalid_input", `${field} can list at most ${MAX_IDS} records.`, {
      field,
    });
  }
  return ids;
}

/** Requires every ID to name a record in this archive's table. */
export function requireRecords(
  db: Database.Database,
  table: "characters" | "accounts" | "servers" | "channels" | "events" | "artifacts",
  field: string,
  ids: readonly string[],
): void {
  const exists = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`);
  const missing = ids.filter((id) => !exists.get(id));
  if (missing.length > 0) {
    throw new ArchivistError(
      "invalid_input",
      `${field} lists records that do not exist in this archive. Create them first.`,
      { field, missing },
    );
  }
}

export function notFoundRecord(record: string): ArchivistError {
  return new ArchivistError("not_found", `That ${record} does not exist in this archive.`);
}

/** Records changed fields, comparing values as JSON so lists and objects compare by content. */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
  fields: readonly (keyof T & string)[],
): Record<string, FieldChange> {
  const changes: Record<string, FieldChange> = {};
  for (const field of fields) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      changes[field] = { old: before[field] ?? null, new: after[field] ?? null };
    }
  }
  return changes;
}
