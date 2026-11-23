import type Database from "better-sqlite3";
import type { Actor, ArchivistContext } from "./context.js";
import { ArchivistError } from "./errors.js";
import { newId, optionalText, requiredText, TEXT_LIMITS, timestamp } from "./fields.js";
import { commitMutation } from "./mutations.js";
import { resolveShortId } from "./lookup.js";
import { logEntry, notFoundRecord, openForActor } from "./records.js";
import { expectedVersionValue, staleVersion } from "./versions.js";

/**
 * The research board's gap cards. It is a backlog of what is missing, with
 * no assignees.
 *
 * Derived cards follow the data: they open when a gap appears, resolve when
 * it is filled, and reopen if it returns, with one card per record, kind,
 * and field. They are kept in step inside the same transaction as the change
 * that caused them, so they never disagree with the data. Contributors may
 * move a derived card to Unrecoverable with a reason, but cannot resolve one
 * by hand, so a card never claims media or evidence that does not exist.
 *
 * Manual cards are a date-research flag on an artifact, which needs a reason,
 * and low-priority custom research on any record. Contributors move them
 * between Needed, Resolved, and Unrecoverable.
 */

/** Who created cards that no contributor's edit caused, such as on first opening an archive. */
export const SYSTEM_EDITOR = "archivist";

export type GapKind =
  | "unreadable_media"
  | "missing_characters"
  | "account_character"
  | "undated"
  | "missing_evidence"
  | "date_research"
  | "custom";
export type GapStatus = "needed" | "resolved" | "unrecoverable";
export type Priority = "critical" | "high" | "medium" | "low";
export type SubjectKind = "artifact" | "account" | "event" | "character" | "server";

const SUBJECT_COLUMNS: Record<SubjectKind, string> = {
  artifact: "artifact_id",
  account: "account_id",
  event: "event_id",
  character: "character_id",
  server: "server_id",
};
const SUBJECT_TABLES: Record<
  SubjectKind,
  "artifacts" | "accounts" | "events" | "characters" | "servers"
> = {
  artifact: "artifacts",
  account: "accounts",
  event: "events",
  character: "characters",
  server: "servers",
};

interface Derived {
  kind: GapKind;
  priority: Priority;
  subject: SubjectKind;
  /** The IDs of records that currently have this gap. */
  sql: string;
}

const DERIVED: Derived[] = [
  {
    kind: "unreadable_media",
    priority: "critical",
    subject: "artifact",
    sql: `SELECT a.id FROM artifacts a JOIN media m ON m.id = a.media_id
          WHERE json_extract(m.metadata_json, '$.readable') = 0`,
  },
  {
    kind: "missing_characters",
    priority: "high",
    subject: "artifact",
    sql: "SELECT id FROM artifacts WHERE unidentified_characters = 1",
  },
  {
    kind: "account_character",
    priority: "high",
    subject: "account",
    sql: "SELECT id FROM accounts WHERE kind = 'human' AND character_id IS NULL",
  },
  {
    kind: "undated",
    priority: "medium",
    subject: "artifact",
    sql: "SELECT id FROM artifacts WHERE selected_date_id IS NULL",
  },
  {
    kind: "missing_evidence",
    priority: "medium",
    subject: "event",
    sql: `SELECT e.id FROM events e
          WHERE NOT EXISTS (SELECT 1 FROM artifact_events ae WHERE ae.event_id = e.id)`,
  },
];
const DERIVED_KINDS = new Set(DERIVED.map((derived) => derived.kind));

/**
 * Brings derived cards in line with the data. Runs inside a mutation's
 * transaction. These changes follow from the edit that caused them, so they
 * add no log entries of their own.
 */
