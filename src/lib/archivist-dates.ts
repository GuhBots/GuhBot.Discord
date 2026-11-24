/**
 * How Archivist dates read in Discord. The service parses and stores dates.
 * These helpers only display them, with the month's name so nobody misreads
 * the order, as the owner chose.
 */

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

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
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

/** A `YYYY-MM-DD` day written with its month's name, such as `Jul 15, 2019`. */
export function dayText(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return `${MONTH_NAMES[month - 1]} ${date}, ${year}`;
}

/** A `YYYY-MM-DDTHH:MM:SS` wall-clock time as `Jul 15, 2019, 18:30`. */
export function localText(local: string): string {
  return `${dayText(local.slice(0, 10))}, ${local.slice(11, 16)}`;
}

/** The wall-clock time of an instant in a timezone, as `YYYY-MM-DDTHH:MM:SS`. */
export function localDateTime(instantMs: number, timeZone: string): string {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return (
    `${pad(parts.year!, 4)}-${pad(parts.month!)}-${pad(parts.day!)}` +
    `T${pad(parts.hour!)}:${pad(parts.minute!)}:${pad(parts.second!)}`
  );
}
