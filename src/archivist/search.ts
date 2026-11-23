import type Database from "better-sqlite3";
import type { EntityKind } from "./entities.js";

/**
 * Text search over an archive, matching substrings case-insensitively after
 * Unicode normalization, as the plan's shared search requires. SQLite's own
 * LIKE folds only ASCII, so each connection gets a folding function.
 */

export const FOLD_FUNCTION = "archivist_fold";

export function foldText(text: string): string {
  return text.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

/** Adds `archivist_fold(text)` to a connection. Called when an archive is opened. */
export function registerSearchFunctions(db: Database.Database): void {
  db.function(FOLD_FUNCTION, { deterministic: true }, (value: unknown) =>
    typeof value === "string" ? foldText(value) : null,
  );
}

export interface SearchHit {
  id: string;
  label: string;
}

const DEFAULT_LIMIT = 25;

function idPrefix(typed: string): string | null {
  const trimmed = typed.trim().toLowerCase();
  return /^[0-9a-f-]{4,36}$/.test(trimmed) ? trimmed : null;
}

/** Artifacts whose description contains the text, or whose ID starts with it, newest first. */
export function searchArtifacts(
  db: Database.Database,
  typed: string,
  limit = DEFAULT_LIMIT,
): SearchHit[] {
  const query = foldText(typed.trim());
  return db
    .prepare(
      `SELECT id, description AS label FROM artifacts
       WHERE instr(${FOLD_FUNCTION}(description), ?) > 0 OR substr(id, 1, ?) = ?
       ORDER BY created_at DESC, id LIMIT ?`,
    )
    .all(
      query,
      (idPrefix(typed) ?? "").length || 1,
      idPrefix(typed) ?? "\u0000",
      limit,
    ) as SearchHit[];
}

const ENTITY_QUERIES: Record<EntityKind, string> = {
  character: `SELECT c.id, c.known_name AS label FROM characters c
    WHERE instr(${FOLD_FUNCTION}(c.known_name), @query) > 0
       OR EXISTS (SELECT 1 FROM character_aliases a WHERE a.character_id = c.id AND instr(${FOLD_FUNCTION}(a.name), @query) > 0)
       OR substr(c.id, 1, @prefixLength) = @prefix
    ORDER BY c.known_name, c.id LIMIT @limit`,
  account: `SELECT id, label FROM accounts
    WHERE instr(${FOLD_FUNCTION}(label), @query) > 0 OR substr(id, 1, @prefixLength) = @prefix OR discord_id = @typed
    ORDER BY label, id LIMIT @limit`,
  server: `SELECT id, label FROM servers
    WHERE instr(${FOLD_FUNCTION}(label), @query) > 0 OR substr(id, 1, @prefixLength) = @prefix OR discord_id = @typed
    ORDER BY label, id LIMIT @limit`,
  channel: `SELECT id, label FROM channels
    WHERE instr(${FOLD_FUNCTION}(label), @query) > 0 OR substr(id, 1, @prefixLength) = @prefix OR discord_id = @typed
    ORDER BY label, id LIMIT @limit`,
};

/** Entities whose name, alias, or label contains the text, or whose ID starts with it. */
export function searchEntities(
  db: Database.Database,
  kind: EntityKind,
  typed: string,
  limit = DEFAULT_LIMIT,
): SearchHit[] {
  const prefix = idPrefix(typed);
  const parameters: Record<string, unknown> = {
    query: foldText(typed.trim()),
    prefixLength: prefix?.length ?? 1,
    prefix: prefix ?? "\u0000",
    limit,
  };
  if (kind !== "character") parameters.typed = typed.trim();
  return db.prepare(ENTITY_QUERIES[kind]).all(parameters) as SearchHit[];
}

/** Events whose title or description contains the text, or whose ID starts with it, oldest first. */
export function searchEvents(
  db: Database.Database,
  typed: string,
  limit = DEFAULT_LIMIT,
): SearchHit[] {
  const prefix = idPrefix(typed);
  return db
    .prepare(
      `SELECT e.id, e.title AS label FROM events e JOIN date_values d ON d.id = e.start_date_id
       WHERE instr(${FOLD_FUNCTION}(e.title), @query) > 0 OR instr(${FOLD_FUNCTION}(e.description), @query) > 0
          OR substr(e.id, 1, @prefixLength) = @prefix
       ORDER BY d.archive_day, e.id LIMIT @limit`,
    )
    .all({
      query: foldText(typed.trim()),
      prefixLength: prefix?.length ?? 1,
      prefix: prefix ?? "\u0000",
      limit,
    }) as SearchHit[];
}

/** Missing-media requests whose description contains the text, or whose ID starts with it, newest first. */
export function searchRequests(
  db: Database.Database,
  typed: string,
  limit = DEFAULT_LIMIT,
): SearchHit[] {
  const prefix = idPrefix(typed);
  return db
    .prepare(
      `SELECT id, description AS label FROM research_requests
       WHERE instr(${FOLD_FUNCTION}(description), @query) > 0 OR substr(id, 1, @prefixLength) = @prefix
       ORDER BY created_at DESC, id LIMIT @limit`,
    )
    .all({
      query: foldText(typed.trim()),
      prefixLength: prefix?.length ?? 1,
      prefix: prefix ?? "\u0000",
      limit,
    }) as SearchHit[];
}
