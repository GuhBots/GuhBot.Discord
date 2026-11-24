import type Database from "better-sqlite3";
import type { Actor, ArchivistContext } from "./context.js";
import { calendarDay } from "./dates.js";
import { ArchivistError } from "./errors.js";
import { characterPictureAt, type Picture } from "./history.js";
import {
  ARTIFACT_FROM,
  type ArtifactFilters,
  artifactWhere,
  type EventFilters,
  eventWhere,
  UNASSIGNED_SQL,
} from "./queries.js";
import { openForActor } from "./records.js";

/**
 * Data for the website's views: the timeline, the calendar and heatmap day
 * counts, and the character graph. Each one aggregates in a few queries, so
 * a view never loads every record, and each applies the shared filters, so
 * counts reflect the filtered records. Days are archive days, the same for
 * everyone.
 */

export const BUCKETS = ["day", "week", "month"] as const;
export type Bucket = (typeof BUCKETS)[number];
/** A timeline request covers at most this many days. */
const MAX_SPAN_DAYS = 366 * 60;
const DAY_MS = 86_400_000;

function invalid(field: string, message: string): ArchivistError {
  return new ArchivistError("invalid_input", message, { field });
}

const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / DAY_MS;
const dayText = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** The first day of the bucket holding `day`. Weeks start on Monday. */
export function bucketStart(day: string, bucket: Bucket): string {
  if (bucket === "day") return day;
  if (bucket === "month") return `${day.slice(0, 7)}-01`;
  const n = dayNumber(day);
  const weekday = (new Date(n * DAY_MS).getUTCDay() + 6) % 7;
  return dayText(n - weekday);
}

