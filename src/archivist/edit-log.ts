import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Each archive's `edits.log` holds one JSON line per successful edit: when it
 * happened, who made it, the edited record, and the old and new value of each
 * changed field. There are no full-record snapshots and no deletion entries.
 * When a record is deleted, its own lines are removed. Lines about other
 * records stay, even when their values mention the deleted record.
 */

export interface RecordRef {
  /** The record kind, such as `artifact` or `character`. */
  record: string;
  id: string;
}

export interface FieldChange {
  old: unknown;
  new: unknown;
}

export interface LogEntry extends RecordRef {
  /** Zero-offset timestamp of the edit. */
  at: string;
  /** Discord ID of the editor. */
  editor: string;
  changes: Record<string, FieldChange>;
}

export function formatEntries(entries: readonly LogEntry[]): string {
  return entries
    .map((entry) =>
      JSON.stringify({
        at: entry.at,
        editor: entry.editor,
        record: entry.record,
        id: entry.id,
        changes: entry.changes,
      }),
    )
    .map((line) => `${line}\n`)
    .join("");
}

function refKey(ref: RecordRef): string {
  return `${ref.record}\u0000${ref.id}`;
}

/**
 * Returns the log without the lines of the given records. A line that cannot
 * be parsed is kept, so a damaged line is never silently destroyed.
 */
export function removeRecordLines(content: string, records: readonly RecordRef[]): string {
  const removed = new Set(records.map(refKey));
  const lines = content.split("\n");
  const trailing = lines.pop() ?? "";
  const kept = lines.filter((line) => {
    try {
      const entry = JSON.parse(line) as Partial<RecordRef>;
      return !(
        typeof entry.record === "string" &&
        typeof entry.id === "string" &&
        removed.has(refKey({ record: entry.record, id: entry.id }))
      );
    } catch {
      return true;
    }
  });
  return kept.map((line) => `${line}\n`).join("") + trailing;
}

/** Parses the log for reading and download views. Damaged lines are skipped. */
export function parseLog(content: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      // A torn final line from an interrupted append is repaired by recovery.
    }
  }
  return entries;
}

export function readLog(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** Flushes a directory entry, so a rename survives power loss. Unsupported on some platforms. */
export function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch {
    // Windows cannot open directories for syncing. The rename is still atomic there.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Writes a file through a temporary file and a rename, so readers see the old or new content. */
export function writeFileAtomic(file: string, content: string, tempFile = `${file}.tmp`): void {
  const fd = openSync(tempFile, "w");
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempFile, file);
  syncDirectory(dirname(file));
}

/** Appends text and flushes it to disk before returning. */
export function appendDurably(file: string, content: string): void {
  if (!content) return;
  const fd = openSync(file, "a");
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
