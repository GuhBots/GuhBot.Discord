import { useEffect, useRef, useState } from "react";
import {
  api,
  type ArtifactPage,
  type ArtifactSummary,
  type EntityView,
  type PlaceSummary,
  query,
} from "../api.js";
import { Thumb } from "../components/Media.js";
import { useCharacterNames } from "../components/use-names.js";
import { basisText, dayText, MONTHS, MONTHS_LONG, monthText } from "../format.js";
import { AddArtifactModal } from "../modals/AddArtifactModal.js";
import { FiltersModal } from "../modals/FiltersModal.js";
import { PlaceEditModal } from "../modals/PlaceEditModal.js";
import { navigate, placePath } from "../router.js";
import { useSettled, useWindows } from "../Shell.js";
import { filterCount, filterQuery, loadLocal, saveLocal, useArchive } from "../state.js";
import { Avatar, ErrorNote } from "../ui.js";
import { ViewFrame } from "./ViewFrame.js";

type ServerView = Extract<EntityView, { kind: "server" }>;
type ChannelView = Extract<EntityView, { kind: "channel" }>;

/** A server's or group chat's page: its artifacts in historical order, as a list or as channel lanes. */
export function PlaceView(props: { placeId: string | null }) {
  const { archive, filters, revision, position } = useArchive();
  const windows = useWindows();
  const day = useSettled(position, 400);
  const [places, setPlaces] = useState<PlaceSummary[] | null>(null);
  const [record, setRecord] = useState<ServerView | ChannelView | null>(null);
  const [channel, setChannel] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [mode, setMode] = useState<"list" | "lanes">(() =>
    loadLocal("archivist:place-mode", "list"),
  );
  const names = useCharacterNames(archive.archiveId, revision);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    api<{ places: PlaceSummary[] }>(`/api/archives/${archive.archiveId}/places${query({ day })}`, {
      signal: controller.signal,
    })
      .then((data) => setPlaces(data.places))
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure);
      });
    return () => controller.abort();
  }, [archive.archiveId, day, revision]);

  const place = places?.find((p) => p.id === props.placeId) ?? null;
  useEffect(() => {
    if (props.placeId || !places?.length) return;
    navigate(placePath(archive.archiveId, places[0]!.id), true);
  }, [props.placeId, places, archive.archiveId]);
  useEffect(() => {
    setChannel(null);
  }, [props.placeId]);
  useEffect(() => {
    if (!place) return;
    const controller = new AbortController();
    setError(null);
    setRecord(null);
    api<ServerView | ChannelView>(
      `/api/archives/${archive.archiveId}/entities/${place.kind === "server" ? "server" : "channel"}/${place.id}`,
      { signal: controller.signal },
    )
      .then(setRecord)
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure);
      });
    return () => controller.abort();
  }, [place?.id, place?.kind, archive.archiveId, revision]);

  if (error)
    return (
      <ViewFrame label="Places" head={<h1>Places</h1>}>
        <ErrorNote error={error} />
      </ViewFrame>
    );
  if (places && !places.length) {
    return (
      <ViewFrame label="Places" head={<h1>Places</h1>}>
        <div className="empty">
          No servers or group chats yet. Add them from Discord with /archivist entity create.
        </div>
      </ViewFrame>
    );
  }
  if (!place || !record || record.id !== place.id) {
    return (
      <ViewFrame label="Places" head={<h1>Places</h1>}>
        <div className="empty">Loading…</div>
      </ViewFrame>
    );
  }
  const isServer = place.kind === "server";
  const channels = record.kind === "server" ? record.channels : [];
  const earlier = record.history
    .filter((e) => e.kind === "server_name" || e.kind === "channel_name")
    .map((e) => e.name);
  const pick = (value: "list" | "lanes") => {
    setMode(value);
    saveLocal("archivist:place-mode", value);
  };
  return (
    <ViewFrame
      label={place.name}
      head={
        <>
          <span className="av" style={{ background: place.color }}>
            {place.iconMediaId ? (
              <Avatar
                archiveId={archive.archiveId}
                picture={{ mediaId: place.iconMediaId }}
                name={place.name}
              />
            ) : (
              place.name.slice(0, 2).toUpperCase()
            )}
          </span>
          <h1>
            <button
              className="linkish"
              type="button"
              style={{ font: "inherit", color: "inherit" }}
              title="Details and editing"
              onClick={() =>
                windows.show(
                  <PlaceEditModal kind={isServer ? "server" : "channel"} id={place.id} />,
                )
              }
            >
              {place.name}
            </button>
          </h1>
          <span className="meta">
            {place.isMain ? "Main server" : isServer ? "Server" : "Group chat"}
            {earlier.length > 1 ? ` · names: ${earlier.join(", ")}` : ""}
          </span>
          {filterCount(filters) ? <span className="meta">Filtered</span> : null}
        </>
      }
      tray={
        <>
          {isServer ? (
            <>
              <span className="label">Show</span>
              <div className="seg" role="group" aria-label="Show">
                <button
                  className="btn"
                  type="button"
                  aria-pressed={mode === "list"}
                  onClick={() => pick("list")}
                >
                  List
                </button>
                <button
                  className="btn"
                  type="button"
                  aria-pressed={mode === "lanes"}
                  onClick={() => pick("lanes")}
                >
                  Channel lanes
                </button>
              </div>
              <span className="sep" />
            </>
          ) : null}
          <button className="btn" type="button" onClick={() => windows.show(<FiltersModal />)}>
            Filters{filterCount(filters) ? ` (${filterCount(filters)})` : ""}
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={() => windows.show(<AddArtifactModal />)}
          >
            Add artifact
          </button>
          <button
            className="btn"
            type="button"
            onClick={() =>
              windows.show(<PlaceEditModal kind={isServer ? "server" : "channel"} id={place.id} />)
            }
          >
            Edit place
          </button>
        </>
      }
    >
      <div className={isServer ? "place-layout" : ""}>
        {isServer ? (
          <nav className="channel-nav" aria-label="Channels">
            <button
              type="button"
              aria-current={!channel ? "true" : undefined}
              onClick={() => setChannel(null)}
            >
              All channels
            </button>
            {channels.map((c) => (
              <button
                key={c.id}
                type="button"
                className={c.channelKind === "thread" ? "thread" : ""}
                aria-current={channel === c.id ? "true" : undefined}
                onClick={() => setChannel(c.id)}
              >
                {c.channelKind === "thread" ? `↳ ${c.label}` : `# ${c.label}`}
              </button>
            ))}
          </nav>
        ) : null}
        {isServer && mode === "lanes" ? (
          <ChannelLanes
            key={`${place.id}:${revision}:${JSON.stringify(filters)}`}
            placeId={place.id}
            channels={channels}
            color={place.color}
          />
        ) : (
          <PlaceList
            key={`${place.id}:${channel}:${revision}:${JSON.stringify(filters)}`}
            placeId={place.id}
            channel={channel}
            channels={channels}
            names={names}
          />
        )}
      </div>
    </ViewFrame>
  );
}

