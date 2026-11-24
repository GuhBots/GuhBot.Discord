import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  api,
  type ArtifactPage,
  mediaUrl,
  query,
  type TimelineLane,
  type TimelineView as Timeline,
} from "../api.js";
import { dayNumber, dayOfNumber, dayText, initials, MONTHS, monthText } from "../format.js";
import { AddArtifactModal } from "../modals/AddArtifactModal.js";
import { EventFormModal } from "../modals/EventModal.js";
import { FiltersModal } from "../modals/FiltersModal.js";
import { characterPath, navigate } from "../router.js";
import { useSettled, useWindows } from "../Shell.js";
import { filterCount, filterQuery, loadLocal, saveLocal, useArchive } from "../state.js";
import { Modal } from "../ui.js";
import { ViewFrame } from "./ViewFrame.js";

/**
 * The horizontal timeline, drawn as the approved prototype draws it: lanes
 * for the main server, other servers, group chats, and Unassigned, with
 * activity stretches, shaded dots, arrows for one-day events and server
 * changes, an optional row of character pictures, the event band, and the
 * calendar ruler. Lane order and hidden lanes belong to this browser.
 */

type Zoom = "day" | "month" | "year";
const ZOOMS: Record<Zoom, { ppd: number; bucket: "day" | "week" | "month"; label: string }> = {
  day: { ppd: 26, bucket: "day", label: "Day" },
  month: { ppd: 3.2, bucket: "week", label: "Month" },
  year: { ppd: 0.7, bucket: "month", label: "Year" },
};
const ZOOM_ORDER: Zoom[] = ["day", "month", "year"];
const MAX_SPAN_DAYS = 366 * 60 - 1;

type Layers = { server: boolean; names: boolean; avatars: boolean; mains: boolean };
const DEFAULT_LAYERS: Layers = { server: true, names: false, avatars: false, mains: false };
type LanePrefs = { order: string[]; hidden: string[] };

function latestAt<T extends { day: string | null }>(list: T[], day: string): T | null {
  let best: T | null = null;
  for (const item of list)
    if (item.day && item.day <= day && (!best || item.day >= best.day!)) best = item;
  return best;
}

function laneName(lane: TimelineLane, day: string): string {
  return latestAt(lane.names, day)?.name ?? lane.label;
}

function laneIcon(lane: TimelineLane, day: string): string | null {
  return (
    latestAt(lane.icons, day)?.mediaId ??
    lane.icons.find((icon) => icon.day === null)?.mediaId ??
    null
  );
}

const textWidth = (text: string, px = 6.7) => text.length * px;

