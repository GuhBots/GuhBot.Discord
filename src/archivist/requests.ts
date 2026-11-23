import type Database from "better-sqlite3";
import type { Priority } from "./board.js";
import type { Actor, ArchivistContext } from "./context.js";
import { dayText, parseDayInput } from "./dates.js";
import type { FieldChange } from "./edit-log.js";
import { ArchivistError } from "./errors.js";
import { newId, optionalText, requiredText, TEXT_LIMITS, timestamp } from "./fields.js";
import { eventSpan, readEvent } from "./events.js";
import { commitMutation } from "./mutations.js";
import { resolveShortId } from "./people.js";
import { getDateOrder } from "./preferences.js";
import {
  diffFields,
  idList,
  logEntry,
  notFoundRecord,
  openForActor,
  requireRecords,
} from "./records.js";
import { expectedVersionValue, staleVersion } from "./versions.js";

/**
 * Missing-media requests: something the archive should have but nobody has
 * found yet. A request needs a description, at least one person, and one
 * temporal constraint. Requests start Needed, may move to Unrecoverable with
 * a reason, and are Resolved by linking the artifact that has it. There are
 * no assignees.
 *
 * A request anchored to an event stores the event, not a copied day, so it
 * follows corrections to the event's dates, and the event cannot be deleted
 * while the request uses it. No day is invented to place an open-ended
 * request on the timeline.
 */

export type ConstraintKind =
  "approximate_day" | "date_range" | "before_date" | "before_event" | "after_event";
export type RequestStatus = "needed" | "resolved" | "unrecoverable";

export interface ConstraintInput {
  kind: unknown;
  /** Approximate day and before-date constraints. */
  day?: unknown;
  /** Range constraints. */
  start?: unknown;
  end?: unknown;
  /** Before-event and after-event constraints. */
  eventId?: unknown;
}

interface Constraint {
  kind: ConstraintKind;
  startDay: string | null;
  endDay: string | null;
  anchorEventId: string | null;
}

/**
 * When the missing media is from, as open or closed bounds. `after` and
 * `before` are exclusive, `from` and `to` inclusive, and `around` is an
 * approximate day. Event anchors use the event's current dates.
 */
export interface RequestWindow {
  around?: string;
  from?: string;
  to?: string;
  after?: string;
  before?: string;
}

export interface RequestDetails {
  id: string;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  description: string;
  /** A short label derived from the description, since requests have no title. */
  label: string;
  constraint: Constraint;
  window: RequestWindow;
  /** The constraint in words, such as `Before "Summer season" (it starts Jun 1, 2020)`. */
  wording: string;
  status: RequestStatus;
  priority: Priority;
  researchNotes: string | null;
  unrecoverableReason: string | null;
  people: string[];
  events: string[];
  foundArtifacts: string[];
}

interface RequestRow {
  id: string;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  description: string;
  constraint_kind: ConstraintKind;
  start_day: string | null;
  end_day: string | null;
  anchor_event_id: string | null;
  status: RequestStatus;
  priority: Priority;
  research_notes: string | null;
  unrecoverable_reason: string | null;
}

const LINKS = {
  people: { table: "request_people", column: "character_id", target: "characters" },
  events: { table: "request_events", column: "event_id", target: "events" },
  foundArtifacts: { table: "request_artifacts", column: "artifact_id", target: "artifacts" },
} as const;
type LinkKind = keyof typeof LINKS;

function linkIds(db: Database.Database, kind: LinkKind, requestId: string): string[] {
  const { table, column } = LINKS[kind];
  return (
    db
      .prepare(`SELECT ${column} AS id FROM ${table} WHERE request_id = ? ORDER BY ${column}`)
      .all(requestId) as {
      id: string;
    }[]
  ).map((row) => row.id);
}