function PlaceList(props: {
  placeId: string;
  channel: string | null;
  channels: ChannelView[];
  names: Record<string, string>;
}) {
  const { archive, filters, revision } = useArchive();
  const windows = useWindows();
  const [items, setItems] = useState<ArtifactSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const loading = useRef(false);
  const filterKey = JSON.stringify(filterQuery(filters));
  const load = async (cursor: string | null, replace: boolean) => {
    loading.current = true;
    try {
      const page = await api<ArtifactPage>(
        `/api/archives/${archive.archiveId}/artifacts${query({
          ...filterQuery(filters),
          lane: props.placeId,
          channel: props.channel ? [props.channel] : filterQuery(filters).channel,
          sort: "oldest",
          limit: 60,
          cursor,
        })}`,
      );
      setItems((current) => (replace ? page.items : [...current, ...page.items]));
      setNext(page.next);
      setTotal(page.total);
    } catch (failure) {
      setError(failure);
    } finally {
      loading.current = false;
    }
  };
  useEffect(() => {
    void load(null, true);
    // Reloads when the place, channel, filters, or archive data change.
  }, [props.placeId, props.channel, filterKey, revision, archive.archiveId]);
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !next) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !loading.current) void load(next, false);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [next]);
  const channelName = new Map(props.channels.map((c) => [c.id, c.label]));
  const ids = items.map((item) => item.id);
  let month: string | null = null;
  return (
    <div>
      <ErrorNote error={error} />
      {total === 0 ? <div className="empty">Nothing here matches.</div> : null}
      {items.map((item, index) => {
        const heading = item.day
          ? `${MONTHS_LONG[Number(item.day.slice(5, 7)) - 1]} ${item.day.slice(0, 4)}`
          : "Undated";
        const showHeading = heading !== month;
        month = heading;
        const where = item.channelIds.map((id) => channelName.get(id)).filter(Boolean);
        return (
          <div key={item.id}>
            {showHeading ? <div className="month-head">{heading}</div> : null}
            <button
              className="row"
              type="button"
              onClick={() => windows.openArtifact(item.id, { ids, index })}
            >
              <span className="thumb">
                <Thumb archiveId={archive.archiveId} media={item.media} />
              </span>
              <span>
                <span className="desc">{item.description}</span>
                <span className="sub">
                  <span>{dayText(item.day)}</span>
                  <span className={`basis ${item.basis}`}>{basisText(item.basis)}</span>
                  {where.length ? <span>#{where.join(", #")}</span> : null}
                  <span>{item.characterIds.map((id) => props.names[id] ?? "…").join(", ")}</span>
                  {item.unidentifiedCharacters ? (
                    <span className="flag">unidentified character</span>
                  ) : null}
                </span>
              </span>
            </button>
          </div>
        );
      })}
      <div ref={sentinel} style={{ height: 1 }} />
    </div>
  );
}

