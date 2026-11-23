import type Database from "better-sqlite3";
import type { Actor, ArchivistContext } from "./context.js";
import { archiveDay, type DateValue, parseDateInput, parseDayInput } from "./dates.js";
import { insertDate, pruneDates, readDate, type StoredDate } from "./date-store.js";
import type { FieldChange } from "./edit-log.js";
import { ArchivistError } from "./errors.js";
import { colorValue, newId, optionalText, requiredText, TEXT_LIMITS, timestamp } from "./fields.js";
import { cardsOf, syncGaps } from "./board.js";
import { commitMutation } from "./mutations.js";
import { nextColor } from "./palette.js";
import { resolveShortId } from "./people.js";
import { getDateOrder, inputTimeZone } from "./preferences.js";
import {
  type ArchiveSession,
  diffFields,
  idList,
  logEntry,
  notFoundRecord,
  openForActor,
  requireRecords,
} from "./records.js";
import { expectedVersionValue, staleVersion } from "./versions.js";

/**
 * Events: things that happened, with a title, a description, and a date
 * that is a single day, a duration (it lasted across the range), or an
 * occurrence window (it happened somewhere inside the range). Evidence is
 * optional. Artifacts link to events from the artifact side.
 *
 * Exact dates may be days or times. Estimates and occurrence windows are
 * calendar days, as the plan requires. Neither needs a written basis.
 */

export type EventDateKind = "single" | "duration" | "occurrence_window";
export type Certainty = "exact" | "estimated";

const LINKS = {
  people: { table: "event_people", column: "character_id", target: "characters" },
  servers: { table: "event_servers", column: "server_id", target: "servers" },
  channels: { table: "event_channels", column: "channel_id", target: "channels" },
} as const;
type LinkKind = keyof typeof LINKS;
const LINK_KINDS = Object.keys(LINKS) as LinkKind[];
type Links = Record<LinkKind, string[]>;
export type EventLinkInput = Partial<Record<LinkKind, unknown>>;

export interface EventDetails {
  id: string;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  title: string;
  description: string;
  dateKind: EventDateKind;
  certainty: Certainty;
  start: StoredDate;
  /** Null for single-day events, whose effective end is their start. */
  end: StoredDate | null;
  /** A basis written before exact dates stopped needing one. */
  exactBasis: string | null;
  disputedReason: string | null;
  color: string;
  links: Links;
  /** Artifacts linked as evidence, oldest first. */
  supportingArtifacts: string[];
}

interface EventRow {
  id: string;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  title: string;
  description: string;
  date_kind: EventDateKind;
  certainty: Certainty;
  start_date_id: string;
  end_date_id: string | null;
  exact_basis: string | null;
  disputed_reason: string | null;
  color: string;
}

function readLinks(db: Database.Database, eventId: string): Links {
  const links = {} as Links;
  for (const kind of LINK_KINDS) {
    const { table, column } = LINKS[kind];
    links[kind] = (
      db
        .prepare(`SELECT ${column} AS id FROM ${table} WHERE event_id = ? ORDER BY ${column}`)
        .all(eventId) as { id: string }[]
    ).map((row) => row.id);
  }
  return links;
}

export function readEvent(db: Database.Database, id: string): EventDetails | undefined {
  const row = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as EventRow | undefined;
  if (!row) return undefined;
  const supportingArtifacts = (
    db
      .prepare(
        `SELECT a.id FROM artifact_events ae JOIN artifacts a ON a.id = ae.artifact_id
         LEFT JOIN date_values d ON d.id = a.selected_date_id
         WHERE ae.event_id = ? ORDER BY d.archive_day IS NULL, d.archive_day, a.id`,
      )
      .all(id) as { id: string }[]
  ).map((artifact) => artifact.id);
  return {
    id: row.id,
    version: row.version,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    title: row.title,
    description: row.description,
    dateKind: row.date_kind,
    certainty: row.certainty,
    start: readDate(db, row.start_date_id)!,
    end: readDate(db, row.end_date_id),
    exactBasis: row.exact_basis,
    disputedReason: row.disputed_reason,
    color: row.color,
    links: readLinks(db, row.id),
    supportingArtifacts,
  };
}

/** The earliest and latest days an event covers, in the archive's timezone. */
export function eventSpan(event: Pick<EventDetails, "start" | "end">): {
  first: string;
  last: string;
} {
  return { first: event.start.archiveDay, last: (event.end ?? event.start).archiveDay };
}

