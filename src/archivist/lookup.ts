import type Database from "better-sqlite3";
import { ArchivistError } from "./errors.js";

/**
 * Picking characters by name, as Discord intake does. A comma-separated list is
 * matched against known names and aliases, ignoring case. A name shared by
 * several characters needs its short ID, such as `Alex (3f9a1c2e)`, which
 * autocomplete supplies. Unknown names are refused, never created.
 */

const SHORT_ID_LENGTH = 8;
const MAX_CHARACTERS = 25;
const MAX_SUGGESTIONS = 25;
const MAX_CHOICE_LENGTH = 100;
const WITH_ID = /^(.*?)\s*\(([0-9a-f-]{8,36})\)$/i;

type ShortIdTable =
  | "characters"
  | "accounts"
  | "servers"
  | "channels"
  | "events"
  | "artifacts"
  | "research_requests"
  | "gap_cards";

/**
 * Finds the record whose ID starts with `input`. Needs at least eight
 * characters, and asks for more when several records match.
 */
export function resolveShortId(
  db: Database.Database,
  table: ShortIdTable,
  input: unknown,
  record: string,
): string {
  const prefix = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (!/^[0-9a-f-]{8,36}$/.test(prefix)) {
    throw new ArchivistError(
      "invalid_input",
      `Give the ${record}'s ID, at least its first ${SHORT_ID_LENGTH} characters.`,
      {
        field: "id",
      },
    );
  }
  const matches = db
    .prepare(`SELECT id FROM ${table} WHERE substr(id, 1, ?) = ? LIMIT 2`)
    .all(prefix.length, prefix) as { id: string }[];
  if (matches.length === 0) {
    throw new ArchivistError(
      "not_found",
      `No ${record} in this archive has an ID starting with ${prefix}.`,
    );
  }
  if (matches.length > 1) {
    throw new ArchivistError(
      "invalid_input",
      `Several ${record}s have IDs starting with ${prefix}. Give more of the ID.`,
      {
        field: "id",
      },
    );
  }
  return matches[0]!.id;
}

function fold(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().trim();
}

interface NameEntry {
  id: string;
  knownName: string;
  /** Every name the character can be picked by, folded for matching. */
  keys: string[];
}

function nameEntries(db: Database.Database): NameEntry[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.known_name AS knownName, a.name AS alias
       FROM characters c LEFT JOIN character_aliases a ON a.character_id = c.id
       ORDER BY c.known_name, c.id`,
    )
    .all() as { id: string; knownName: string; alias: string | null }[];
  const byId = new Map<string, NameEntry>();
  for (const row of rows) {
    let entry = byId.get(row.id);
    if (!entry) {
      entry = { id: row.id, knownName: row.knownName, keys: [fold(row.knownName)] };
      byId.set(row.id, entry);
    }
    if (row.alias) entry.keys.push(fold(row.alias));
  }
  return [...byId.values()];
}

function splitNames(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Resolves a comma-separated list of characters to character IDs. */
export function resolveCharacters(db: Database.Database, text: unknown): string[] {
  if (text === undefined || text === null || text === "") return [];
  if (typeof text !== "string") {
    throw new ArchivistError("invalid_input", "Characters must be names separated by commas.", {
      field: "characters",
    });
  }
  const names = splitNames(text);
  if (names.length > MAX_CHARACTERS) {
    throw new ArchivistError(
      "invalid_input",
      `Add at most ${MAX_CHARACTERS} characters at a time.`,
      {
        field: "characters",
      },
    );
  }
  const entries = nameEntries(db);
  const ids = new Set<string>();
  for (const name of names) {
    const tagged = WITH_ID.exec(name);
    if (tagged) {
      ids.add(resolveShortId(db, "characters", tagged[2], "character"));
      continue;
    }
    const key = fold(name);
    const matches = entries.filter((entry) => entry.keys.includes(key));
    if (matches.length === 0) {
      throw new ArchivistError(
        "invalid_input",
        `${name} is not in this archive. Create the character first, then add them.`,
        { field: "characters", name },
      );
    }
    if (matches.length > 1) {
      throw new ArchivistError(
        "invalid_input",
        `${name} matches several characters. Pick one from the suggestions, such as ${name} (${matches[0]!.id.slice(0, SHORT_ID_LENGTH)}).`,
        { field: "characters", name },
      );
    }
    ids.add(matches[0]!.id);
  }
  return [...ids];
}

/**
 * Resolves a comma-separated list of event titles or short IDs to event IDs.
 * A title that contains a comma, or that several events share, is given by
 * its short ID instead.
 */
export function resolveEvents(db: Database.Database, text: unknown): string[] {
  if (text === undefined || text === null || text === "") return [];
  if (typeof text !== "string") {
    throw new ArchivistError("invalid_input", "Events must be titles separated by commas.", {
      field: "events",
    });
  }
  const rows = db.prepare("SELECT id, title FROM events").all() as { id: string; title: string }[];
  const ids = new Set<string>();
  for (const name of splitNames(text)) {
    const tagged = WITH_ID.exec(name);
    const key = fold(name);
    const matches = tagged ? [] : rows.filter((row) => fold(row.title) === key);
    if (tagged || (matches.length === 0 && /^[0-9a-f-]{8,36}$/i.test(name))) {
      ids.add(resolveShortId(db, "events", tagged ? tagged[2] : name, "event"));
      continue;
    }
    if (matches.length !== 1) {
      throw new ArchivistError(
        "invalid_input",
        matches.length === 0
          ? `There is no event called ${name}. Create it first, or give its ID.`
          : `${name} matches several events. Give the event's ID instead.`,
        { field: "events", name },
      );
    }
    ids.add(matches[0]!.id);
  }
  return [...ids];
}

/** How a character appears in a list: their known name, with a short ID when the name is shared. */
function label(entry: NameEntry, entries: NameEntry[]): string {
  const shared = entries.some(
    (other) => other.id !== entry.id && fold(other.knownName) === fold(entry.knownName),
  );
  return shared ? `${entry.knownName} (${entry.id.slice(0, SHORT_ID_LENGTH)})` : entry.knownName;
}

/**
 * Suggests completions for the last name in a comma-separated list. Each
 * suggestion keeps the names already typed, so picking one fills the list.
 */
export function suggestCharacters(
  db: Database.Database,
  typed: string,
): { name: string; value: string }[] {
  const parts = typed.split(",");
  const partial = fold(parts.pop() ?? "");
  const done = parts.map((part) => part.trim()).filter(Boolean);
  const prefix = done.length ? `${done.join(", ")}, ` : "";
  const taken = new Set(done.map(fold));
  const entries = nameEntries(db);
  const starts: { name: string; value: string }[] = [];
  const contains: { name: string; value: string }[] = [];
  for (const entry of entries) {
    const matches = entry.keys.filter((key) => key.includes(partial));
    if (matches.length === 0) continue;
    const name = label(entry, entries);
    if (taken.has(fold(name)) || taken.has(fold(entry.knownName))) continue;
    const value = `${prefix}${name}`;
    if (value.length > MAX_CHOICE_LENGTH) continue;
    // Names that start with what was typed come before names that only contain it.
    (matches.some((key) => key.startsWith(partial)) ? starts : contains).push({
      name: value,
      value,
    });
  }
  const suggestions = [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
  return suggestions;
}

/** The known names of characters, in the order given, for replies. */
export function characterNames(db: Database.Database, ids: readonly string[]): string[] {
  const statement = db.prepare("SELECT known_name AS name FROM characters WHERE id = ?");
  return ids.map((id) => (statement.get(id) as { name: string } | undefined)?.name ?? "Unknown");
}