export function syncGaps(db: Database.Database, now: string, actorId: string): void {
  for (const derived of DERIVED) {
    const column = SUBJECT_COLUMNS[derived.subject];
    const missing = db
      .prepare(
        `SELECT d.id FROM (${derived.sql}) d WHERE NOT EXISTS (
           SELECT 1 FROM gap_cards g WHERE g.kind = ? AND g.${column} = d.id AND g.field_name = '')`,
      )
      .all(derived.kind) as { id: string }[];
    const insert = db.prepare(
      `INSERT INTO gap_cards (id, created_at, created_by, updated_at, kind, ${column}, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const { id } of missing)
      insert.run(newId(), now, actorId, now, derived.kind, id, derived.priority);
    db.prepare(
      `UPDATE gap_cards SET status = 'needed', reason = NULL, version = version + 1, updated_at = ?
       WHERE kind = ? AND field_name = '' AND status = 'resolved' AND ${column} IN (${derived.sql})`,
    ).run(now, derived.kind);
    db.prepare(
      `UPDATE gap_cards SET status = 'resolved', version = version + 1, updated_at = ?
       WHERE kind = ? AND field_name = '' AND status <> 'resolved' AND ${column} NOT IN (${derived.sql})`,
    ).run(now, derived.kind);
  }
}

/** The gap cards that go with a record when it is deleted, so their log lines can go too. */
export function cardsOf(db: Database.Database, subject: SubjectKind, id: string): string[] {
  return (
    db.prepare(`SELECT id FROM gap_cards WHERE ${SUBJECT_COLUMNS[subject]} = ?`).all(id) as {
      id: string;
    }[]
  ).map((card) => card.id);
}

export interface GapCard {
  id: string;
  version: number;
  kind: GapKind;
  status: GapStatus;
  priority: Priority;
  subject: { kind: SubjectKind; id: string; label: string };
  field: string;
  reason: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  /** Derived cards follow the data and cannot be resolved by hand. */
  derived: boolean;
}

interface CardRow {
  id: string;
  version: number;
  kind: GapKind;
  status: GapStatus;
  priority: Priority;
  artifact_id: string | null;
  account_id: string | null;
  event_id: string | null;
  character_id: string | null;
  server_id: string | null;
  field_name: string;
  reason: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
}

function subjectLabel(db: Database.Database, kind: SubjectKind, id: string): string {
  const column = {
    artifact: "description",
    account: "label",
    event: "title",
    character: "known_name",
    server: "label",
  }[kind];
  const row = db
    .prepare(`SELECT ${column} AS label FROM ${SUBJECT_TABLES[kind]} WHERE id = ?`)
    .get(id) as { label: string } | undefined;
  return row?.label ?? id;
}

function toCard(db: Database.Database, row: CardRow): GapCard {
  const kind = (Object.keys(SUBJECT_COLUMNS) as SubjectKind[]).find(
    (subject) => row[SUBJECT_COLUMNS[subject] as keyof CardRow] !== null,
  )!;
  const id = row[SUBJECT_COLUMNS[kind] as keyof CardRow] as string;
  return {
    id: row.id,
    version: row.version,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    subject: { kind, id, label: subjectLabel(db, kind, id) },
    field: row.field_name,
    reason: row.reason,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    derived: DERIVED_KINDS.has(row.kind),
  };
}

const PRIORITY_ORDER =
  "CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END";

/** Gap cards, highest priority first, then oldest, with optional status and kind filters. */
export function listGapCards(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; status?: GapStatus; kinds?: GapKind[] },
): GapCard[] {
  const { store } = openForActor(context, actor, input.archiveId);
  const rows = store.db
    .prepare(
      `SELECT * FROM gap_cards WHERE (@status IS NULL OR status = @status)
       ORDER BY ${PRIORITY_ORDER}, created_at, id`,
    )
    .all({ status: input.status ?? null }) as CardRow[];
  return rows
    .filter((row) => !input.kinds || input.kinds.includes(row.kind))
    .map((row) => toCard(store.db, row));
}

function subjectKindValue(value: unknown): SubjectKind {
  if (typeof value === "string" && value in SUBJECT_COLUMNS) return value as SubjectKind;
  throw new ArchivistError(
    "invalid_input",
    "The record must be an artifact, account, event, character, or server.",
    {
      field: "subjectKind",
    },
  );
}

/**
 * Flags a record for research: a date-research flag on an artifact, or a
 * custom low-priority card on any record. Each record, kind, and field has
 * one card. A resolved card is reopened with the new reason instead of
 * duplicated.
 */
export function flagForResearch(
  context: ArchivistContext,
  actor: Actor,
  input: {
    archiveId: unknown;
    kind: unknown;
    /** Date-research flags are always on an artifact. */
    subjectKind?: unknown;
    subjectId: unknown;
    reason: unknown;
    field?: unknown;
  },
): GapCard {
  const { store } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  if (input.kind !== "date_research" && input.kind !== "custom") {
    throw new ArchivistError("invalid_input", "Flag kind must be date_research or custom.", {
      field: "kind",
    });
  }
  const kind = input.kind;
  const subjectKind = kind === "date_research" ? "artifact" : subjectKindValue(input.subjectKind);
  if (
    kind === "date_research" &&
    input.subjectKind !== undefined &&
    input.subjectKind !== "artifact"
  ) {
    throw new ArchivistError("invalid_input", "Only artifacts are flagged for date research.", {
      field: "subjectKind",
    });
  }
  const subjectId = resolveShortId(db, SUBJECT_TABLES[subjectKind], input.subjectId, subjectKind);
  const reason = requiredText("reason", input.reason, TEXT_LIMITS.reason);
  const field =
    kind === "date_research"
      ? "date"
      : (optionalText("field", input.field, TEXT_LIMITS.name) ?? "");
  const column = SUBJECT_COLUMNS[subjectKind];
  const existing = db
    .prepare(`SELECT * FROM gap_cards WHERE kind = ? AND ${column} = ? AND field_name = ?`)
    .get(kind, subjectId, field) as CardRow | undefined;
  if (existing && existing.status !== "resolved") {
    throw new ArchivistError("invalid_input", "That is already on the board.", {
      field: "kind",
      cardId: existing.id,
    });
  }
  const now = timestamp(context.now());
  const id = existing?.id ?? newId();
  commitMutation(store, {
    expectations: existing
      ? [{ table: "gap_cards", id, version: existing.version + 1 }]
      : [{ table: "gap_cards", id, state: "present" }],
    apply(target) {
      if (existing) {
        target
          .prepare(
            "UPDATE gap_cards SET status = 'needed', reason = ?, version = version + 1, updated_at = ? WHERE id = ?",
          )
          .run(reason, now, id);
      } else {
        target
          .prepare(
            `INSERT INTO gap_cards (id, created_at, created_by, updated_at, kind, ${column}, field_name, priority, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            now,
            actor.userId,
            now,
            kind,
            subjectId,
            field,
            kind === "custom" ? "low" : "medium",
            reason,
          );
      }
    },
    append: [
      logEntry(context, actor, "gap", id, {
        status: { old: existing?.status ?? null, new: "needed" },
        reason: { old: existing?.reason ?? null, new: reason },
        ...(existing
          ? {}
          : {
              kind: { old: null, new: kind },
              subject: { old: null, new: `${subjectKind} ${subjectId}` },
            }),
      }),
    ],
  });
  return toCard(db, db.prepare("SELECT * FROM gap_cards WHERE id = ?").get(id) as CardRow);
}