function dateKindValue(value: unknown): EventDateKind {
  if (value === "single" || value === "duration" || value === "occurrence_window") return value;
  throw new ArchivistError(
    "invalid_input",
    "The date kind must be single, duration, or occurrence_window.",
    { field: "dateKind" },
  );
}

function certaintyValue(value: unknown): Certainty {
  if (value === "exact" || value === "estimated") return value;
  throw new ArchivistError("invalid_input", "Certainty must be exact or estimated.", {
    field: "certainty",
  });
}

interface DatePair {
  start: DateValue;
  end: DateValue | null;
}

/**
 * Reads an event's dates. Estimates and occurrence windows are calendar
 * days. Ranges need an end on or after the start, and single days have no end.
 */
function datePair(
  session: ArchiveSession,
  context: ArchivistContext,
  actor: Actor,
  kind: EventDateKind,
  certainty: Certainty,
  start: unknown,
  end: unknown,
): DatePair {
  const order = getDateOrder(context, actor);
  const zone = inputTimeZone(context, actor, session.details.timezone);
  const daysOnly = certainty === "estimated" || kind === "occurrence_window";
  const read = (field: string, value: unknown): DateValue => {
    if (daysOnly) {
      const day = parseDayInput(field, value, order);
      return { kind: "day", originalText: String(value).trim(), calendarDay: day };
    }
    return parseDateInput(field, value, zone, order);
  };
  const startValue = read("start", start);
  const hasEnd = end !== undefined && end !== null && end !== "";
  if (kind === "single") {
    if (hasEnd) {
      throw new ArchivistError("invalid_input", "A single-day event has no end date.", {
        field: "end",
      });
    }
    return { start: startValue, end: null };
  }
  if (!hasEnd) {
    throw new ArchivistError("invalid_input", "A range needs an end date.", { field: "end" });
  }
  const endValue = read("end", end);
  const timezone = session.details.timezone;
  const backwards =
    startValue.kind === "instant" && endValue.kind === "instant"
      ? endValue.instantMs < startValue.instantMs
      : archiveDay(endValue, timezone) < archiveDay(startValue, timezone);
  if (backwards) {
    throw new ArchivistError("invalid_input", "The end comes before the start.", { field: "end" });
  }
  return { start: startValue, end: endValue };
}

function linksValue(input: EventLinkInput | undefined, db: Database.Database): Links {
  const links = {} as Links;
  for (const kind of LINK_KINDS) {
    links[kind] = idList(kind, input?.[kind]);
    requireRecords(db, LINKS[kind].target, kind, links[kind]);
  }
  return links;
}

function insertLinks(db: Database.Database, eventId: string, links: Partial<Links>): void {
  for (const kind of LINK_KINDS) {
    const { table, column } = LINKS[kind];
    const insert = db.prepare(`INSERT OR IGNORE INTO ${table} (event_id, ${column}) VALUES (?, ?)`);
    for (const id of links[kind] ?? []) insert.run(eventId, id);
  }
}

/** A date's text with how it was read, so the same text read differently counts as a change. */
function dateState(value: DateValue | StoredDate | null): string | null {
  if (!value) return null;
  const meaning =
    value.kind === "instant"
      ? `${new Date(value.instantMs).toISOString()} (${value.timezone})`
      : value.kind === "day"
        ? value.calendarDay
        : value.localDateTime;
  return `${value.originalText} = ${meaning}`;
}

export interface CreateEventInput {
  archiveId: unknown;
  title: unknown;
  description: unknown;
  dateKind: unknown;
  certainty: unknown;
  start: unknown;
  end?: unknown;
  color?: unknown;
  disputedReason?: unknown;
  links?: EventLinkInput;
}

