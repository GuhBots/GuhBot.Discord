import type Database from "better-sqlite3";
import { syncGaps } from "./board.js";
import type { Actor, ArchivistContext } from "./context.js";
import { pruneDates } from "./date-store.js";
import type { FieldChange } from "./edit-log.js";
import { ArchivistError } from "./errors.js";
import { newId, timestamp } from "./fields.js";
import { commitMutation } from "./mutations.js";
import { resolveShortId } from "./people.js";
import { logEntry, notFoundRecord, openForActor } from "./records.js";
import { expectedVersionValue, staleVersion } from "./versions.js";

/**
 * Merging two characters who turn out to be the same person. Merging is
 * always explicit: a contributor chooses which record survives and how each
 * conflicting field is resolved. Matching names are never merged on their
 * own. The other record's known name becomes an alias, its aliases and
 * history move over, and every link is reassigned, keeping one copy of
 * links both records had. The merged record is then gone, like a deleted
 * one, so its own log lines are removed. The owner decided on 2026-11-23
 * that merging happens on the website only.
 */

/** Fields where both records hold different values, so the contributor must choose. */
export type MergeField = "knownName" | "realName" | "birthDay" | "metInPerson" | "fallbackPicture";

interface CharacterRow {
  id: string;
  version: number;
  known_name: string;
  real_name: string | null;
  birth_day: string | null;
  met_in_person: string;
  fallback_media_id: string | null;
}

const FIELD_COLUMNS: Record<MergeField, keyof CharacterRow> = {
  knownName: "known_name",
  realName: "real_name",
  birthDay: "birth_day",
  metInPerson: "met_in_person",
  fallbackPicture: "fallback_media_id",
};

/** Links a merge moves from the merged record to the survivor. */
const MOVES: { label: string; table: string; column: string; unique: boolean }[] = [
  { label: "artifacts", table: "artifact_people", column: "character_id", unique: true },
  { label: "events", table: "event_people", column: "character_id", unique: true },
  {
    label: "missing-media requests",
    table: "request_people",
    column: "character_id",
    unique: true,
  },
  { label: "accounts", table: "accounts", column: "character_id", unique: false },
  {
    label: "account ownership records",
    table: "account_ownerships",
    column: "character_id",
    unique: false,
  },
  { label: "bot owner records", table: "bot_owners", column: "character_id", unique: true },
  { label: "server owner records", table: "server_owners", column: "character_id", unique: false },
  { label: "introductions made", table: "introductions", column: "introducer_id", unique: false },
  {
    label: "introductions received",
    table: "introductions",
    column: "introduced_id",
    unique: false,
  },
  { label: "aliases", table: "character_aliases", column: "character_id", unique: true },
  {
    label: "main-account records",
    table: "character_main_accounts",
    column: "character_id",
    unique: false,
  },
  { label: "research cards", table: "gap_cards", column: "character_id", unique: true },
];

export interface MergePreview {
  survivor: { id: string; version: number; knownName: string };
  merged: { id: string; version: number; knownName: string };
  /** Fields where both records differ and neither is empty, with both values. */
  conflicts: { field: MergeField; survivor: string; merged: string }[];
  /** How many links of each kind move to the survivor. */
  moves: Record<string, number>;
}

function readCharacter(db: Database.Database, id: string): CharacterRow {
  const row = db.prepare("SELECT * FROM characters WHERE id = ?").get(id) as
    CharacterRow | undefined;
  if (!row) throw notFoundRecord("character");
  return row;
}

function isSet(field: MergeField, value: string | null): value is string {
  return value !== null && !(field === "metInPerson" && value === "unknown");
}

function previewFor(
  db: Database.Database,
  survivor: CharacterRow,
  merged: CharacterRow,
): MergePreview {
  const conflicts: MergePreview["conflicts"] = [];
  for (const field of Object.keys(FIELD_COLUMNS) as MergeField[]) {
    const a = survivor[FIELD_COLUMNS[field]] as string | null;
    const b = merged[FIELD_COLUMNS[field]] as string | null;
    if (isSet(field, a) && isSet(field, b) && a !== b)
      conflicts.push({ field, survivor: a, merged: b });
  }
  const moves: Record<string, number> = {};
  for (const move of MOVES) {
    const { n } = db
      .prepare(`SELECT count(*) AS n FROM ${move.table} WHERE ${move.column} = ?`)
      .get(merged.id) as {
      n: number;
    };
    if (n > 0) moves[move.label] = n;
  }
  return {
    survivor: { id: survivor.id, version: survivor.version, knownName: survivor.known_name },
    merged: { id: merged.id, version: merged.version, knownName: merged.known_name },
    conflicts,
    moves,
  };
}

function pair(db: Database.Database, survivorId: unknown, mergedId: unknown) {
  const survivor = readCharacter(db, resolveShortId(db, "characters", survivorId, "character"));
  const merged = readCharacter(db, resolveShortId(db, "characters", mergedId, "character"));
  if (survivor.id === merged.id) {
    throw new ArchivistError("invalid_input", "Choose two different characters to merge.", {
      field: "mergedId",
    });
  }
  return { survivor, merged };
}

