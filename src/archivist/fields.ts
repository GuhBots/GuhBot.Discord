import { randomUUID } from "node:crypto";
import { ArchivistError } from "./errors.js";

/**
 * Field rules shared by every Archivist operation. Lengths count Unicode code
 * points, as SQLite's length() does, so the schema checks and these
 * validators agree on non-ASCII text.
 */

export const TEXT_LIMITS = {
  name: 100,
  eventTitle: 200,
  description: 20_000,
  reason: 10_000,
} as const;

const COLOR = /^#[0-9a-f]{6}$/;
const SNOWFLAKE = /^\d{17,20}$/;

function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** Trims a required value and rejects it when blank or longer than `max`. */
export function requiredText(field: string, value: unknown, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new ArchivistError("invalid_input", `${field} is required.`, { field });
  }
  if (codePointLength(text) > max) {
    throw new ArchivistError("invalid_input", `${field} must be at most ${max} characters.`, {
      field,
      max,
    });
  }
  return text;
}

/** Trims an optional value, returning null when it is missing or blank. */
export function optionalText(field: string, value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ArchivistError("invalid_input", `${field} must be text.`, { field });
  }
  return value.trim() ? requiredText(field, value, max) : null;
}

/** Accepts `#rrggbb` in either case and stores it in lowercase. */
export function colorValue(field: string, value: unknown): string {
  const color = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!COLOR.test(color)) {
    throw new ArchivistError("invalid_input", `${field} must be a color such as #5865f2.`, {
      field,
    });
  }
  return color;
}

/** Validates a Discord user, guild, channel, or message ID. */
export function discordId(field: string, value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!SNOWFLAKE.test(id)) {
    throw new ArchivistError("invalid_input", `${field} must be a Discord ID.`, { field });
  }
  return id;
}

/**
 * Returns the key that makes archive names unique regardless of case. NFKC
 * folds compatibility forms such as full-width letters. Upper-casing before
 * lower-casing folds characters like "ß" to "ss", which SQLite's NOCASE
 * collation and a plain toLowerCase() both miss.
 */
export function nameKey(name: string): string {
  return name.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

/** A new internal record ID. IDs are never reused. */
export function newId(): string {
  return randomUUID();
}

/** The current time as a zero-offset timestamp for creation and update fields. */
export function timestamp(now: Date = new Date()): string {
  return now.toISOString();
}