export function TimelineView() {
  const { archive, filters, revision, position, setPosition } = useArchive();
  const windows = useWindows();
  const key = (name: string) => `archivist:${name}:${archive.archiveId}`;
  const [zoom, setZoomState] = useState<Zoom>(() => loadLocal(key("zoom"), "month"));
  const [center, setCenter] = useState(() => dayNumber(position));
  const [layers, setLayers] = useState<Layers>(() => loadLocal(key("layers"), DEFAULT_LAYERS));
  const [prefs, setPrefs] = useState<LanePrefs>(() =>
    loadLocal(key("lanes"), { order: [], hidden: [] }),
  );
  const [data, setData] = useState<Timeline | null>(null);
  const [loaded, setLoaded] = useState<{
    from: number;
    to: number;
    zoom: Zoom;
    filters: string;
    revision: number;
  } | null>(null);
  const [size, setSize] = useState({ width: 800, height: 520 });
  const [popover, setPopover] = useState<{
    kind: "layers" | "lanes";
    left: number;
    bottom: number;
  } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const pan = useRef<{ x: number; center: number; id: number; moved: boolean } | null>(null);
  const moved = useRef(false);
  const laneDrag = useRef<{ id: string; y: number; index: number } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const zoomAcc = useRef(0);
  const { ppd, bucket } = ZOOMS[zoom];
  const filterKey = JSON.stringify(filterQuery(filters));

  const setZoom = useCallback(
    (next: Zoom) => {
      setZoomState(next);
      saveLocal(`archivist:zoom:${archive.archiveId}`, next);
    },
    [archive.archiveId],
  );

  // The calendar and "Show on timeline" move the timeline from elsewhere.
  useEffect(() => {
    const jump = (event: Event) => {
      const detail = (event as CustomEvent<{ day: string; zoom?: Zoom }>).detail;
      setCenter(dayNumber(detail.day));
      if (detail.zoom) setZoom(detail.zoom);
    };
    window.addEventListener("archivist:jump", jump);
    return () => window.removeEventListener("archivist:jump", jump);
  }, [setZoom]);

  useLayoutEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const view = element.closest(".view") as HTMLElement | null;
    const measure = () => {
      const head = view?.querySelector(".view-head") as HTMLElement | null;
      setSize({
        width: Math.max(element.clientWidth, 320),
        height: Math.max((view?.clientHeight ?? 520) - (head?.offsetHeight ?? 0) - 4, 240),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (view) observer.observe(view);
    return () => observer.disconnect();
  }, []);

  const centerDay = dayOfNumber(center);
  const settledCenter = useSettled(center, 150);
  useEffect(() => setPosition(dayOfNumber(settledCenter)), [settledCenter, setPosition]);

  const LABEL_W = size.width < 600 ? 112 : 168;
  const halfDays = (size.width - LABEL_W) / 2 / ppd;

  // Data covers three screens around the center, and reloads when the view leaves it.
  useEffect(() => {
    const from = settledCenter - halfDays;
    const to = settledCenter + halfDays;
    if (
      loaded &&
      loaded.zoom === zoom &&
      loaded.filters === filterKey &&
      loaded.revision === revision &&
      from >= loaded.from &&
      to <= loaded.to
    ) {
      return;
    }
    const span = Math.min(halfDays * 6, MAX_SPAN_DAYS);
    const loadFrom = Math.floor(settledCenter - span / 2);
    const loadTo = Math.floor(loadFrom + span);
    const controller = new AbortController();
    api<Timeline>(
      `/api/archives/${archive.archiveId}/timeline${query({
        ...filterQuery(filters),
        fromDay: dayOfNumber(loadFrom),
        toDay: dayOfNumber(loadTo),
        bucket: ZOOMS[zoom].bucket,
      })}`,
      { signal: controller.signal },
    )
      .then((result) => {
        setData(result);
        setLoaded({ from: loadFrom, to: loadTo, zoom, filters: filterKey, revision });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [archive.archiveId, settledCenter, halfDays, zoom, filterKey, revision, loaded, filters]);

  const lanes = useMemo(() => {
    if (!data) return [];
    const known = prefs.order
      .map((id) => data.lanes.find((lane) => lane.id === id))
      .filter(Boolean) as TimelineLane[];
    return [...known, ...data.lanes.filter((lane) => !known.includes(lane))];
  }, [data, prefs.order]);
  const visible = lanes.filter((lane) => !prefs.hidden.includes(lane.id));

  const savePrefs = (next: LanePrefs) => {
    setPrefs(next);
    saveLocal(key("lanes"), next);
  };
  const moveLane = (id: string, to: number) => {
    const ids = visible.map((lane) => lane.id);
    const from = ids.indexOf(id);
    if (from === -1 || to < 0 || to >= ids.length || to === from) return false;
    const all = lanes.map((lane) => lane.id).filter((x) => x !== id);
    const rest = ids.filter((x) => x !== id);
    const anchor = rest[to];
    all.splice(anchor === undefined ? all.length : all.indexOf(anchor), 0, id);
    savePrefs({ ...prefs, order: all });
    return true;
  };
  const hideLane = (id: string, hide: boolean) => {
    if (hide && visible.length <= 1) return;
    savePrefs({
      ...prefs,
      hidden: hide ? [...prefs.hidden, id] : prefs.hidden.filter((x) => x !== id),
    });
  };

  // Wheel: a mouse wheel or sideways swipe moves through time; Ctrl or a pinch zooms.
  useEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        zoomAcc.current += event.deltaY;
        if (Math.abs(zoomAcc.current) >= 80) {
          const next = ZOOM_ORDER[ZOOM_ORDER.indexOf(zoom) + (zoomAcc.current > 0 ? 1 : -1)];
          zoomAcc.current = 0;
          if (next) setZoom(next);
        }
        return;
      }
      const raw = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const px = event.deltaMode === 1 ? raw * 20 : event.deltaMode === 2 ? raw * 400 : raw;
      setCenter((value) => value + px / ppd);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [ppd, zoom, setZoom]);

  const { width, height: available } = size;
  const markerKinds = new Set(
    [
      layers.names && "account_name",
      layers.avatars && "avatar",
      layers.mains && "main_account",
    ].filter(Boolean) as string[],
  );
  const markerRow = markerKinds.size > 0;
  const x = (day: number) => LABEL_W + (width - LABEL_W) / 2 + (day - center) * ppd;

  // Ranged events in parallel rows, so neither strips nor their labels overlap at this zoom.
  const placed: { event: Timeline["band"][number]; row: number }[] = [];
  const rows: number[] = [];
  for (const event of data?.band ?? []) {
    const left = dayNumber(event.start) * ppd;
    const right = Math.max((dayNumber(event.end) + 1) * ppd, left + textWidth(event.title) + 24);
    let row = rows.findIndex((end) => end < left - 6);
    if (row === -1) {
      rows.push(right);
      row = rows.length - 1;
    } else rows[row] = right;
    placed.push({ event, row });
  }
  const bandH = Math.max(rows.length, 1) * 24 + 18;
  const fixed = 8 + (markerRow ? 40 : 6) + 6 + bandH + 6 + 48;
  const LANE_H = Math.max(
    64,
    Math.min(80, Math.floor((available - fixed) / Math.max(visible.length, 1))),
  );
  const top = 8;
  const markerTop = top + visible.length * LANE_H + 6;
  const bandTop = markerTop + (markerRow ? 34 : 0) + 6;
  const rulerTop = bandTop + bandH + 6;
  const height = rulerTop + 48;
  const mainIndex = visible.findIndex((lane) => lane.isMain);

  const openGallery = async (laneId: string, start: string, end: string, label: string) => {
    const page = await api<ArtifactPage>(
      `/api/archives/${archive.archiveId}/artifacts${query({ ...filterQuery(filters), lane: laneId, fromDay: start, toDay: end, sort: "oldest", limit: 100 })}`,
    );
    const ids = page.items.map((item) => item.id);
    if (ids.length) windows.openArtifact(ids[0]!, { ids, index: 0, title: label });
  };
  const periodLabel = (start: string) =>
    bucket === "day"
      ? dayText(start)
      : bucket === "week"
        ? `Week of ${dayText(start)}`
        : monthText(start);
  const click = (action: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!moved.current) action();
  };
  const keyed = (action: () => void) => (event: React.KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  };

  const content: ReactNode[] = [];
  visible.forEach((lane, i) => {
    const y0 = top + i * LANE_H;
    const lineY = y0 + LANE_H - 14;
    content.push(
      <line
        key={`sep-${lane.id}`}
        className="lane-sep"
        pointerEvents="none"
        x1={LABEL_W}
        x2={width}
        y1={y0 + LANE_H}
        y2={y0 + LANE_H}
        opacity={0.4}
      />,
    );
    for (const segment of lane.segments) {
      const x1 = x(dayNumber(segment.start)) - 6;
      const x2 = Math.max(x(dayNumber(segment.end)) + 6, x1 + 12);
      if (x2 < LABEL_W || x1 > width) continue;
      content.push(
        <line
          key={`seg-${lane.id}-${segment.start}`}
          x1={x1}
          x2={x2}
          y1={lineY}
          y2={lineY}
          stroke={lane.color}
          strokeWidth={5}
          strokeDasharray={segment.uncertain ? "10 7" : undefined}
          strokeLinecap="round"
        />,
      );
      if (!lane.isMain && lane.kind !== "unassigned" && mainIndex !== -1) {
        // A branch from the main lane where this lane appears. It does not assert ancestry.
        const mainY = top + mainIndex * LANE_H + LANE_H - 14;
        content.push(
          <path
            key={`branch-${lane.id}-${segment.start}`}
            d={`M${x1 - 18} ${mainY} C ${x1 - 6} ${mainY}, ${x1 - 14} ${lineY}, ${x1} ${lineY}`}
            fill="none"
            stroke={lane.color}
            strokeWidth={2}
            strokeDasharray="4 5"
            opacity={0.55}
          />,
        );
      }
    }
    for (const dot of lane.dots) {
      const cx = x((dayNumber(dot.start) + dayNumber(dot.end)) / 2);
      if (cx < LABEL_W - 10 || cx > width + 10) continue;
      const tier = dot.count >= 7 ? 4 : dot.count >= 4 ? 3 : dot.count >= 2 ? 2 : 1;
      const label = `${dot.count} artifact${dot.count > 1 ? "s" : ""}, ${periodLabel(dot.start)}${dot.uncertain ? ", some dates uncertain" : ""}`;
      const open = () => void openGallery(lane.id, dot.start, dot.end, periodLabel(dot.start));
      content.push(
        <g
          key={`dot-${lane.id}-${dot.start}`}
          className="dot"
          tabIndex={0}
          role="button"
          aria-label={label}
          onClick={click(open)}
          onKeyDown={keyed(open)}
        >
          <circle
            cx={cx}
            cy={lineY - 16}
            r={8}
            fill={`var(--dot-${tier})`}
            stroke={dot.uncertain ? "#f2f3f5" : "#111214"}
            strokeWidth={dot.uncertain ? 1.5 : 1}
            strokeDasharray={dot.uncertain ? "2.5 2" : undefined}
          />
          {dot.count > 1 ? (
            <text
              className="t-dark"
              x={cx}
              y={lineY - 12.5}
              textAnchor="middle"
              fill={tier >= 3 ? "#f2f3f5" : "#111214"}
            >
              {dot.count > 9 ? "9+" : dot.count}
            </text>
          ) : null}
          <title>{`${label}. Open the gallery.`}</title>
        </g>,
      );
    }
    // Arrows: one-day events in red, and server name or icon changes in yellow.
    const arrows = lane.arrows.filter((arrow) => arrow.kind === "event" || layers.server);
    const groups = new Map<string, typeof arrows>();
    for (const arrow of arrows) {
      const day = arrow.day;
      const start =
        bucket === "day"
          ? day
          : bucket === "month"
            ? `${day.slice(0, 7)}-01`
            : dayOfNumber(dayNumber(day) - ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
      const groupKey = `${start}|${arrow.kind === "event" ? "event" : "change"}`;
      groups.set(groupKey, [...(groups.get(groupKey) ?? []), arrow]);
    }
    const ordered = [...groups.values()].sort((a, b) => a[0]!.day.localeCompare(b[0]!.day));
    const shaftTop = y0 + 6;
    const tipY = lineY - 26;
    ordered.forEach((group, gi) => {
      const first = group[0]!;
      const ax = x(dayNumber(first.day));
      if (ax < LABEL_W - 40 || ax > width + 40) return;
      const isEvent = first.kind === "event";
      const color = isEvent ? "var(--event)" : "var(--marker)";
      const many = group.length > 1 ? `${group.length} ${isEvent ? "events" : "changes"}` : null;
      const text =
        many ??
        (first.kind === "event"
          ? first.title
          : first.kind === "name"
            ? `Renamed to ${first.name}`
            : "New icon");
      const next = ordered[gi + 1] ? x(dayNumber(ordered[gi + 1]![0]!.day)) : Infinity;
      let tx = ax + 8;
      const iconMedia = !many && first.kind === "icon" ? first.mediaId : null;
      const iconRoom = iconMedia && next - tx > 20;
      if (iconRoom) tx += 16;
      const fits = Math.min(30, Math.floor((next - tx - 10) / 6.7));
      const estimated = first.kind === "event" && first.estimated;
      const open = () => {
        if (many) windows.show(<ArrowList group={group} />);
        else if (first.kind === "event") windows.openEvent(first.id);
        else windows.show(<ChangeNote lane={lane} change={first} />);
      };
      content.push(
        <g
          key={`arrow-${lane.id}-${first.day}-${isEvent}`}
          className="arrow"
          tabIndex={0}
          role="button"
          aria-label={text}
          onClick={click(open)}
          onKeyDown={keyed(open)}
        >
          <rect x={ax - 9} y={shaftTop} width={18} height={tipY - shaftTop} fill="transparent" />
          <path
            d={`M${ax - 3} ${shaftTop} h6 V${tipY - 8} h5 L${ax} ${tipY} L${ax - 8} ${tipY - 8} h5 Z`}
            fill={color}
            stroke={estimated ? "#f2f3f5" : "none"}
            strokeDasharray={estimated ? "2 2" : undefined}
          />
          {iconRoom ? (
            <>
              <clipPath id={`clip-${lane.id}-${first.day}`}>
                <circle cx={ax + 14} cy={y0 + 11} r={6} />
              </clipPath>
              <image
                href={mediaUrl(archive.archiveId, iconMedia!)}
                x={ax + 8}
                y={y0 + 5}
                width={12}
                height={12}
                clipPath={`url(#clip-${lane.id}-${first.day})`}
              />
            </>
          ) : null}
          {fits >= 5 ? (
            <text className="t-event" x={tx} y={y0 + 15}>
              {text.length > fits ? `${text.slice(0, fits - 1)}…` : text}
            </text>
          ) : null}
          <title>
            {group
              .map((item) =>
                item.kind === "event"
                  ? item.title
                  : item.kind === "name"
                    ? `Renamed to ${item.name}`
                    : "New icon",
              )
              .join("\n")}
          </title>
        </g>,
      );
    });
  });

  // Character changes as pictures only; the words are in the tooltip.
  if (markerRow && data) {
    content.push(
      <line
        key="marker-sep"
        className="lane-sep"
        pointerEvents="none"
        x1={LABEL_W}
        x2={width}
        y1={markerTop + 30}
        y2={markerTop + 30}
        opacity={0.4}
      />,
    );
    let lastX = -Infinity;
    let stack = 0;
    for (const marker of data.markers.filter((m) => markerKinds.has(m.kind))) {
      const mx = x(dayNumber(marker.day));
      if (mx < LABEL_W - 12 || mx > width + 12) continue;
      stack = mx - lastX < 16 ? stack + 1 : 0;
      lastX = mx;
      const cx = mx + stack * 7;
      const cy = markerTop + 15;
      const mediaId = "mediaId" in marker.picture ? marker.picture.mediaId : null;
      const what =
        marker.kind === "account_name"
          ? `renamed to ${marker.name}`
          : marker.kind === "avatar"
            ? "new avatar"
            : "new main account";
      const open = () => navigate(characterPath(archive.archiveId, marker.characterId));
      const clip = `marker-${marker.kind}-${marker.accountId}-${marker.day}`;
      content.push(
        <g
          key={clip}
          className="dot"
          tabIndex={0}
          role="button"
          aria-label={`${what}, ${dayText(marker.day)}`}
          onClick={click(open)}
          onKeyDown={keyed(open)}
        >
          <circle cx={cx} cy={cy} r={11} fill="#4e5058" stroke="#111214" strokeWidth={2} />
          {mediaId ? (
            <>
              <clipPath id={clip}>
                <circle cx={cx} cy={cy} r={10} />
              </clipPath>
              <image
                href={mediaUrl(archive.archiveId, mediaId)}
                x={cx - 10}
                y={cy - 10}
                width={20}
                height={20}
                clipPath={`url(#${clip})`}
              />
            </>
          ) : null}
          <title>{`${what}, ${dayText(marker.day)}`}</title>
        </g>,
      );
    }
  }

  // The event band.
  content.push(
    <rect
      key="band"
      x={LABEL_W}
      y={bandTop}
      width={width - LABEL_W}
      height={bandH}
      fill="#2b2d31"
    />,
  );
  for (const { event, row } of placed) {
    const x1 = x(dayNumber(event.start));
    const x2 = x(dayNumber(event.end) + 1);
    if (x2 < LABEL_W || x1 > width) continue;
    const y = bandTop + 9 + row * 24;
    const isWindow = event.dateKind === "occurrence_window";
    const label = event.title + (event.estimated ? " (est.)" : "");
    const tx = Math.max(x1 + 6, LABEL_W + 6);
    const inside = x2 - tx > textWidth(label, 6.8) + 6;
    const open = () => windows.openEvent(event.id);
    content.push(
      <g
        key={`strip-${event.id}`}
        className="strip"
        tabIndex={0}
        role="button"
        aria-label={`${event.title}, ${isWindow ? "happened sometime" : "lasted"} ${dayText(event.start)} to ${dayText(event.end)}`}
        onClick={click(open)}
        onKeyDown={keyed(open)}
      >
        <rect
          x={x1}
          y={y}
          width={Math.max(x2 - x1, 4)}
          height={18}
          rx={3}
          fill={event.color}
          fillOpacity={isWindow ? 0.22 : 0.9}
          stroke={event.color}
          strokeWidth={isWindow ? 2 : 0}
          strokeDasharray={isWindow ? "6 4" : undefined}
        />
        <text
          x={inside ? tx : Math.max(x1, LABEL_W) + 6}
          y={y + 13}
          fontSize={11}
          fontWeight={700}
          fill={isWindow || !inside ? "#f2f3f5" : "#111214"}
        >
          {label}
        </text>
      </g>,
    );
  }

  // The calendar ruler.
  content.push(
    <line
      key="ruler"
      x1={LABEL_W}
      x2={width}
      y1={rulerTop + 6}
      y2={rulerTop + 6}
      stroke="#b5bac1"
      strokeWidth={2}
    />,
  );
  for (let d = Math.floor(center - halfDays - 2); d <= Math.ceil(center + halfDays + 2); d++) {
    const date = new Date(d * 86_400_000);
    const first = date.getUTCDate() === 1;
    let tick = 0;
    let text: string | null = null;
    if (zoom === "day") {
      tick = first ? 12 : 5;
      if (ppd >= 20 && date.getUTCDay() === 1)
        text = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
      if (first) text = monthText(dayOfNumber(d));
    } else if (zoom === "month") {
      if (first) {
        tick = 12;
        text =
          date.getUTCMonth() === 0 ? String(date.getUTCFullYear()) : MONTHS[date.getUTCMonth()]!;
      } else if (date.getUTCDay() === 1) tick = 4;
    } else if (first) {
      tick = date.getUTCMonth() === 0 ? 14 : 6;
      if (date.getUTCMonth() === 0) text = String(date.getUTCFullYear());
      else if (date.getUTCMonth() % 3 === 0) text = MONTHS[date.getUTCMonth()]!;
    }
    if (!tick) continue;
    const tx = x(d);
    content.push(
      <line
        key={`tick-${d}`}
        x1={tx}
        x2={tx}
        y1={rulerTop + 6}
        y2={rulerTop + 6 + tick}
        stroke="#b5bac1"
        strokeWidth={1}
      />,
    );
    if (text) {
      content.push(
        <text key={`label-${d}`} className="t-sub" x={tx + 3} y={rulerTop + 34}>
          {text}
        </text>,
      );
    }
  }
  const cx = x(center);
  content.push(
    <line
      key="center"
      x1={cx}
      x2={cx}
      y1={0}
      y2={rulerTop + 6}
      stroke="#c9cdfb"
      strokeWidth={1}
      strokeDasharray="2 4"
      pointerEvents="none"
      opacity={0.6}
    />,
  );

  // The lane labels on the left, with a grip to reorder and an eye to hide.
  const labels: ReactNode[] = [
    <rect key="bg" className="lane-bg" x={0} y={0} width={LABEL_W} height={height} />,
    <line
      key="edge"
      className="lane-sep"
      pointerEvents="none"
      x1={LABEL_W}
      x2={LABEL_W}
      y1={0}
      y2={height}
    />,
  ];
  const withEye = LABEL_W >= 150;
  visible.forEach((lane, i) => {
    const y0 = top + i * LANE_H;
    const cy = y0 + LANE_H - 30;
    const name = laneName(lane, centerDay);
    const icon = laneIcon(lane, centerDay);
    const room = Math.max(4, Math.floor((LABEL_W - 60) / 8));
    labels.push(
      <g key={`label-${lane.id}`}>
        {dragging === lane.id ? (
          <rect x={0} y={y0} width={LABEL_W} height={LANE_H} fill="rgba(88,101,242,0.22)" />
        ) : null}
        <g
          className="grip"
          tabIndex={0}
          role="button"
          data-lane={lane.id}
          aria-label={`Move ${name}. Drag it, or press the up and down arrow keys.`}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            (event.currentTarget as Element).setPointerCapture(event.pointerId);
            laneDrag.current = { id: lane.id, y: event.clientY, index: i };
            setDragging(lane.id);
          }}
          onPointerMove={(event) => {
            const drag = laneDrag.current;
            if (!drag) return;
            const steps = Math.round((event.clientY - drag.y) / LANE_H);
            if (!steps) return;
            const to = Math.max(0, Math.min(visible.length - 1, drag.index + steps));
            if (to !== drag.index && moveLane(drag.id, to)) {
              drag.y += (to - drag.index) * LANE_H;
              drag.index = to;
            }
          }}
          onPointerUp={() => {
            laneDrag.current = null;
            setDragging(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            event.stopPropagation();
            moveLane(lane.id, i + (event.key === "ArrowUp" ? -1 : 1));
          }}
        >
          <rect x={0} y={y0 + 4} width={16} height={LANE_H - 8} fill="transparent" />
          {[-6, 0, 6].flatMap((dy) =>
            [5, 11].map((dx) => (
              <circle key={`${dx}-${dy}`} cx={dx} cy={cy + dy} r={1.7} fill="#80848e" />
            )),
          )}
          <title>Drag to move this lane</title>
        </g>
        <circle cx={32} cy={cy} r={14} fill={lane.color} />
        {icon ? (
          <>
            <clipPath id={`lane-icon-${lane.id}`}>
              <circle cx={32} cy={cy} r={14} />
            </clipPath>
            <image
              href={mediaUrl(archive.archiveId, icon)}
              x={18}
              y={cy - 14}
              width={28}
              height={28}
              clipPath={`url(#lane-icon-${lane.id})`}
            />
          </>
        ) : (
          <text className="t-dark" x={32} y={cy + 3.5} textAnchor="middle">
            {lane.kind === "unassigned" ? "?" : initials(name)}
          </text>
        )}
        <text className="t-lane" x={52} y={y0 + LANE_H - 32}>
          {name.length > room ? `${name.slice(0, room - 1)}…` : name}
        </text>
        <text className="t-faint" x={52} y={y0 + LANE_H - 18}>
          {lane.isMain
            ? "main server"
            : lane.kind === "unassigned"
              ? "DMs and unknown"
              : lane.kind === "group_chat"
                ? "group chat"
                : "server"}
        </text>
        {withEye ? (
          <g
            className="lane-toggle"
            tabIndex={0}
            role="button"
            aria-label={`Hide ${name} from the timeline`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              hideLane(lane.id, true);
            }}
            onKeyDown={keyed(() => hideLane(lane.id, true))}
          >
            <rect x={LABEL_W - 26} y={y0 + 4} width={22} height={20} fill="transparent" />
            <ellipse
              cx={LABEL_W - 15}
              cy={y0 + 14}
              rx={7}
              ry={4.5}
              fill="none"
              stroke="#80848e"
              strokeWidth={1.4}
            />
            <circle
              cx={LABEL_W - 15}
              cy={y0 + 14}
              r={1.8}
              fill="none"
              stroke="#80848e"
              strokeWidth={1.4}
            />
            <title>Hide this lane. Show it again from Lanes in the tray.</title>
          </g>
        ) : null}
      </g>,
    );
  });
  if (markerRow)
    labels.push(
      <text key="marker-label" className="t-sub" x={10} y={markerTop + 20}>
        Character changes
      </text>,
    );
  labels.push(
    <g key="band-label">
      <text className="t-sub" x={10} y={bandTop + 16}>
        Events
      </text>
      <text className="t-faint" x={10} y={bandTop + 30}>
        solid: lasted
      </text>
      <text className="t-faint" x={10} y={bandTop + 43}>
        dashed: sometime in
      </text>
    </g>,
    <text key="zoom-label" className="t-sub" x={10} y={rulerTop + 34}>
      {ZOOMS[zoom].label} zoom
    </text>,
  );

  const openPopover =
    (kind: "layers" | "lanes") => (event: React.MouseEvent<HTMLButtonElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setPopover(
        popover?.kind === kind
          ? null
          : { kind, left: rect.left, bottom: window.innerHeight - rect.top + 8 },
      );
    };
  const hiddenCount = prefs.hidden.filter((id) => lanes.some((lane) => lane.id === id)).length;

  return (
    <ViewFrame
      label="Timeline"
      head={
        <>
          <h1>Timeline</h1>
          <span className="meta">Position: {dayText(centerDay)}</span>
          {data?.undated ? (
            <button
              className="linkish"
              type="button"
              onClick={async () => {
                const page = await api<ArtifactPage>(
                  `/api/archives/${archive.archiveId}/artifacts${query({ ...filterQuery(filters), basis: "undated", limit: 100 })}`,
                );
                const ids = page.items.map((item) => item.id);
                if (ids.length) windows.openArtifact(ids[0]!, { ids, index: 0, title: "Undated" });
              }}
            >
              {data.undated} undated
            </button>
          ) : null}
          {hiddenCount ? (
            <button className="linkish" type="button" onClick={openPopover("lanes")}>
              {hiddenCount} hidden lane{hiddenCount > 1 ? "s" : ""}
            </button>
          ) : null}
          <span className="meta">Drag or scroll to move. Ctrl + scroll zooms.</span>
          {filterCount(filters) ? <span className="meta">Filtered</span> : null}
        </>
      }
      tray={
        <>
          <span className="label">Zoom</span>
          <div className="seg" role="group" aria-label="Zoom">
            {ZOOM_ORDER.map((z) => (
              <button
                key={z}
                className="btn"
                type="button"
                aria-pressed={zoom === z}
                onClick={() => setZoom(z)}
              >
                {ZOOMS[z].label}
              </button>
            ))}
          </div>
          <button
            className="btn"
            type="button"
            title="Earlier"
            aria-label="Earlier"
            onClick={() => setCenter(center - 300 / ppd)}
          >
            ◀
          </button>
          <button
            className="btn"
            type="button"
            title="Later"
            aria-label="Later"
            onClick={() => setCenter(center + 300 / ppd)}
          >
            ▶
          </button>
          <span className="sep" />
          <button className="btn" type="button" onClick={() => windows.show(<FiltersModal />)}>
            Filters{filterCount(filters) ? ` (${filterCount(filters)})` : ""}
          </button>
          <button className="btn" type="button" onClick={openPopover("layers")}>
            Layers
          </button>
          <button className="btn" type="button" onClick={openPopover("lanes")}>
            Lanes{hiddenCount ? ` (${hiddenCount} hidden)` : ""}
          </button>
          <span className="sep" />
          <button
            className="btn primary"
            type="button"
            onClick={() => windows.show(<AddArtifactModal />)}
          >
            Add artifact
          </button>
          <button className="btn" type="button" onClick={() => windows.show(<EventFormModal />)}>
            Add event
          </button>
          <span className="sep" />
          <span className="legend">
            <i style={{ background: "var(--dot-1)" }} />1
            <i style={{ background: "var(--dot-2)" }} />
            2-3
            <i style={{ background: "var(--dot-3)" }} />
            4-6
            <i style={{ background: "var(--dot-4)" }} />
            7+
            <i className="est" />
            some dates uncertain
          </span>
          <span className="legend">
            <b className="arw" style={{ color: "var(--event)" }}>
              ▼
            </b>
            one-day event
            <b className="arw" style={{ color: "var(--marker)" }}>
              ▼
            </b>
            server renamed or new icon
          </span>
          {popover ? (
            <div
              className="popover"
              style={{ left: popover.left, bottom: popover.bottom }}
              role="dialog"
              aria-label={popover.kind === "layers" ? "Marker layers" : "Lanes"}
            >
              {popover.kind === "layers" ? (
                <>
                  <strong style={{ fontSize: 14 }}>Marker layers</strong>
                  {(
                    [
                      ["server", "Server name and icon changes (yellow arrows)"],
                      ["names", "Account name changes"],
                      ["avatars", "Avatar changes"],
                      ["mains", "Main-account changes"],
                    ] as [keyof Layers, string][]
                  ).map(([layer, label]) => (
                    <label key={layer}>
                      <input
                        type="checkbox"
                        checked={layers[layer]}
                        onChange={(event) => {
                          const next = { ...layers, [layer]: event.target.checked };
                          setLayers(next);
                          saveLocal(key("layers"), next);
                        }}
                      />
                      {label}
                    </label>
                  ))}
                  <span className="hint">
                    Character changes appear as pictures in their own row. Point at one to see what
                    changed.
                  </span>
                </>
              ) : (
                <>
                  <strong style={{ fontSize: 14 }}>Lanes</strong>
                  {lanes.map((lane) => (
                    <label key={lane.id}>
                      <input
                        type="checkbox"
                        checked={!prefs.hidden.includes(lane.id)}
                        onChange={(event) => hideLane(lane.id, !event.target.checked)}
                      />
                      {laneName(lane, centerDay)}
                    </label>
                  ))}
                  <span className="hint">
                    Drag the dots beside a lane's name to move it. Your order and hidden lanes only
                    change your view.
                  </span>
                  <button
                    className="btn ghost"
                    type="button"
                    onClick={() => savePrefs({ order: [], hidden: [] })}
                  >
                    Reset to the default order
                  </button>
                </>
              )}
              <button className="btn ghost" type="button" onClick={() => setPopover(null)}>
                Close
              </button>
            </div>
          ) : null}
        </>
      }
    >
      <div ref={wrap} className="tl-wrap">
        {data ? (
          <svg
            ref={svg}
            viewBox={`0 0 ${width} ${height}`}
            height={height}
            role="application"
            aria-label="Timeline. Drag or use the arrow keys to move, plus and minus to zoom."
            tabIndex={0}
            className={pan.current?.moved ? "dragging" : undefined}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              pan.current = { x: event.clientX, center, id: event.pointerId, moved: false };
              moved.current = false;
            }}
            onPointerMove={(event) => {
              const current = pan.current;
              if (!current) return;
              const dx = event.clientX - current.x;
              if (!current.moved && Math.abs(dx) > 4) {
                current.moved = true;
                moved.current = true;
                // Capture only once it is a drag, so a plain click still reaches a dot or an arrow.
                svg.current?.setPointerCapture(current.id);
              }
              if (current.moved) setCenter(current.center - dx / ppd);
            }}
            onPointerUp={() => {
              pan.current = null;
              window.setTimeout(() => (moved.current = false), 0);
            }}
            onPointerCancel={() => (pan.current = null)}
            onKeyDown={(event) => {
              const step = 120 / ppd;
              if (event.key === "ArrowLeft") setCenter(center - step);
              else if (event.key === "ArrowRight") setCenter(center + step);
              else if (event.key === "+" || event.key === "=")
                setZoom(zoom === "year" ? "month" : "day");
              else if (event.key === "-") setZoom(zoom === "day" ? "month" : "year");
            }}
          >
            <defs>
              <clipPath id="content-clip">
                <rect x={LABEL_W} y={0} width={width - LABEL_W} height={height} />
              </clipPath>
            </defs>
            <g clipPath="url(#content-clip)">{content}</g>
            {labels}
          </svg>
        ) : (
          <div className="empty">Loading the timeline…</div>
        )}
      </div>
    </ViewFrame>
  );
}