export function bucketEnd(start: string, bucket: Bucket): string {
  if (bucket === "day") return start;
  if (bucket === "week") return dayText(dayNumber(start) + 6);
  const [y, m] = start.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function readBucket(value: unknown): Bucket {
  if (!BUCKETS.includes(value as Bucket))
    throw invalid("bucket", "Bucket must be day, week, or month.");
  return value as Bucket;
}

function readRange(fromInput: unknown, toInput: unknown): { fromDay: string; toDay: string } {
  const fromDay = calendarDay("fromDay", fromInput);
  const toDay = calendarDay("toDay", toInput);
  if (toDay < fromDay) throw invalid("toDay", "The end day comes before the start day.");
  if (dayNumber(toDay) - dayNumber(fromDay) > MAX_SPAN_DAYS) {
    throw invalid("toDay", "Ask for at most 60 years at a time.");
  }
  return { fromDay, toDay };
}

/* Timeline */

export interface TimelineLane {
  /** A server ID, a group chat ID, or `unassigned`. */
  id: string;
  kind: "server" | "group_chat" | "unassigned";
  /** The name before any dated name applies. */
  label: string;
  color: string;
  isMain: boolean;
  /** Dated names and icons, so the label can follow the timeline position without a request. */
  names: { name: string; day: string | null }[];
  icons: { mediaId: string; day: string | null }[];
  /** Stretches of activity whose gaps are at most the archive's lane gap. Dashed when no date in it is exact. */
  segments: { start: string; end: string; uncertain: boolean }[];
  /** One dot per bucket with artifacts, darker with more. Dashed when any date in it is not exact. */
  dots: { start: string; end: string; count: number; uncertain: boolean }[];
  /** Single-day events, and the server's or group chat's name and icon changes. */
  arrows: TimelineArrow[];
}

export type TimelineArrow =
  | { kind: "event"; day: string; id: string; title: string; estimated: boolean }
  | { kind: "name"; day: string; name: string }
  | { kind: "icon"; day: string; mediaId: string };

export interface TimelineMarker {
  kind: "account_name" | "avatar" | "main_account";
  day: string;
  characterId: string;
  accountId: string;
  /** The picture to show: the new avatar, or the character's picture that day. */
  picture: Picture;
  /** The new name for a name change. */
  name: string | null;
}

export interface TimelineView {
  fromDay: string;
  toDay: string;
  bucket: Bucket;
  laneGapDays: number;
  lanes: TimelineLane[];
  /** Events that lasted across a range or happened sometime in one, overlapping the window. */
  band: {
    id: string;
    title: string;
    dateKind: "duration" | "occurrence_window";
    estimated: boolean;
    start: string;
    end: string;
    color: string;
  }[];
  markers: TimelineMarker[];
  /** Filtered artifacts with no date, which the timeline cannot place. */
  undated: number;
}

interface DatedRow {
  id: string;
  day: string;
  exact: number;
  lane: string;
}

/** Every filtered, dated artifact on each lane it belongs to, once per lane. */
function artifactLaneRows(db: Database.Database, filters: ArtifactFilters): DatedRow[] {
  const { sql, params } = artifactWhere(filters);
  const where = sql
    ? `${sql} AND a.selected_date_id IS NOT NULL`
    : "WHERE a.selected_date_id IS NOT NULL";
  return db
    .prepare(
      `WITH f AS (SELECT a.id, d.archive_day AS day, (a.selected_date_id = a.exact_date_id) AS exact ${ARTIFACT_FROM} ${where})
       SELECT DISTINCT id, day, exact, lane FROM (
         SELECT f.id, f.day, f.exact, x.server_id AS lane FROM f JOIN artifact_servers x ON x.artifact_id = f.id
         UNION ALL
         SELECT f.id, f.day, f.exact, c.server_id FROM f JOIN artifact_channels x ON x.artifact_id = f.id
           JOIN channels c ON c.id = x.channel_id WHERE c.server_id IS NOT NULL
         UNION ALL
         SELECT f.id, f.day, f.exact, c.id FROM f JOIN artifact_channels x ON x.artifact_id = f.id
           JOIN channels c ON c.id = x.channel_id WHERE c.kind = 'group_chat'
         UNION ALL
         SELECT f.id, f.day, f.exact, 'unassigned' FROM f JOIN artifacts a ON a.id = f.id WHERE ${UNASSIGNED_SQL}
       )`,
    )
    .all(params) as DatedRow[];
}

interface EventRow {
  id: string;
  title: string;
  date_kind: "single" | "duration" | "occurrence_window";
  certainty: "exact" | "estimated";
  color: string;
  start: string;
  end: string | null;
}

function filteredEvents(db: Database.Database, filters: EventFilters): EventRow[] {
  const { clauses, params } = eventWhere(filters);
  return db
    .prepare(
      `SELECT e.id, e.title, e.date_kind, e.certainty, e.color, s.archive_day AS start, f.archive_day AS "end"
       FROM events e JOIN date_values s ON s.id = e.start_date_id LEFT JOIN date_values f ON f.id = e.end_date_id
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY s.archive_day, e.id`,
    )
    .all(params) as EventRow[];
}

/** The lanes an event appears on, by the same rule as artifacts. */
function eventLanes(db: Database.Database): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT event_id AS id, server_id AS lane FROM event_servers
       UNION SELECT x.event_id, c.server_id FROM event_channels x JOIN channels c ON c.id = x.channel_id WHERE c.server_id IS NOT NULL
       UNION SELECT x.event_id, c.id FROM event_channels x JOIN channels c ON c.id = x.channel_id WHERE c.kind = 'group_chat'`,
    )
    .all() as { id: string; lane: string }[];
  const lanes = new Map<string, string[]>();
  for (const row of rows) lanes.set(row.id, [...(lanes.get(row.id) ?? []), row.lane]);
  return lanes;
}

function datedList<T>(
  db: Database.Database,
  sql: string,
  id: string,
  map: (row: Record<string, unknown>) => T,
): T[] {
  return (db.prepare(sql).all(id) as Record<string, unknown>[]).map(map);
}

export function timelineView(
  context: ArchivistContext,
  actor: Actor,
  input: {
    archiveId: unknown;
    fromDay: unknown;
    toDay: unknown;
    bucket: unknown;
    filters: ArtifactFilters;
    eventFilters: EventFilters;
  },
): TimelineView {
  const { store, details } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  const { fromDay, toDay } = readRange(input.fromDay, input.toDay);
  const bucket = readBucket(input.bucket);
  const gap = details.laneGapDays;

  // The lanes: Unassigned, group chats, other servers, then the main server, closest to the events.
  const servers = db.prepare("SELECT id, color, label FROM servers ORDER BY label, id").all() as {
    label: string;
    id: string;
    color: string;
  }[];
  const chats = db
    .prepare(
      "SELECT id, color, label, icon_media_id AS icon FROM channels WHERE kind = 'group_chat' ORDER BY label, id",
    )
    .all() as { id: string; color: string; label: string; icon: string | null }[];
  const labels = new Map([...servers, ...chats].map((place) => [place.id, place.label]));
  const lanes: TimelineLane[] = [
    {
      id: "unassigned",
      kind: "unassigned",
      label: "Unassigned",
      color: "#80848e",
      isMain: false,
      names: [],
      icons: [],
      segments: [],
      dots: [],
      arrows: [],
    },
    ...chats.map((c) => ({
      id: c.id,
      kind: "group_chat" as const,
      label: c.label,
      color: c.color,
      isMain: false,
      names: datedList(
        db,
        `SELECT n.name, d.archive_day AS day FROM channel_names n LEFT JOIN date_values d ON d.id = n.observed_date_id
         WHERE n.channel_id = ? ORDER BY d.archive_day IS NULL, d.archive_day, n.id`,
        c.id,
        (r) => ({ name: r.name as string, day: (r.day as string | null) ?? null }),
      ),
      icons: c.icon ? [{ mediaId: c.icon, day: null }] : [],
      segments: [],
      dots: [],
      arrows: [],
    })),
    ...servers
      .filter((s) => s.id !== details.mainServerId)
      .concat(servers.filter((s) => s.id === details.mainServerId))
      .map((s) => ({
        id: s.id,
        kind: "server" as const,
        label: s.label,
        color: s.color,
        isMain: s.id === details.mainServerId,
        names: datedList(
          db,
          `SELECT n.name, d.archive_day AS day FROM server_names n LEFT JOIN date_values d ON d.id = n.observed_date_id
           WHERE n.server_id = ? ORDER BY d.archive_day IS NULL, d.archive_day, n.id`,
          s.id,
          (r) => ({ name: r.name as string, day: (r.day as string | null) ?? null }),
        ),
        icons: datedList(
          db,
          `SELECT i.media_id AS mediaId, d.archive_day AS day FROM server_icons i LEFT JOIN date_values d ON d.id = i.observed_date_id
           WHERE i.server_id = ? ORDER BY d.archive_day IS NULL, d.archive_day, i.id`,
          s.id,
          (r) => ({ mediaId: r.mediaId as string, day: (r.day as string | null) ?? null }),
        ),
        segments: [],
        dots: [],
        arrows: [],
      })),
  ];
  const byId = new Map(lanes.map((lane) => [lane.id, lane]));

  // Activity per lane over all time, so a stretch that crosses the window's edge is drawn right.
  const activity = new Map<string, Map<string, boolean>>();
  const note = (lane: string, day: string, exact: boolean) => {
    const days = activity.get(lane) ?? new Map<string, boolean>();
    days.set(day, (days.get(day) ?? false) || exact);
    activity.set(lane, days);
  };
  const dots = new Map<string, { count: number; uncertain: boolean }>();
  for (const row of artifactLaneRows(db, input.filters)) {
    if (!byId.has(row.lane)) continue;
    note(row.lane, row.day, row.exact === 1);
    if (row.day < fromDay || row.day > toDay) continue;
    const key = `${row.lane}|${bucketStart(row.day, bucket)}`;
    const dot = dots.get(key) ?? { count: 0, uncertain: false };
    dot.count += 1;
    dot.uncertain ||= row.exact !== 1;
    dots.set(key, dot);
  }
  for (const [key, dot] of dots) {
    const [lane, start] = key.split("|") as [string, string];
    byId.get(lane)!.dots.push({ start, end: bucketEnd(start, bucket), ...dot });
  }

  const events = filteredEvents(db, input.eventFilters);
  const placed = eventLanes(db);
  const band: TimelineView["band"] = [];
  for (const event of events) {
    const end = event.end ?? event.start;
    if (event.date_kind !== "single") {
      if (event.start <= toDay && end >= fromDay) {
        band.push({
          id: event.id,
          title: event.title,
          dateKind: event.date_kind,
          estimated: event.certainty === "estimated",
          start: event.start,
          end,
          color: event.color,
        });
      }
      continue;
    }
    for (const lane of placed.get(event.id) ?? ["unassigned"]) {
      if (!byId.has(lane)) continue;
      note(lane, event.start, event.certainty === "exact");
      if (event.start >= fromDay && event.start <= toDay) {
        byId.get(lane)!.arrows.push({
          kind: "event",
          day: event.start,
          id: event.id,
          title: event.title,
          estimated: event.certainty === "estimated",
        });
      }
    }
  }

  for (const lane of lanes) {
    // A dated name or icon that differs from the one in effect just before marks a new era.
    // Before any dated name, a place goes by its label. A first known icon is not a change.
    const changes: TimelineArrow[] = [];
    let name = labels.get(lane.id) ?? "";
    for (const entry of lane.names.filter((n) => n.day)) {
      if (entry.name !== name) changes.push({ kind: "name", day: entry.day!, name: entry.name });
      name = entry.name;
    }
    let icon: string | null = null;
    for (const entry of lane.icons.filter((i) => i.day)) {
      if (icon !== null && entry.mediaId !== icon) {
        changes.push({ kind: "icon", day: entry.day!, mediaId: entry.mediaId });
      }
      icon = entry.mediaId;
    }
    lane.arrows.push(...changes.filter((c) => c.day >= fromDay && c.day <= toDay));
    lane.arrows.sort((a, b) => a.day.localeCompare(b.day));
    lane.dots.sort((a, b) => a.start.localeCompare(b.start));

    const days = [...(activity.get(lane.id) ?? new Map<string, boolean>())].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    let current: { start: string; end: string; uncertain: boolean } | null = null;
    for (const [day, exact] of days) {
      if (current && dayNumber(day) - dayNumber(current.end) <= gap) {
        current.end = day;
        current.uncertain &&= !exact;
      } else {
        if (current) lane.segments.push(current);
        current = { start: day, end: day, uncertain: !exact };
      }
    }
    if (current) lane.segments.push(current);
    lane.segments = lane.segments.filter((s) => s.start <= toDay && s.end >= fromDay);
  }

  return {
    fromDay,
    toDay,
    bucket,
    laneGapDays: gap,
    lanes,
    band,
    markers: timelineMarkers(db, fromDay, toDay, input.filters.characters),
    undated: undatedCount(db, input.filters),
  };
}

/** Account name, avatar, and main-account changes in the window, for the optional marker layer. */
function timelineMarkers(
  db: Database.Database,
  fromDay: string,
  toDay: string,
  characters: string[],
): TimelineMarker[] {
  const markers: TimelineMarker[] = [];
  const keep = (characterId: string | null) =>
    characterId && (!characters.length || characters.includes(characterId));
  // The first observation of each account or character is where it starts, not a change.
  const changes = (sql: string) =>
    (
      db.prepare(sql).all() as {
        owner: string;
        day: string;
        characterId: string | null;
        accountId: string;
        mediaId: string | null;
        name: string | null;
        n: number;
      }[]
    ).filter((row) => row.n > 1 && row.day >= fromDay && row.day <= toDay && keep(row.characterId));
  for (const row of changes(
    `SELECT v.account_id AS owner, d.archive_day AS day, a.character_id AS characterId, v.account_id AS accountId,
       NULL AS mediaId, v.username AS name, row_number() OVER (PARTITION BY v.account_id ORDER BY d.archive_day, v.id) AS n
     FROM account_names v JOIN accounts a ON a.id = v.account_id JOIN date_values d ON d.id = v.observed_date_id`,
  )) {
    markers.push({
      kind: "account_name",
      day: row.day,
      characterId: row.characterId!,
      accountId: row.accountId,
      picture: characterPictureAt(db, row.characterId!, row.day),
      name: row.name,
    });
  }
  for (const row of changes(
    `SELECT v.account_id AS owner, d.archive_day AS day, a.character_id AS characterId, v.account_id AS accountId,
       v.media_id AS mediaId, NULL AS name, row_number() OVER (PARTITION BY v.account_id ORDER BY d.archive_day, v.id) AS n
     FROM account_avatars v JOIN accounts a ON a.id = v.account_id JOIN date_values d ON d.id = v.observed_date_id`,
  )) {
    markers.push({
      kind: "avatar",
      day: row.day,
      characterId: row.characterId!,
      accountId: row.accountId,
      picture: { source: "avatar", accountId: row.accountId, mediaId: row.mediaId! },
      name: null,
    });
  }
  for (const row of changes(
    `SELECT v.character_id AS owner, d.archive_day AS day, v.character_id AS characterId, v.account_id AS accountId,
       NULL AS mediaId, NULL AS name, row_number() OVER (PARTITION BY v.character_id ORDER BY d.archive_day, v.id) AS n
     FROM character_main_accounts v JOIN date_values d ON d.id = v.observed_date_id`,
  )) {
    markers.push({
      kind: "main_account",
      day: row.day,
      characterId: row.characterId!,
      accountId: row.accountId,
      picture: characterPictureAt(db, row.characterId!, row.day),
      name: null,
    });
  }
  return markers.sort((a, b) => a.day.localeCompare(b.day) || a.kind.localeCompare(b.kind));
}

function undatedCount(db: Database.Database, filters: ArtifactFilters): number {
  const { sql, params } = artifactWhere({ ...filters, fromDay: null, toDay: null });
  const where = sql ? `${sql} AND a.selected_date_id IS NULL` : "WHERE a.selected_date_id IS NULL";
  return (db.prepare(`SELECT count(*) AS n ${ARTIFACT_FROM} ${where}`).get(params) as { n: number })
    .n;
}

/* Calendar and heatmap */

export interface DayCount {
  day: string;
  artifacts: number;
  /** Of those, artifacts whose date is estimated or read from the file. */
  uncertainArtifacts: number;
  /** Events starting that day, or whose window starts that day. Each event counts once. */
  events: number;
  estimatedEvents: number;
}

export interface DayCounts {
  fromDay: string;
  toDay: string;
  days: DayCount[];
  undated: number;
}

export function dayCounts(
  context: ArchivistContext,
  actor: Actor,
  input: {
    archiveId: unknown;
    fromDay: string;
    toDay: string;
    filters: ArtifactFilters;
    eventFilters: EventFilters;
  },
): DayCounts {
  const { store } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  const filters = { ...input.filters, fromDay: input.fromDay, toDay: input.toDay };
  const { sql, params } = artifactWhere(filters);
  const counts = new Map<string, DayCount>();
  const at = (day: string) => {
    const entry = counts.get(day) ?? {
      day,
      artifacts: 0,
      uncertainArtifacts: 0,
      events: 0,
      estimatedEvents: 0,
    };
    counts.set(day, entry);
    return entry;
  };
  const artifactRows = db
    .prepare(
      `SELECT d.archive_day AS day, count(*) AS n, sum(a.selected_date_id <> a.exact_date_id OR a.exact_date_id IS NULL) AS uncertain
       ${ARTIFACT_FROM} ${sql} GROUP BY d.archive_day`,
    )
    .all(params) as { day: string; n: number; uncertain: number }[];
  for (const row of artifactRows) {
    const entry = at(row.day);
    entry.artifacts = row.n;
    entry.uncertainArtifacts = row.uncertain;
  }
  const { clauses, params: eventParams } = eventWhere({
    ...input.eventFilters,
    fromDay: null,
    toDay: null,
  });
  const eventRows = db
    .prepare(
      `SELECT s.archive_day AS day, count(*) AS n, sum(e.certainty = 'estimated') AS estimated
       FROM events e JOIN date_values s ON s.id = e.start_date_id LEFT JOIN date_values f ON f.id = e.end_date_id
       WHERE s.archive_day BETWEEN @countFrom AND @countTo ${clauses.length ? `AND ${clauses.join(" AND ")}` : ""}
       GROUP BY s.archive_day`,
    )
    .all({ ...eventParams, countFrom: input.fromDay, countTo: input.toDay }) as {
    day: string;
    n: number;
    estimated: number;
  }[];
  for (const row of eventRows) {
    const entry = at(row.day);
    entry.events = row.n;
    entry.estimatedEvents = row.estimated;
  }
  return {
    fromDay: input.fromDay,
    toDay: input.toDay,
    days: [...counts.values()].sort((a, b) => a.day.localeCompare(b.day)),
    undated: undatedCount(db, input.filters),
  };
}

/** The days of a year, `2020`, or of a month, `2020-07`. */
export function periodDays(
  value: unknown,
  kind: "year" | "month",
): { fromDay: string; toDay: string } {
  const text = typeof value === "string" ? value : "";
  if (kind === "year") {
    if (!/^\d{4}$/.test(text)) throw invalid("year", "Give a year such as 2020.");
    return { fromDay: `${text}-01-01`, toDay: `${text}-12-31` };
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text))
    throw invalid("month", "Give a month such as 2020-07.");
  const fromDay = `${text}-01`;
  return { fromDay, toDay: bucketEnd(fromDay, "month") };
}

/* Graph */

export interface GraphView {
  nodes: { id: string; knownName: string; picture: Picture }[];
  /** Pairs who share artifacts, each counted once per artifact. */
  artifacts: { a: string; b: string; count: number }[];
  /** Pairs who share events, each counted once per event. */
  events: { a: string; b: string; count: number }[];
  /** Who introduced whom. */
  introductions: { from: string; to: string; day: string | null }[];
  /** Pairs who were members of the same servers at the same time, counted in servers. */
  memberships: { a: string; b: string; count: number }[];
}

export function graphView(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; filters: ArtifactFilters; eventFilters: EventFilters },
): GraphView {
  const { store } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  const nodes = (
    db
      .prepare("SELECT id, known_name AS knownName FROM characters ORDER BY known_name, id")
      .all() as {
      id: string;
      knownName: string;
    }[]
  ).map((node) => ({ ...node, picture: characterPictureAt(db, node.id) }));

  const { sql, params } = artifactWhere(input.filters);
  const artifacts = db
    .prepare(
      `SELECT x.character_id AS a, y.character_id AS b, count(*) AS count
       FROM artifact_characters x JOIN artifact_characters y ON y.artifact_id = x.artifact_id AND x.character_id < y.character_id
       WHERE x.artifact_id IN (SELECT a.id ${ARTIFACT_FROM} ${sql})
       GROUP BY x.character_id, y.character_id ORDER BY count DESC, a, b`,
    )
    .all(params) as GraphView["artifacts"];

  const { clauses, params: eventParams } = eventWhere(input.eventFilters);
  const events = db
    .prepare(
      `SELECT x.character_id AS a, y.character_id AS b, count(*) AS count
       FROM event_characters x JOIN event_characters y ON y.event_id = x.event_id AND x.character_id < y.character_id
       WHERE x.event_id IN (SELECT e.id FROM events e JOIN date_values s ON s.id = e.start_date_id
         LEFT JOIN date_values f ON f.id = e.end_date_id ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""})
       GROUP BY x.character_id, y.character_id ORDER BY count DESC, a, b`,
    )
    .all(eventParams) as GraphView["events"];

  const introductions = db
    .prepare(
      `SELECT i.introducer_id AS "from", i.introduced_id AS "to", d.archive_day AS day
       FROM introductions i LEFT JOIN date_values d ON d.id = i.date_id ORDER BY d.archive_day, i.id`,
    )
    .all() as GraphView["introductions"];

  return { nodes, artifacts, events, introductions, memberships: membershipOverlaps(db) };
}

/**
 * Pairs with overlapping memberships in the same server, counted in servers.
 * Accounts count as their character. A membership with no join date is left
 * out, because when it started is unknown; one with no leave date continues.
 */
function membershipOverlaps(db: Database.Database): GraphView["memberships"] {
  const rows = db
    .prepare(
      `SELECT a.character_id AS character, m.server_id AS server, j.archive_day AS joined, l.archive_day AS "left"
       FROM memberships m JOIN accounts a ON a.id = m.account_id
       JOIN date_values j ON j.id = m.joined_date_id LEFT JOIN date_values l ON l.id = m.left_date_id
       WHERE a.character_id IS NOT NULL`,
    )
    .all() as { character: string; server: string; joined: string; left: string | null }[];
  const byServer = new Map<string, typeof rows>();
  for (const row of rows) byServer.set(row.server, [...(byServer.get(row.server) ?? []), row]);
  const pairs = new Map<string, Set<string>>();
  for (const [server, members] of byServer) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const x = members[i]!;
        const y = members[j]!;
        if (x.character === y.character) continue;
        const overlap =
          x.joined <= (y.left ?? "9999-12-31") && y.joined <= (x.left ?? "9999-12-31");
        if (!overlap) continue;
        const key =
          x.character < y.character
            ? `${x.character}|${y.character}`
            : `${y.character}|${x.character}`;
        pairs.set(key, (pairs.get(key) ?? new Set()).add(server));
      }
    }
  }
  return [...pairs]
    .map(([key, servers]) => {
      const [a, b] = key.split("|") as [string, string];
      return { a, b, count: servers.size };
    })
    .sort((x, y) => y.count - x.count || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
}
