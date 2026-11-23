import { ArchivistError } from "./errors.js";

/**
 * Historical date values and timezone rules.
 *
 * A date-only value never shifts between timezones. A date and time becomes
 * an instant, interpreted in an explicit offset or zone when one is given,
 * otherwise in a default zone the caller chooses (the contributor's
 * preference, then the archive's). Values read from file metadata without a
 * known offset stay local and are never turned into instants by guessing.
 */

export type DateValue =
  | { kind: "day"; originalText: string; calendarDay: string }
  | { kind: "instant"; originalText: string; instantMs: number; timezone: string }
  | { kind: "unknown_local"; originalText: string; calendarDay: string; localDateTime: string };

interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\s*(Z|[+-]\d{2}:?\d{2})|\s+([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*))?$/;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function formatDay(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function formatLocal(local: LocalDateTime): string {
  return `${formatDay(local.year, local.month, local.day)}T${pad(local.hour)}:${pad(local.minute)}:${pad(local.second)}`;
}

function isRealDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function invalid(field: string, message: string, details: Record<string, unknown> = {}): never {
  throw new ArchivistError("invalid_input", message, { field, ...details });
}

/** Returns true when `name` is a timezone name this runtime knows, such as `America/Toronto`. */
export function isTimeZone(name: string): boolean {
  if (!name || /^[+-]?\d/.test(name)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** Validates a timezone name and returns its canonical spelling. */
export function timeZoneName(field: string, value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!isTimeZone(name)) {
    invalid(field, `${field} must be a timezone name such as America/Toronto.`);
  }
  return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
}

/** Validates a `YYYY-MM-DD` calendar day. */
export function calendarDay(field: string, value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  const match = DAY.exec(text);
  if (!match || !isRealDay(Number(match[1]), Number(match[2]), Number(match[3]))) {
    invalid(field, `${field} must be a real date written as YYYY-MM-DD.`);
  }
  return text;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock date and time an instant shows in a timezone. */
function localPartsAt(instantMs: number, timeZone: string): LocalDateTime {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

function localAsUtc(local: LocalDateTime): number {
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
}

function sameLocal(a: LocalDateTime, b: LocalDateTime): boolean {
  return localAsUtc(a) === localAsUtc(b);
}

/**
 * Finds every instant at which a timezone's clocks show `local`. Daylight
 * saving makes this zero instants (a skipped hour) or two (a repeated hour).
 * Offsets observed a day either side cover every transition in practice.
 */
function instantsForLocal(local: LocalDateTime, timeZone: string): number[] {
  const guess = localAsUtc(local);
  const offsets = new Set<number>();
  for (const probe of [guess - 24 * HOUR_MS, guess, guess + 24 * HOUR_MS]) {
    offsets.add(localAsUtc(localPartsAt(probe, timeZone)) - probe);
  }
  const instants = new Set<number>();
  for (const offset of offsets) {
    const candidate = guess - offset;
    if (sameLocal(localPartsAt(candidate, timeZone), local)) instants.add(candidate);
  }
  return [...instants].sort((a, b) => a - b);
}

function parseOffset(text: string): { offsetMs: number; label: string } {
  if (text === "Z") return { offsetMs: 0, label: "UTC" };
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(text)!;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 14 || minutes > 59) invalid("date", `${text} is not a valid UTC offset.`);
  const sign = match[1] === "-" ? -1 : 1;
  return {
    offsetMs: sign * (hours * HOUR_MS + minutes * MINUTE_MS),
    label: `${match[1]}${pad(hours)}:${pad(minutes)}`,
  };
}

/**
 * Parses a contributor's date. Accepts `YYYY-MM-DD`, or a date and time
 * (`YYYY-MM-DD HH:MM[:SS]`) optionally followed by `Z`, an offset such as
 * `-04:00`, or a timezone name. A time without a zone is read in
 * `defaultTimeZone`. Ambiguous or skipped daylight-saving times are rejected
 * with the possible offsets, so the contributor can choose one.
 */
export function parseDateInput(field: string, value: unknown, defaultTimeZone: string): DateValue {
  const text = typeof value === "string" ? value.trim() : "";
  const dayMatch = DAY.exec(text);
  if (dayMatch) {
    return { kind: "day", originalText: text, calendarDay: calendarDay(field, text) };
  }
  const match = DATE_TIME.exec(text);
  if (!match) {
    invalid(field, `${field} must be YYYY-MM-DD, or a date and time such as 2019-07-15 18:30.`);
  }
  const local: LocalDateTime = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  };
  if (
    !isRealDay(local.year, local.month, local.day) ||
    local.hour > 23 ||
    local.minute > 59 ||
    local.second > 59
  ) {
    invalid(field, `${text} is not a real date and time.`);
  }

  const offsetText = match[7];
  if (offsetText) {
    const { offsetMs, label } = parseOffset(offsetText);
    return {
      kind: "instant",
      originalText: text,
      instantMs: localAsUtc(local) - offsetMs,
      timezone: label,
    };
  }

  const timeZone = match[8] ? timeZoneName(field, match[8]) : defaultTimeZone;
  const instants = instantsForLocal(local, timeZone);
  if (instants.length === 0) {
    invalid(
      field,
      `${formatLocal(local)} does not exist in ${timeZone} because the clocks skipped it. Add an offset or correct the time.`,
      {
        reason: "nonexistent_time",
        timeZone,
      },
    );
  }
  if (instants.length > 1) {
    invalid(
      field,
      `${formatLocal(local)} happened twice in ${timeZone} when the clocks went back. Add an offset to choose one.`,
      {
        reason: "ambiguous_time",
        timeZone,
        offsets: instants.map((instant) => offsetLabel(instant, timeZone)),
      },
    );
  }
  return { kind: "instant", originalText: text, instantMs: instants[0]!, timezone: timeZone };
}

/** The UTC offset a timezone used at an instant, such as `-04:00`. */
export function offsetLabel(instantMs: number, timeZone: string): string {
  const offsetMinutes = Math.round(
    (localAsUtc(localPartsAt(instantMs, timeZone)) - instantMs) / MINUTE_MS,
  );
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/** The wall-clock time of an instant in a timezone, as `YYYY-MM-DDTHH:MM:SS`. */
export function localDateTime(instantMs: number, timeZone: string): string {
  return formatLocal(localPartsAt(instantMs, timeZone));
}

/**
 * The calendar day a value falls on for timeline days, filters, and heatmap
 * buckets. Instants use the archive's timezone. Date-only and local values
 * keep their own day.
 */
export function archiveDay(value: DateValue, archiveTimeZone: string): string {
  if (value.kind !== "instant") return value.calendarDay;
  const local = localPartsAt(value.instantMs, archiveTimeZone);
  return formatDay(local.year, local.month, local.day);
}

/**
 * Whether typed text is a date and time without its own zone or offset. Its
 * meaning then depends on the zone it is read in, so the reader is shown that
 * interpretation before it is saved.
 */
export function needsZoneConfirmation(value: unknown): boolean {
  const text = typeof value === "string" ? value.trim() : "";
  const match = DATE_TIME.exec(text);
  return match !== null && match[7] === undefined && match[8] === undefined;
}