/** What merging `mergedId` into `survivorId` would change, for the contributor to review. */
export function previewMerge(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; survivorId: unknown; mergedId: unknown },
): MergePreview {
  const { store } = openForActor(context, actor, input.archiveId);
  const { survivor, merged } = pair(store.db, input.survivorId, input.mergedId);
  return previewFor(store.db, survivor, merged);
}

export interface MergeInput {
  archiveId: unknown;
  survivorId: unknown;
  survivorVersion: unknown;
  mergedId: unknown;
  mergedVersion: unknown;
  /** For each conflict, which record's value to keep. Every conflict needs a choice. */
  choices?: Partial<Record<MergeField, "survivor" | "merged">>;
}

/**
 * Merges one character into another after the contributor reviewed the
 * preview. Both versions must still match what they saw, and every conflict
 * needs a choice.
 */
export function mergeCharacters(
  context: ArchivistContext,
  actor: Actor,
  input: MergeInput,
): MergePreview["survivor"] {
  const { store } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  const { survivor, merged } = pair(db, input.survivorId, input.mergedId);
  const survivorVersion = expectedVersionValue(input.survivorVersion);
  const mergedVersion = expectedVersionValue(input.mergedVersion);
  if (survivor.version !== survivorVersion)
    throw staleVersion("character", survivor.id, survivor.version, {});
  if (merged.version !== mergedVersion)
    throw staleVersion("character", merged.id, merged.version, {});
  const preview = previewFor(db, survivor, merged);
  const choices = input.choices ?? {};
  const missing = preview.conflicts
    .filter((conflict) => !choices[conflict.field])
    .map((conflict) => conflict.field);
  if (missing.length > 0) {
    throw new ArchivistError("invalid_input", "Choose which value to keep for each difference.", {
      field: "choices",
      missing,
    });
  }

  const result: Record<MergeField, string | null> = {} as Record<MergeField, string | null>;
  const changes: Record<string, FieldChange> = {
    merged: { old: null, new: `${merged.known_name} (${merged.id})` },
  };
  for (const field of Object.keys(FIELD_COLUMNS) as MergeField[]) {
    const mine = survivor[FIELD_COLUMNS[field]] as string | null;
    const theirs = merged[FIELD_COLUMNS[field]] as string | null;
    const keep = choices[field] === "merged" ? theirs : isSet(field, mine) ? mine : theirs;
    result[field] = keep ?? (field === "metInPerson" ? "unknown" : null);
    if (result[field] !== mine) changes[field] = { old: mine, new: result[field] };
  }
  // The name that did not win is kept as an undated alias.
  const extraAlias =
    result.knownName === survivor.known_name ? merged.known_name : survivor.known_name;
  if (extraAlias !== result.knownName) changes.alias = { old: null, new: { name: extraAlias } };
  for (const [label, count] of Object.entries(preview.moves))
    changes[label] = { old: null, new: `${count} moved` };

  const now = timestamp(context.now());
  commitMutation(store, {
    expectations: [
      { table: "characters", id: survivor.id, version: survivor.version + 1 },
      { table: "characters", id: merged.id, state: "absent" },
    ],
    apply(target) {
      // An introduction between the two would become someone introducing themselves.
      target
        .prepare(
          "DELETE FROM introductions WHERE (introducer_id = @a AND introduced_id = @b) OR (introducer_id = @b AND introduced_id = @a)",
        )
        .run({ a: survivor.id, b: merged.id });
      for (const move of MOVES) {
        // Links both records had stay once.
        target
          .prepare(`UPDATE OR IGNORE ${move.table} SET ${move.column} = ? WHERE ${move.column} = ?`)
          .run(survivor.id, merged.id);
        if (move.unique)
          target.prepare(`DELETE FROM ${move.table} WHERE ${move.column} = ?`).run(merged.id);
      }
      if (extraAlias !== result.knownName) {
        target
          .prepare(
            "INSERT OR IGNORE INTO character_aliases (id, character_id, name, observed_date_id) VALUES (?, ?, ?, NULL)",
          )
          .run(newId(), survivor.id, extraAlias);
      }
      target
        .prepare(
          `UPDATE characters SET known_name = ?, real_name = ?, birth_day = ?, met_in_person = ?, fallback_media_id = ?,
             version = version + 1, updated_at = ? WHERE id = ?`,
        )
        .run(
          result.knownName,
          result.realName,
          result.birthDay,
          result.metInPerson,
          result.fallbackPicture,
          now,
          survivor.id,
        );
      target.prepare("DELETE FROM characters WHERE id = ?").run(merged.id);
      pruneDates(target);
      syncGaps(target, now, actor.userId);
    },
    append: [logEntry(context, actor, "character", survivor.id, changes)],
    removeRecords: [{ record: "character", id: merged.id }],
  });
  const row = readCharacter(db, survivor.id);
  return { id: row.id, version: row.version, knownName: row.known_name };
}