/**
 * Moves a card between buckets. Unrecoverable needs a reason. Derived cards
 * cannot be resolved by hand, because they resolve when the data is filled in.
 */
export function updateGapCard(
  context: ArchivistContext,
  actor: Actor,
  input: {
    archiveId: unknown;
    id: unknown;
    expectedVersion: unknown;
    status: unknown;
    reason?: unknown;
  },
): GapCard {
  const { store } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  const id = resolveShortId(db, "gap_cards", input.id, "card");
  const expectedVersion = expectedVersionValue(input.expectedVersion);
  const row = db.prepare("SELECT * FROM gap_cards WHERE id = ?").get(id) as CardRow | undefined;
  if (!row) throw notFoundRecord("card");
  if (
    input.status !== "needed" &&
    input.status !== "resolved" &&
    input.status !== "unrecoverable"
  ) {
    throw new ArchivistError(
      "invalid_input",
      "Status must be needed, resolved, or unrecoverable.",
      { field: "status" },
    );
  }
  const status = input.status;
  if (status === "resolved" && DERIVED_KINDS.has(row.kind)) {
    throw new ArchivistError(
      "invalid_input",
      "This card resolves by itself when the missing information is added.",
      { field: "status" },
    );
  }
  if (status === "needed" && DERIVED_KINDS.has(row.kind) && row.status === "resolved") {
    throw new ArchivistError("invalid_input", "This card reopens by itself if the gap returns.", {
      field: "status",
    });
  }
  const reason =
    status === "unrecoverable"
      ? requiredText("reason", input.reason, TEXT_LIMITS.reason)
      : input.reason === undefined
        ? row.reason
        : optionalText("reason", input.reason, TEXT_LIMITS.reason);
  if (row.version !== expectedVersion) {
    throw staleVersion("card", id, row.version, { status: row.status, reason: row.reason });
  }
  const card = toCard(db, row);
  if (status === row.status && reason === row.reason) return card;
  const now = timestamp(context.now());
  commitMutation(store, {
    expectations: [{ table: "gap_cards", id, version: row.version + 1 }],
    apply(target) {
      target
        .prepare(
          "UPDATE gap_cards SET status = ?, reason = ?, version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(status, reason, now, id);
    },
    append: [
      logEntry(context, actor, "gap", id, {
        ...(status !== row.status ? { status: { old: row.status, new: status } } : {}),
        ...(reason !== row.reason ? { reason: { old: row.reason, new: reason } } : {}),
      }),
    ],
  });
  return toCard(db, db.prepare("SELECT * FROM gap_cards WHERE id = ?").get(id) as CardRow);
}