function ArrowList(props: { group: TimelineLane["arrows"] }) {
  const windows = useWindows();
  return (
    <Modal
      title={`${props.group.length} on this ${props.group[0]?.day ? dayText(props.group[0].day) : "day"}`}
      onClose={windows.close}
    >
      <div className="content">
        {props.group.map((item) =>
          item.kind === "event" ? (
            <button
              key={item.id}
              className="btn"
              type="button"
              onClick={() => windows.openEvent(item.id)}
            >
              {item.title}
            </button>
          ) : (
            <span key={`${item.kind}-${item.day}`}>
              {item.kind === "name" ? `Renamed to ${item.name}` : "New icon"} on {dayText(item.day)}
            </span>
          ),
        )}
      </div>
    </Modal>
  );
}

function ChangeNote(props: {
  lane: TimelineLane;
  change: Extract<TimelineLane["arrows"][number], { kind: "name" | "icon" }>;
}) {
  const { archive } = useArchive();
  const windows = useWindows();
  const before = dayOfNumber(dayNumber(props.change.day) - 1);
  return (
    <Modal
      title={`${laneName(props.lane, props.change.day)}: ${props.change.kind === "name" ? "name change" : "icon change"}`}
      onClose={windows.close}
    >
      <div className="content">
        {props.change.kind === "name" ? (
          <p style={{ margin: 0 }}>
            {laneName(props.lane, before)} → {props.change.name} on {dayText(props.change.day)}.
          </p>
        ) : (
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            {laneIcon(props.lane, before) ? (
              <span className="av lg">
                <img
                  src={mediaUrl(archive.archiveId, laneIcon(props.lane, before)!)}
                  alt="Earlier icon"
                />
              </span>
            ) : null}
            <span>→</span>
            <span className="av lg">
              <img src={mediaUrl(archive.archiveId, props.change.mediaId)} alt="New icon" />
            </span>
            <span>{dayText(props.change.day)}</span>
          </div>
        )}
        <p className="hint" style={{ margin: 0 }}>
          These markers come from the place's dated names and icons, which are edited on its page.
        </p>
      </div>
    </Modal>
  );
}
