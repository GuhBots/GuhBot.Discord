import type Database from "better-sqlite3";

/**
 * Colors assigned to new servers, channels, and events. Each reads clearly on
 * the dark main surface (#313338). Greens are left out because artifact dots
 * are green, and yellow because server-change arrows are (owner, 2026-11-23).
 * Contributors can change a record's color afterward.
 */
export const PALETTE = [
  "#5865f2",
  "#eb459e",
  "#00a8fc",
  "#f0b232",
  "#a970ff",
  "#2dc7c4",
  "#ff7a45",
  "#c9cdfb",
  "#e67e22",
] as const;

/** Picks the palette color fewest records in the table use, in palette order on ties. */
export function nextColor(db: Database.Database, table: "servers" | "channels" | "events"): string {
  const counts = new Map<string, number>(
    (
      db.prepare(`SELECT color, count(*) AS n FROM ${table} GROUP BY color`).all() as {
        color: string;
        n: number;
      }[]
    ).map((row) => [row.color, row.n]),
  );
  let best: string = PALETTE[0];
  for (const color of PALETTE) {
    if ((counts.get(color) ?? 0) < (counts.get(best) ?? 0)) best = color;
  }
  return best;
}
