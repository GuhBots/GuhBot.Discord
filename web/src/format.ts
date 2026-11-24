/** Dates as the website shows them: month names, so no one misreads the order. */

export const MONTHS = [
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
export const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const DAY_MS = 86_400_000;
export const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / DAY_MS;
export const dayOfNumber = (n: number): string =>
  new Date(Math.round(n) * DAY_MS).toISOString().slice(0, 10);
export const todayDay = (): string => new Date().toISOString().slice(0, 10);

/** `2019-07-15` as `Jul 15, 2019`. */
export function dayText(day: string | null | undefined): string {
  if (!day) return "No date yet";
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function monthText(day: string): string {
  const [y, m] = day.split("-").map(Number) as [number, number];
  return `${MONTHS[m - 1]} ${y}`;
}

export function basisText(basis: string): string {
  return (
    { exact: "exact", estimated: "estimated", file: "file date, not verified", undated: "undated" }[
      basis
    ] ?? basis
  );
}

export function initials(name: string): string {
  return name
    .split(/[\s_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!)
    .join("")
    .toUpperCase();
}

export const shortId = (id: string) => id.slice(0, 8);
