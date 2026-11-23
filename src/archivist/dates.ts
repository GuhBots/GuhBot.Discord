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

/** How a person writes all-number dates such as 03/04/2019. */
export type DateOrder = "ymd" | "mdy" | "dmy";
export const DATE_ORDERS: readonly DateOrder[] = ["ymd", "mdy", "dmy"];
export const DEFAULT_DATE_ORDER: DateOrder = "ymd";

export function dateOrderValue(value: unknown): DateOrder {
  if (typeof value === "string" && (DATE_ORDERS as readonly string[]).includes(value)) {
    return value as DateOrder;
  }
  throw new ArchivistError("invalid_input", "The date order must be ymd, mdy, or dmy.", {
    field: "dateOrder",
  });
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/** Words that may appear in a typed date without changing it. */
const IGNORED_WORDS = new Set([
  "mon",
  "monday",
  "tue",
  "tues",
  "tuesday",
  "wed",
  "wednesday",
  "thu",
  "thur",
  "thurs",
  "thursday",
  "fri",
  "friday",
  "sat",
  "saturday",
  "sun",
  "sunday",
  "of",
  "at",
  "on",
  "the",
]);

/** A clock time, either 24-hour (`18:30`, `18:30:15`) or 12-hour (`6:30pm`, `6 pm`, `6 p.m.`). */
const TIME =
  /(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:\s*([ap])\.?m\b\.?)?|(\d{1,2})\s*([ap])\.?m\b\.?/i;
/** A zone written right after the time: `Z`, `UTC`, `GMT`, an offset, or a zone name. */
const ZONE_AFTER_TIME =
  /^\s*(z|utc|gmt|[+-]\d{2}:?\d{2}|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)(?=$|[\s,])/i;

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

interface TypedDate {
  year: number;
  month: number;
  day: number;
  time: { hour: number; minute: number; second: number } | null;
  /** `Z`, an offset such as `-04:00`, or a zone name, when typed after the time. */
  zone: string | null;
}

const EXAMPLES = "such as 2019-07-15, Jul 15 2019, or 15 July 2019 6:30pm";

function unreadable(field: string, text: string, why = ""): never {
  invalid(field, `${field}: "${text}" is not a date I can read${why}. Write it ${EXAMPLES}.`);
}

function clockTime(
  field: string,
  text: string,
  match: RegExpExecArray,
): { hour: number; minute: number; second: number } {
  const twelveHour = match[4] ?? match[6];
  let hour = Number(match[1] ?? match[5]);
  const minute = Number(match[2] ?? 0);
  const second = Number(match[3] ?? 0);
  if (twelveHour) {
    if (hour < 1 || hour > 12) unreadable(field, text, ", because 12-hour times run from 1 to 12");
    hour = (hour % 12) + (twelveHour.toLowerCase() === "p" ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || second > 59) {
    invalid(field, `${field}: "${text}" is not a real time.`);
  }
  return { hour, minute, second };
}

/** Splits off a zone typed directly after the time, returning it and the rest of the text. */
function zoneAfterTime(tail: string): { zone: string | null; rest: string } {
  const match = ZONE_AFTER_TIME.exec(tail);
  if (!match) return { zone: null, rest: tail };
  const word = match[1]!;
  const lower = word.toLowerCase();
  const isZone =
    lower === "z" ||
    lower === "utc" ||
    lower === "gmt" ||
    /^[+-]/.test(word) ||
    word.includes("/") ||
    (!(lower in MONTHS) && !IGNORED_WORDS.has(lower) && isTimeZone(word));
  if (!isZone) return { zone: null, rest: tail };
  const zone = lower === "z" || lower === "utc" || lower === "gmt" ? "Z" : word;
  return { zone, rest: tail.slice(match[0].length) };
}

/**
 * Reads the year, month, and day from the words of a typed date. A month
 * name settles the order. Otherwise a four-digit year first means
 * year-month-day, and a year last follows the contributor's date order, or
 * whichever reading is the only real one.
 */
function readDay(
  field: string,
  text: string,
  words: string[],
  order: DateOrder,
): { year: number; month: number; day: number } {
  const months: number[] = [];
  const numbers: string[] = [];
  for (const word of words) {
    const bare = word.replace(/\.$/, "");
    if (bare in MONTHS) months.push(MONTHS[bare]!);
    else if (/^\d+(st|nd|rd|th)?$/.test(bare)) numbers.push(bare.replace(/\D+$/, ""));
    else if (!IGNORED_WORDS.has(bare))
      unreadable(field, text, ` ("${word}" is not part of a date)`);
  }
  if (months.length > 1) unreadable(field, text, ", because it names two months");

  if (months.length === 1) {
    const years = numbers.filter((number) => number.length === 4);
    const days = numbers.filter((number) => number.length <= 2);
    if (numbers.length === 1 && years.length === 1) {
      invalid(field, `${field}: "${text}" needs a day of the month.`);
    }
    if (numbers.length === 1 && days.length === 1) {
      invalid(field, `${field}: "${text}" needs a four-digit year.`);
    }
    if (years.length !== 1 || days.length !== 1 || numbers.length !== 2) {
      unreadable(field, text, ", because it needs one day and one four-digit year");
    }
    return { year: Number(years[0]), month: months[0]!, day: Number(days[0]) };
  }

  if (numbers.length === 1 && /^\d{8}$/.test(numbers[0]!)) {
    const digits = numbers[0]!;
    return {
      year: Number(digits.slice(0, 4)),
      month: Number(digits.slice(4, 6)),
      day: Number(digits.slice(6, 8)),
    };
  }
  if (numbers.length !== 3) unreadable(field, text);
  const [first, second, third] = numbers as [string, string, string];
  if (first.length === 4) return { year: Number(first), month: Number(second), day: Number(third) };
  if (third.length !== 4) {
    invalid(field, `${field}: "${text}" needs a four-digit year, ${EXAMPLES}.`);
  }
  const a = Number(first);
  const b = Number(second);
  const year = Number(third);
  if (order === "mdy") return { year, month: a, day: b };
  if (order === "dmy") return { year, month: b, day: a };
  if (a === b || (a > 12 && b <= 12)) return { year, month: b, day: a };
  if (b > 12 && a <= 12) return { year, month: a, day: b };
  invalid(
    field,
    `${field}: "${text}" could mean either month first or day first. Write the month as a word, such as Jul 15 2019, or set your date order in /archivist preferences.`,
  );
}

/**
 * Reads a typed date in any common form: `2019-07-15`, `2019/7/15`,
 * `Jul 15 2019`, `15 July 2019`, `june, 2019, 19`, or `20190715`, with an
 * optional time such as `18:30`, `6:30pm`, or `6 pm`, and an optional zone
 * after the time. All-number dates with the year last follow `order`.
 */
function readTypedDate(field: string, value: unknown, order: DateOrder): TypedDate {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) invalid(field, `${field} is empty. Write a date ${EXAMPLES}.`);
  // `2019-07-15T18:30` joins the date and time with a T.
  const spaced = text.replace(/(\d)T(?=\d{1,2}:)/i, "$1 ");
  const timeMatch = TIME.exec(spaced);
  let dateText = spaced;
  let time: TypedDate["time"] = null;
  let zone: string | null = null;
  if (timeMatch) {
    time = clockTime(field, text, timeMatch);
    const after = zoneAfterTime(spaced.slice(timeMatch.index + timeMatch[0].length));
    zone = after.zone;
    dateText = `${spaced.slice(0, timeMatch.index)} ${after.rest}`;
  }
  const words = dateText
    .toLowerCase()
    .split(/[\s,/.-]+/)
    .filter(Boolean);
  const { year, month, day } = readDay(field, text, words, order);
  if (!isRealDay(year, month, day)) invalid(field, `${field}: "${text}" is not a real date.`);
  return { year, month, day, time, zone };
}

/**
 * Parses a contributor's date, in any form `readTypedDate` accepts. A date
 * without a time stays a calendar day. A time without a zone is read in
 * `defaultTimeZone`. Ambiguous or skipped daylight-saving times are rejected
 * with the possible offsets, so the contributor can choose one.
 */
export function parseDateInput(
  field: string,
  value: unknown,
  defaultTimeZone: string,
  order: DateOrder = DEFAULT_DATE_ORDER,
): DateValue {
  const text = typeof value === "string" ? value.trim() : "";
  const typed = readTypedDate(field, value, order);
  if (!typed.time) {
    return {
      kind: "day",
      originalText: text,
      calendarDay: formatDay(typed.year, typed.month, typed.day),
    };
  }
  const local: LocalDateTime = {
    year: typed.year,
    month: typed.month,
    day: typed.day,
    ...typed.time,
  };

  if (typed.zone && /^(Z|[+-])/.test(typed.zone)) {
    const { offsetMs, label } = parseOffset(typed.zone);
    return {
      kind: "instant",
      originalText: text,
      instantMs: localAsUtc(local) - offsetMs,
      timezone: label,
    };
  }

  const timeZone = typed.zone ? timeZoneName(field, typed.zone) : defaultTimeZone;
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

/** Parses a typed calendar day in any form `readTypedDate` accepts, refusing a time. */
export function parseDayInput(
  field: string,
  value: unknown,
  order: DateOrder = DEFAULT_DATE_ORDER,
): string {
  const typed = readTypedDate(field, value, order);
  if (typed.time) invalid(field, `${field} takes a day without a time.`);
  return formatDay(typed.year, typed.month, typed.day);
}

/**
 * Whether typed text is a date and time without its own zone or offset. Its
 * meaning then depends on the zone it is read in, so the reader is shown that
 * interpretation before it is saved. Unreadable text returns false and is
 * refused when it is parsed.
 */
export function needsZoneConfirmation(
  value: unknown,
  order: DateOrder = DEFAULT_DATE_ORDER,
): boolean {
  try {
    const typed = readTypedDate("date", value, order);
    return typed.time !== null && typed.zone === null;
  } catch {
    return false;
  }
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * A `YYYY-MM-DD` day written with its month's name, such as `Jul 15, 2019`.
 * The owner chose this display so nobody misreads the order.
 */
export function dayText(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return `${MONTH_NAMES[month - 1]} ${date}, ${year}`;
}

/** A `YYYY-MM-DDTHH:MM:SS` wall-clock time as `Jul 15, 2019, 18:30`. */
export function localText(local: string): string {
  return `${dayText(local.slice(0, 10))}, ${local.slice(11, 16)}`;
}