/** A one-line label from a description. */
export function requestLabel(description: string): string {
  const line = description.trim().split("\n")[0]!.trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function windowAndWording(
  db: Database.Database,
  constraint: Constraint,
): { window: RequestWindow; wording: string } {
  switch (constraint.kind) {
    case "approximate_day":
      return {
        window: { around: constraint.startDay! },
        wording: `Around ${dayText(constraint.startDay!)}`,
      };
    case "date_range":
      return {
        window: { from: constraint.startDay!, to: constraint.endDay! },
        wording: `Between ${dayText(constraint.startDay!)} and ${dayText(constraint.endDay!)}`,
      };
    case "before_date":
      return {
        window: { before: constraint.startDay! },
        wording: `Before ${dayText(constraint.startDay!)}`,
      };
    default: {
      const event = readEvent(db, constraint.anchorEventId!)!;
      const span = eventSpan(event);
      // An occurrence window's earliest and latest possible days are its start and end.
      return constraint.kind === "before_event"
        ? {
            window: { before: span.first },
            wording: `Before "${event.title}" (it starts ${dayText(span.first)})`,
          }
        : {
            window: { after: span.last },
            wording: `After "${event.title}" (it ${event.end ? "ends" : "was on"} ${dayText(span.last)})`,
          };
    }
  }
}

export function readRequest(db: Database.Database, id: string): RequestDetails | undefined {
  const row = db.prepare("SELECT * FROM research_requests WHERE id = ?").get(id) as
    RequestRow | undefined;
  if (!row) return undefined;
  const constraint: Constraint = {
    kind: row.constraint_kind,
    startDay: row.start_day,
    endDay: row.end_day,
    anchorEventId: row.anchor_event_id,
  };
  return {
    id: row.id,
    version: row.version,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    description: row.description,
    label: requestLabel(row.description),
    constraint,
    ...windowAndWording(db, constraint),
    status: row.status,
    priority: row.priority,
    researchNotes: row.research_notes,
    unrecoverableReason: row.unrecoverable_reason,
    people: linkIds(db, "people", row.id),
    events: linkIds(db, "events", row.id),
    foundArtifacts: linkIds(db, "foundArtifacts", row.id),
  };
}

const KINDS: ConstraintKind[] = [
  "approximate_day",
  "date_range",
  "before_date",
  "before_event",
  "after_event",
];

function constraintValue(
  context: ArchivistContext,
  actor: Actor,
  db: Database.Database,
  input: ConstraintInput | undefined,
): Constraint {
  const kind = input?.kind;
  if (!KINDS.includes(kind as ConstraintKind)) {
    throw new ArchivistError(
      "invalid_input",
      "Say when it is from: around a day, between two days, before a day, or before or after an event.",
      { field: "constraint" },
    );
  }
  const order = getDateOrder(context, actor);
  switch (kind as ConstraintKind) {
    case "approximate_day":
      return {
        kind: "approximate_day",
        startDay: parseDayInput("day", input!.day, order),
        endDay: null,
        anchorEventId: null,
      };
    case "before_date":
      return {
        kind: "before_date",
        startDay: parseDayInput("day", input!.day, order),
        endDay: null,
        anchorEventId: null,
      };
    case "date_range": {
      const startDay = parseDayInput("start", input!.start, order);
      const endDay = parseDayInput("end", input!.end, order);
      if (endDay < startDay) {
        throw new ArchivistError("invalid_input", "The end comes before the start.", {
          field: "end",
        });
      }
      return { kind: "date_range", startDay, endDay, anchorEventId: null };
    }
    default:
      return {
        kind: kind as ConstraintKind,
        startDay: null,
        endDay: null,
        anchorEventId: resolveShortId(db, "events", input!.eventId, "event"),
      };
  }
}

function priorityValue(value: unknown): Priority {
  if (value === "critical" || value === "high" || value === "medium" || value === "low")
    return value;
  throw new ArchivistError("invalid_input", "Priority must be critical, high, medium, or low.", {
    field: "priority",
  });
}

function constraintState(db: Database.Database, constraint: Constraint): string {
  return windowAndWording(db, constraint).wording;
}

export interface CreateRequestInput {
  archiveId: unknown;
  description: unknown;
  people: unknown;
  constraint: ConstraintInput;
  events?: unknown;
  researchNotes?: unknown;
  priority?: unknown;
}

export function createRequest(
  context: ArchivistContext,
  actor: Actor,
  input: CreateRequestInput,
): RequestDetails {
  const { store } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  const description = requiredText("description", input.description, TEXT_LIMITS.description);
  const people = idList("people", input.people);
  if (people.length === 0) {
    throw new ArchivistError(
      "invalid_input",
      "Name at least one person the missing media involves.",
      {
        field: "people",
      },
    );
  }
  requireRecords(db, "characters", "people", people);
  const events = idList("events", input.events);
  requireRecords(db, "events", "events", events);
  const constraint = constraintValue(context, actor, db, input.constraint);
  const researchNotes = optionalText("researchNotes", input.researchNotes, TEXT_LIMITS.description);
  const priority = input.priority === undefined ? "medium" : priorityValue(input.priority);
  const id = newId();
  const now = timestamp(context.now());
  const changes: Record<string, FieldChange> = {
    description: { old: null, new: description },
    when: { old: null, new: constraintState(db, constraint) },
    people: { old: null, new: people },
    priority: { old: null, new: priority },
  };
  if (events.length) changes.events = { old: null, new: events };
  if (researchNotes) changes.researchNotes = { old: null, new: researchNotes };
  commitMutation(store, {
    expectations: [{ table: "research_requests", id, state: "present" }],
    apply(target) {
      target
        .prepare(
          `INSERT INTO research_requests (id, created_at, created_by, updated_at, description, constraint_kind,
             start_day, end_day, anchor_event_id, priority, research_notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          now,
          actor.userId,
          now,
          description,
          constraint.kind,
          constraint.startDay,
          constraint.endDay,
          constraint.anchorEventId,
          priority,
          researchNotes,
        );
      const addPerson = target.prepare(
        "INSERT INTO request_people (request_id, character_id) VALUES (?, ?)",
      );
      for (const person of people) addPerson.run(id, person);
      const addEvent = target.prepare(
        "INSERT INTO request_events (request_id, event_id) VALUES (?, ?)",
      );
      for (const event of events) addEvent.run(id, event);
      // The plan asks for this check inside the transaction, before commit.
      if (linkIds(target, "people", id).length === 0) throw new Error("A request needs a person.");
    },
    append: [logEntry(context, actor, "request", id, changes)],
  });
  return readRequest(db, id)!;
}

export function getRequest(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; id: unknown },
): RequestDetails {
  const { store } = openForActor(context, actor, input.archiveId);
  const request = readRequest(
    store.db,
    resolveShortId(store.db, "research_requests", input.id, "request"),
  );
  if (!request) throw notFoundRecord("request");
  return request;
}

/** Requests in one bucket or all, highest priority first, then oldest. */
export function listRequests(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; status?: RequestStatus },
): RequestDetails[] {
  const { store } = openForActor(context, actor, input.archiveId);
  const ids = store.db
    .prepare(
      `SELECT id FROM research_requests WHERE (@status IS NULL OR status = @status)
       ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at, id`,
    )
    .all({ status: input.status ?? null }) as { id: string }[];
  return ids.map(({ id }) => readRequest(store.db, id)!);
}

export interface UpdateRequestInput {
  archiveId: unknown;
  id: unknown;
  expectedVersion: unknown;
  description?: unknown;
  constraint?: ConstraintInput;
  researchNotes?: unknown;
  priority?: unknown;
  addPeople?: unknown;
  removePeople?: unknown;
  addEvents?: unknown;
  removeEvents?: unknown;
  /** Bucket moves. Resolved needs found artifacts, Unrecoverable a reason. */
  status?: unknown;
  foundArtifacts?: unknown;
  unrecoverableReason?: unknown;
}

interface EditableRequest {
  description: string;
  when: string;
  constraint: Constraint;
  researchNotes: string | null;
  priority: Priority;
  people: string[];
  events: string[];
  status: RequestStatus;
  foundArtifacts: string[];
  unrecoverableReason: string | null;
  [key: string]: unknown;
}

const LOGGED = [
  "description",
  "when",
  "researchNotes",
  "priority",
  "people",
  "events",
  "status",
  "foundArtifacts",
  "unrecoverableReason",
] as const;

/**
 * Edits a request or moves it between buckets. Resolving links at least one
 * artifact, also from Unrecoverable. Unrecoverable needs a reason. Reopening
 * returns it to Needed and drops the found links, keeping its description
 * and date as they were.
 */
export function updateRequest(
  context: ArchivistContext,
  actor: Actor,
  input: UpdateRequestInput,
): RequestDetails {
  const { store } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  const id = resolveShortId(db, "research_requests", input.id, "request");
  const expectedVersion = expectedVersionValue(input.expectedVersion);
  const current = readRequest(db, id);
  if (!current) throw notFoundRecord("request");
  const before: EditableRequest = {
    description: current.description,
    when: current.wording,
    constraint: current.constraint,
    researchNotes: current.researchNotes,
    priority: current.priority,
    people: current.people,
    events: current.events,
    status: current.status,
    foundArtifacts: current.foundArtifacts,
    unrecoverableReason: current.unrecoverableReason,
  };
  const after: EditableRequest = { ...before };
  if (input.description !== undefined) {
    after.description = requiredText("description", input.description, TEXT_LIMITS.description);
  }
  if (input.constraint !== undefined) {
    after.constraint = constraintValue(context, actor, db, input.constraint);
    after.when = constraintState(db, after.constraint);
  }
  if (input.researchNotes !== undefined) {
    after.researchNotes = optionalText(
      "researchNotes",
      input.researchNotes,
      TEXT_LIMITS.description,
    );
  }
  if (input.priority !== undefined) after.priority = priorityValue(input.priority);
  const edit = (
    field: "people" | "events",
    add: unknown,
    remove: unknown,
    table: "characters" | "events",
  ) => {
    const additions = idList(field, add);
    requireRecords(db, table, field, additions);
    const next = new Set(before[field]);
    for (const value of idList(field, remove)) next.delete(value);
    for (const value of additions) next.add(value);
    after[field] = [...next].sort();
  };
  edit("people", input.addPeople, input.removePeople, "characters");
  edit("events", input.addEvents, input.removeEvents, "events");
  if (after.people.length === 0) {
    throw new ArchivistError("invalid_input", "A request needs at least one person.", {
      field: "people",
    });
  }

  if (input.status !== undefined) {
    const status = input.status;
    if (status === "resolved") {
      const found = idList("foundArtifacts", input.foundArtifacts);
      requireRecords(db, "artifacts", "foundArtifacts", found);
      after.foundArtifacts = [...new Set([...before.foundArtifacts, ...found])].sort();
      if (after.foundArtifacts.length === 0) {
        throw new ArchivistError("invalid_input", "Link the artifact where it was found.", {
          field: "foundArtifacts",
        });
      }
      after.status = "resolved";
      after.unrecoverableReason = null;
    } else if (status === "unrecoverable") {
      if (before.status !== "needed") {
        throw new ArchivistError(
          "invalid_input",
          "Only a request that is still needed can be marked unrecoverable.",
          {
            field: "status",
          },
        );
      }
      after.status = "unrecoverable";
      after.unrecoverableReason = requiredText(
        "unrecoverableReason",
        input.unrecoverableReason,
        TEXT_LIMITS.reason,
      );
    } else if (status === "needed") {
      after.status = "needed";
      after.foundArtifacts = [];
      after.unrecoverableReason = null;
    } else {
      throw new ArchivistError(
        "invalid_input",
        "Status must be needed, resolved, or unrecoverable.",
        { field: "status" },
      );
    }
  }

  const changes = diffFields(before, after, LOGGED);
  if (current.version !== expectedVersion) {
    const attempted = Object.fromEntries(
      Object.keys(changes).map((field) => [field, before[field]]),
    );
    throw staleVersion("request", id, current.version, attempted);
  }
  if (Object.keys(changes).length === 0) return current;
  const now = timestamp(context.now());
  commitMutation(store, {
    expectations: [{ table: "research_requests", id, version: current.version + 1 }],
    apply(target) {
      target
        .prepare(
          `UPDATE research_requests SET description = ?, constraint_kind = ?, start_day = ?, end_day = ?,
             anchor_event_id = ?, research_notes = ?, priority = ?, status = ?, unrecoverable_reason = ?,
             version = version + 1, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .run(
          after.description,
          after.constraint.kind,
          after.constraint.startDay,
          after.constraint.endDay,
          after.constraint.anchorEventId,
          after.researchNotes,
          after.priority,
          after.status,
          after.unrecoverableReason,
          now,
          id,
          current.version,
        );
      for (const kind of ["people", "events", "foundArtifacts"] as const) {
        if (!changes[kind]) continue;
        const { table, column } = LINKS[kind];
        target.prepare(`DELETE FROM ${table} WHERE request_id = ?`).run(id);
        const insert = target.prepare(`INSERT INTO ${table} (request_id, ${column}) VALUES (?, ?)`);
        for (const value of after[kind]) insert.run(id, value);
      }
    },
    append: [logEntry(context, actor, "request", id, changes)],
  });
  return readRequest(db, id)!;
}

/** Permanently deletes a request and its own log lines. */
export function deleteRequest(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; id: unknown; expectedVersion: unknown },
): void {
  const { store } = openForActor(context, actor, input.archiveId);
  const id = resolveShortId(store.db, "research_requests", input.id, "request");
  const expectedVersion = expectedVersionValue(input.expectedVersion);
  const row = store.db.prepare("SELECT version FROM research_requests WHERE id = ?").get(id) as
    { version: number } | undefined;
  if (!row) throw notFoundRecord("request");
  if (row.version !== expectedVersion) throw staleVersion("request", id, row.version, {});
  commitMutation(store, {
    expectations: [{ table: "research_requests", id, state: "absent" }],
    apply(target) {
      target.prepare("DELETE FROM research_requests WHERE id = ?").run(id);
    },
    removeRecords: [{ record: "request", id }],
  });
}
