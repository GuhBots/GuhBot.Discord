import type Database from "better-sqlite3";
import { archiveDay, type DateValue } from "./dates.js";
import { newId } from "./fields.js";

/**
 * Stores date values as immutable rows. Changing a record's date points it at
 * a new row, and rows nothing refers to any more are removed after each
 * mutation, so an old assertion never changes under another record.
 */

/** A stored date with the day it falls on in the archive's timezone. */
export type StoredDate = DateValue & { id: string; archiveDay: string };

interface DateRow {
  id: string;
  kind: DateValue["kind"];
  original_text: string;
  calendar_day: string | null;
  instant_ms: number | null;
  local_datetime: string | null;
  timezone: string | null;
  archive_day: string;
}

export function insertDate(
  db: Database.Database,
  value: DateValue,
  archiveTimeZone: string,
): string {
  const id = newId();
  db.prepare(
    `INSERT INTO date_values (id, kind, original_text, calendar_day, instant_ms, local_datetime, timezone, archive_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    value.kind,
    value.originalText,
    value.kind === "instant" ? null : value.calendarDay,
    value.kind === "instant" ? value.instantMs : null,
    value.kind === "unknown_local" ? value.localDateTime : null,
    value.kind === "instant" ? value.timezone : null,
    archiveDay(value, archiveTimeZone),
  );
  return id;
}

export function readDate(db: Database.Database, id: string | null): StoredDate | null {
  if (!id) return null;
  const row = db.prepare("SELECT * FROM date_values WHERE id = ?").get(id) as DateRow | undefined;
  if (!row) return null;
  const base = { id: row.id, originalText: row.original_text, archiveDay: row.archive_day };
  if (row.kind === "instant") {
    return { ...base, kind: "instant", instantMs: row.instant_ms!, timezone: row.timezone! };
  }
  if (row.kind === "unknown_local") {
    return {
      ...base,
      kind: "unknown_local",
      calendarDay: row.calendar_day!,
      localDateTime: row.local_datetime!,
    };
  }
  return { ...base, kind: "day", calendarDay: row.calendar_day! };
}

/** Every column that refers to a date row. Keep in sync with the archive schema. */
const DATE_REFERENCES: [table: string, column: string][] = [
  ["character_aliases", "observed_date_id"],
  ["character_main_accounts", "observed_date_id"],
  ["account_ownerships", "start_date_id"],
  ["account_ownerships", "end_date_id"],
  ["account_names", "observed_date_id"],
  ["account_avatars", "observed_date_id"],
  ["server_names", "observed_date_id"],
  ["server_icons", "observed_date_id"],
  ["server_owners", "observed_date_id"],
  ["channel_names", "observed_date_id"],
  ["memberships", "joined_date_id"],
  ["memberships", "left_date_id"],
  ["introductions", "date_id"],
  ["events", "start_date_id"],
  ["events", "end_date_id"],
  ["artifacts", "exact_date_id"],
  ["artifacts", "estimated_date_id"],
  ["artifacts", "file_date_id"],
  ["artifacts", "selected_date_id"],
];

/** Removes date rows that no record refers to. Runs inside a mutation's transaction. */
export function pruneDates(db: Database.Database): number {
  const unused = DATE_REFERENCES.map(
    ([table, column]) => `NOT EXISTS (SELECT 1 FROM ${table} WHERE ${column} = date_values.id)`,
  ).join(" AND ");
  return db.prepare(`DELETE FROM date_values WHERE ${unused}`).run().changes;
}