/** Each channel as a lane of shaded dots, one per period, like the timeline. */
function ChannelLanes(props: { placeId: string; channels: ChannelView[]; color: string }) {
  const { archive, filters, revision } = useArchive();
  const windows = useWindows();
  const [items, setItems] = useState<ArtifactSummary[] | null>(null);
  const [capped, setCapped] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const filterKey = JSON.stringify(filterQuery(filters));
  useEffect(() => {
    let live = true;
    (async () => {
      const all: ArtifactSummary[] = [];
      let cursor: string | null = null;
      // Up to 2,000 artifacts are drawn here; the list shows everything.
      do {
        const page: ArtifactPage = await api(
          `/api/archives/${archive.archiveId}/artifacts${query({ ...filterQuery(filters), lane: props.placeId, sort: "oldest", limit: 100, cursor })}`,
        );
        all.push(...page.items);
        cursor = page.next;
      } while (cursor && all.length < 2000 && live);
      if (live) {
        setItems(all);
        setCapped(Boolean(cursor));
      }
    })().catch((failure) => {
      if (live) setError(failure);
    });
    return () => {
      live = false;
    };
  }, [archive.archiveId, props.placeId, filterKey, revision]);
  const dated = (items ?? []).filter((item) => item.day);
  if (error) return <ErrorNote error={error} />;
  if (!items) return <div className="empty">Loading…</div>;
  if (!dated.length) return <div className="empty">No dated artifacts here.</div>;
  const toNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;
  const min = Math.min(...dated.map((item) => toNumber(item.day!))) - 10;
  const max = Math.max(...dated.map((item) => toNumber(item.day!))) + 10;
  const W = 760;
  const LABEL = 150;
  const perDay = (W - LABEL - 16) / (max - min);
  const bucket = perDay >= 18 ? "day" : perDay * 7 >= 18 ? "week" : "month";
  const x = (n: number) => LABEL + ((n - min) / (max - min)) * (W - LABEL - 16);
  const startOf = (day: string) => {
    if (bucket === "day") return day;
    if (bucket === "month") return `${day.slice(0, 7)}-01`;
    const n = toNumber(day);
    const weekday = (new Date(n * 86_400_000).getUTCDay() + 6) % 7;
    return new Date((n - weekday) * 86_400_000).toISOString().slice(0, 10);
  };
  const endOf = (start: string) =>
    bucket === "day"
      ? start
      : bucket === "week"
        ? new Date((toNumber(start) + 6) * 86_400_000).toISOString().slice(0, 10)
        : new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)), 0))
            .toISOString()
            .slice(0, 10);
  const lanes = props.channels.filter((c) => c.channelKind !== "direct_message");
  const H = lanes.length * 44 + 50;
  return (
    <div style={{ padding: "12px 16px", overflowX: "auto" }}>
      <p className="hint">
        Each dot is one {bucket}, darker with more artifacts.
        {capped ? " Only the first 2,000 artifacts are drawn; the list shows them all." : ""}
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Channel lanes">
        {lanes.map((c, i) => {
          const y = 30 + i * 44;
          const mine = dated.filter((item) => item.channelIds.includes(c.id));
          const groups = new Map<string, ArtifactSummary[]>();
          for (const item of mine)
            groups.set(startOf(item.day!), [...(groups.get(startOf(item.day!)) ?? []), item]);
          return (
            <g key={c.id}>
              <text className="t-lane" x={12} y={y + 4}>
                {(c.channelKind === "thread" ? "↳ " : "# ") + c.label}
              </text>
              {mine.length ? (
                <line
                  x1={x(toNumber(mine[0]!.day!))}
                  x2={x(toNumber(mine.at(-1)!.day!))}
                  y1={y}
                  y2={y}
                  stroke={props.color}
                  strokeWidth={4}
                  strokeLinecap="round"
                />
              ) : null}
              {[...groups].map(([start, group]) => {
                const cx = x((toNumber(start) + toNumber(endOf(start))) / 2);
                const tier =
                  group.length >= 7 ? 4 : group.length >= 4 ? 3 : group.length >= 2 ? 2 : 1;
                const uncertain = group.some((item) => item.basis !== "exact");
                const ids = group.map((item) => item.id);
                const period =
                  bucket === "day"
                    ? dayText(start)
                    : bucket === "week"
                      ? `Week of ${dayText(start)}`
                      : monthText(start);
                const open = () =>
                  windows.openArtifact(ids[0]!, { ids, index: 0, title: `#${c.label}, ${period}` });
                return (
                  <g
                    key={start}
                    className="dot"
                    tabIndex={0}
                    role="button"
                    aria-label={`${group.length} artifacts in #${c.label}, ${period}`}
                    onClick={open}
                    onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && open()}
                  >
                    <circle
                      cx={cx}
                      cy={y - 12}
                      r={8}
                      fill={`var(--dot-${tier})`}
                      stroke={uncertain ? "#f2f3f5" : "#111214"}
                      strokeWidth={uncertain ? 1.5 : 1}
                      strokeDasharray={uncertain ? "2.5 2" : undefined}
                    />
                    {group.length > 1 ? (
                      <text
                        className="t-dark"
                        x={cx}
                        y={y - 8.5}
                        textAnchor="middle"
                        fill={tier >= 3 ? "#f2f3f5" : "#111214"}
                      >
                        {group.length > 9 ? "9+" : group.length}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </g>
          );
        })}
        {Array.from({ length: Math.ceil((max - min) / 91) + 1 }, (_, k) => {
          const date = new Date((min + k * 91) * 86_400_000);
          const label = `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
          return (
            <text key={k} className="t-faint" x={x(min + k * 91)} y={H - 8}>
              {label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