export function createEvent(
  context: ArchivistContext,
  actor: Actor,
  input: CreateEventInput,
): EventDetails {
  const session = openForActor(context, actor, input.archiveId);
  const { store } = session;
  const title = requiredText("title", input.title, TEXT_LIMITS.eventTitle);
  const description = requiredText("description", input.description, TEXT_LIMITS.description);
  const dateKind = dateKindValue(input.dateKind);
  const certainty = certaintyValue(input.certainty);
  const dates = datePair(session, context, actor, dateKind, certainty, input.start, input.end);
  const color =
    input.color === undefined || input.color === null || input.color === ""
      ? nextColor(store.db, "events")
      : colorValue("color", input.color);
  const disputedReason = optionalText("disputedReason", input.disputedReason, TEXT_LIMITS.reason);
  const links = linksValue(input.links, store.db);
  const id = newId();
  const now = timestamp(context.now());
  const timezone = session.details.timezone;
  const changes: Record<string, FieldChange> = {
    title: { old: null, new: title },
    description: { old: null, new: description },
    dateKind: { old: null, new: dateKind },
    certainty: { old: null, new: certainty },
    start: { old: null, new: dateState(dates.start) },
    color: { old: null, new: color },
  };
  if (dates.end) changes.end = { old: null, new: dateState(dates.end) };
  if (disputedReason) changes.disputedReason = { old: null, new: disputedReason };
  for (const kind of LINK_KINDS) {
    if (links[kind].length > 0) changes[kind] = { old: null, new: links[kind] };
  }
  commitMutation(store, {
    expectations: [{ table: "events", id, state: "present" }],
    apply(db) {
      const startId = insertDate(db, dates.start, timezone);
      const endId = dates.end ? insertDate(db, dates.end, timezone) : null;
      db.prepare(
        `INSERT INTO events (id, created_at, created_by, updated_at, title, description, date_kind, certainty,
           start_date_id, end_date_id, disputed_reason, color)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        now,
        actor.userId,
        now,
        title,
        description,
        dateKind,
        certainty,
        startId,
        endId,
        disputedReason,
        color,
      );
      insertLinks(db, id, links);
      syncGaps(db, now, actor.userId);
    },
    append: [logEntry(context, actor, "event", id, changes)],
  });
  return readEvent(store.db, id)!;
}

export function getEvent(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; id: unknown },
): EventDetails {
  const { store } = openForActor(context, actor, input.archiveId);
  const event = readEvent(store.db, resolveShortId(store.db, "events", input.id, "event"));
  if (!event) throw notFoundRecord("event");
  return event;
}

export interface UpdateEventInput {
  archiveId: unknown;
  id: unknown;
  expectedVersion: unknown;
  title?: unknown;
  description?: unknown;
  /** Changing the kind, certainty, or either date needs the dates restated. */
  dateKind?: unknown;
  certainty?: unknown;
  start?: unknown;
  end?: unknown;
  color?: unknown;
  /** Null or empty clears the disputed mark. */
  disputedReason?: unknown;
  addLinks?: EventLinkInput;
  removeLinks?: EventLinkInput;
}

interface EditableEvent {
  title: string;
  description: string;
  dateKind: EventDateKind;
  certainty: Certainty;
  start: string | null;
  end: string | null;
  color: string;
  disputedReason: string | null;
  people: string[];
  servers: string[];
  channels: string[];
  [key: string]: unknown;
}

const EDITABLE = [
  "title",
  "description",
  "dateKind",
  "certainty",
  "start",
  "end",
  "color",
  "disputedReason",
  ...LINK_KINDS,
] as const;

/**
 * Edits an event the contributor saw at `expectedVersion`. When the dates
 * change, requests anchored to the event follow, because they store the
 * event rather than a copied day.
 */
export function updateEvent(
  context: ArchivistContext,
  actor: Actor,
  input: UpdateEventInput,
): EventDetails {
  const session = openForActor(context, actor, input.archiveId);
  const { store } = session;
  const db = store.db;
  const id = resolveShortId(db, "events", input.id, "event");
  const expectedVersion = expectedVersionValue(input.expectedVersion);
  const current = readEvent(db, id);
  if (!current) throw notFoundRecord("event");
  const before: EditableEvent = {
    title: current.title,
    description: current.description,
    dateKind: current.dateKind,
    certainty: current.certainty,
    start: dateState(current.start),
    end: dateState(current.end),
    color: current.color,
    disputedReason: current.disputedReason,
    ...current.links,
  };
  const after: EditableEvent = { ...before };
  if (input.title !== undefined)
    after.title = requiredText("title", input.title, TEXT_LIMITS.eventTitle);
  if (input.description !== undefined) {
    after.description = requiredText("description", input.description, TEXT_LIMITS.description);
  }
  if (input.color !== undefined) after.color = colorValue("color", input.color);
  if (input.disputedReason !== undefined) {
    after.disputedReason = optionalText("disputedReason", input.disputedReason, TEXT_LIMITS.reason);
  }
  let dates: DatePair | undefined;
  const datesTouched = [input.dateKind, input.certainty, input.start, input.end].some(
    (value) => value !== undefined,
  );
  if (datesTouched) {
    after.dateKind =
      input.dateKind === undefined ? current.dateKind : dateKindValue(input.dateKind);
    after.certainty =
      input.certainty === undefined ? current.certainty : certaintyValue(input.certainty);
    const start = input.start === undefined ? current.start.originalText : input.start;
    const end =
      input.end === undefined
        ? after.dateKind === "single"
          ? null
          : current.end?.originalText
        : input.end;
    dates = datePair(session, context, actor, after.dateKind, after.certainty, start, end);
    after.start = dateState(dates.start);
    after.end = dateState(dates.end);
  }
  const additions = linksValue(input.addLinks, db);
  const removals = {} as Links;
  for (const kind of LINK_KINDS) {
    removals[kind] = idList(kind, input.removeLinks?.[kind]);
    const next = new Set(before[kind]);
    for (const linkId of removals[kind]) next.delete(linkId);
    for (const linkId of additions[kind]) next.add(linkId);
    after[kind] = [...next].sort();
  }

  const changes = diffFields(before, after, EDITABLE);
  if (current.version !== expectedVersion) {
    const attempted = Object.fromEntries(
      Object.keys(changes).map((field) => [field, before[field]]),
    );
    throw staleVersion("event", id, current.version, attempted);
  }
  if (Object.keys(changes).length === 0) return current;
  const now = timestamp(context.now());
  const timezone = session.details.timezone;
  commitMutation(store, {
    expectations: [{ table: "events", id, version: current.version + 1 }],
    apply(target) {
      let startId = current.start.id;
      let endId = current.end?.id ?? null;
      if (dates && (changes.start || changes.end || changes.dateKind || changes.certainty)) {
        startId = insertDate(target, dates.start, timezone);
        endId = dates.end ? insertDate(target, dates.end, timezone) : null;
      }
      target
        .prepare(
          `UPDATE events SET title = ?, description = ?, date_kind = ?, certainty = ?, start_date_id = ?,
             end_date_id = ?, color = ?, disputed_reason = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .run(
          after.title,
          after.description,
          after.dateKind,
          after.certainty,
          startId,
          endId,
          after.color,
          after.disputedReason,
          now,
          id,
          current.version,
        );
      for (const kind of LINK_KINDS) {
        const { table, column } = LINKS[kind];
        const remove = target.prepare(`DELETE FROM ${table} WHERE event_id = ? AND ${column} = ?`);
        for (const linkId of removals[kind]) remove.run(id, linkId);
      }
      insertLinks(target, id, additions);
      pruneDates(target);
      syncGaps(target, now, actor.userId);
    },
    append: [logEntry(context, actor, "event", id, changes)],
  });
  return readEvent(db, id)!;
}

/**
 * Permanently deletes an event. Its links and gap cards go with it, and the
 * artifacts that supported it stay. A missing-media request that uses the
 * event as its date blocks deletion until that request's date is replaced.
 */
export function deleteEvent(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; id: unknown; expectedVersion: unknown },
): void {
  const { store } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  const id = resolveShortId(db, "events", input.id, "event");
  const expectedVersion = expectedVersionValue(input.expectedVersion);
  const row = db.prepare("SELECT version FROM events WHERE id = ?").get(id) as
    { version: number } | undefined;
  if (!row) throw notFoundRecord("event");
  if (row.version !== expectedVersion) throw staleVersion("event", id, row.version, {});
  const anchored = (
    db.prepare("SELECT count(*) AS n FROM research_requests WHERE anchor_event_id = ?").get(id) as {
      n: number;
    }
  ).n;
  if (anchored > 0) {
    throw new ArchivistError(
      "reference_blocked",
      `${anchored} missing-media request${anchored === 1 ? " uses" : "s use"} this event as ${anchored === 1 ? "its" : "their"} date. Give ${anchored === 1 ? "it" : "them"} another date first.`,
      { record: "event", id, references: { "missing-media requests": anchored } },
    );
  }
  const now = timestamp(context.now());
  commitMutation(store, {
    expectations: [{ table: "events", id, state: "absent" }],
    apply(target) {
      target.prepare("DELETE FROM events WHERE id = ?").run(id);
      pruneDates(target);
      syncGaps(target, now, actor.userId);
    },
    removeRecords: [
      { record: "event", id },
      ...cardsOf(db, "event", id).map((card) => ({ record: "gap", id: card })),
    ],
  });
}
