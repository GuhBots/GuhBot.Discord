import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, BASE, type CharacterSummary, type PlaceSummary, query } from "./api.js";
import { CalendarModal } from "./modals/CalendarModal.js";
import { ArtifactModal } from "./modals/ArtifactModal.js";
import { EventModal } from "./modals/EventModal.js";
import {
  characterPath,
  navigate,
  parseRoute,
  placePath,
  usePath,
  type View,
  VIEWS,
  viewPath,
} from "./router.js";
import { type Me, useArchive } from "./state.js";
import { Avatar } from "./ui.js";
import { AlbumView } from "./views/AlbumView.js";
import { BoardView } from "./views/BoardView.js";
import { CharacterPage } from "./views/CharacterPage.js";
import { GraphView } from "./views/GraphView.js";
import { HeatmapView } from "./views/HeatmapView.js";
import { PlaceView } from "./views/PlaceView.js";
import { TimelineView } from "./views/TimelineView.js";

/**
 * The page around every view: the top bar, servers and group chats on the
 * left, characters on the right, and the current view with its tray in the
 * middle, as in the approved prototype.
 */

const VIEW_LABELS: Record<View, { label: string; icon: ReactNode }> = {
  timeline: { label: "Timeline", icon: <path d="M1 8h14M4 5v6M8 3v10M12 6v4" /> },
  album: {
    label: "Album",
    icon: (
      <>
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
        <circle cx="5.5" cy="6.2" r="1.3" />
        <path d="M2 12.5l4-4 3 3 2-2 3.5 3.5" />
      </>
    ),
  },
  places: {
    label: "Places",
    icon: (
      <>
        <rect x="2" y="2" width="5" height="5" rx="1" />
        <rect x="9" y="2" width="5" height="5" rx="1" />
        <rect x="2" y="9" width="5" height="5" rx="1" />
        <rect x="9" y="9" width="5" height="5" rx="1" />
      </>
    ),
  },
  graph: {
    label: "Graph",
    icon: (
      <>
        <circle cx="3.5" cy="4" r="2" />
        <circle cx="12.5" cy="4" r="2" />
        <circle cx="8" cy="12.5" r="2" />
        <path d="M5 5l2 5.5M11 5L9 10.5M5.5 4h5" />
      </>
    ),
  },
  heatmap: {
    label: "Heatmap",
    icon: (
      <>
        <rect x="1.5" y="1.5" width="3.5" height="3.5" />
        <rect x="6.25" y="1.5" width="3.5" height="3.5" />
        <rect x="11" y="1.5" width="3.5" height="3.5" />
        <rect x="1.5" y="6.25" width="3.5" height="3.5" />
        <rect x="6.25" y="6.25" width="3.5" height="3.5" />
        <rect x="1.5" y="11" width="3.5" height="3.5" />
      </>
    ),
  },
  board: {
    label: "Board",
    icon: (
      <>
        <rect x="1.5" y="2" width="4" height="12" rx="1" />
        <rect x="6.5" y="2" width="4" height="8" rx="1" />
        <rect x="11.5" y="2" width="3" height="5" rx="1" />
      </>
    ),
  },
};

/** Opens windows over the page from anywhere: artifacts, events, and any other dialog. */
export interface Windows {
  show(node: ReactNode): void;
  close(): void;
  openArtifact(id: string, nav?: { ids: string[]; index: number; title?: string }): void;
  openEvent(id: string): void;
}

export const WindowContext = createContext<Windows | null>(null);

export function useWindows(): Windows {
  const windows = useContext(WindowContext);
  if (!windows) throw new Error("useWindows is used outside the shell.");
  return windows;
}

/** Waits until a value stops changing, so dragging the timeline does not send a request per frame. */
export function useSettled<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function Shell() {
  const route = parseRoute(usePath());
  const [modal, setModal] = useState<ReactNode>(null);
  const [drawer, setDrawer] = useState<"places" | "characters" | null>(null);
  const close = useCallback(() => setModal(null), []);
  const windows = useMemo<Windows>(
    () => ({
      show: setModal,
      close,
      openArtifact: (id, nav) =>
        setModal(<ArtifactModal key={`${id}:${nav?.index ?? ""}`} id={id} nav={nav} />),
      openEvent: (id) => setModal(<EventModal key={id} id={id} />),
    }),
    [close],
  );

  useEffect(() => setDrawer(null), [route.kind === "view" ? route.view : route.kind]);

  let content: ReactNode;
  if (route.kind === "character") content = <CharacterPage id={route.id} />;
  else if (route.kind === "place") content = <PlaceView placeId={route.id} />;
  else if (route.kind === "view") {
    content = {
      timeline: <TimelineView />,
      album: <AlbumView />,
      places: <PlaceView placeId={null} />,
      graph: <GraphView />,
      heatmap: <HeatmapView />,
      board: <BoardView />,
    }[route.view];
  }

  return (
    <WindowContext.Provider value={windows}>
      <div className="app">
        <TopBar
          current={route.kind === "view" ? route.view : null}
          onDrawer={(which) => setDrawer(drawer === which ? null : which)}
        />
        <div className="columns">
          <PlacesColumn
            open={drawer === "places"}
            selected={route.kind === "place" ? route.id : null}
          />
          <div className="center">{content}</div>
          <CharactersColumn
            open={drawer === "characters"}
            selected={route.kind === "character" ? route.id : null}
          />
        </div>
      </div>
      {modal}
    </WindowContext.Provider>
  );
}

function TopBar(props: { current: View | null; onDrawer(which: "places" | "characters"): void }) {
  const { archive, archives, me } = useArchive();
  const windows = useWindows();
  const [menu, setMenu] = useState(false);
  return (
    <header className="topbar">
      <div className="brand">
        GuhBot <span>Archivist</span>
      </div>
      <select
        className="btn"
        id="archive-select"
        aria-label="Archive"
        value={archive.archiveId}
        onChange={(event) => navigate(viewPath(event.target.value, props.current ?? "timeline"))}
      >
        {archives.map((a) => (
          <option key={a.archiveId} value={a.archiveId}>
            {a.name}
          </option>
        ))}
      </select>
      <button className="btn drawer-toggle" type="button" onClick={() => props.onDrawer("places")}>
        Places
      </button>
      <nav className="tabs" aria-label="Views">
        {VIEWS.map((view) => (
          <a
            key={view}
            className="tab"
            href={`${BASE}${viewPath(archive.archiveId, view)}`}
            aria-current={props.current === view ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate(viewPath(archive.archiveId, view));
            }}
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              {VIEW_LABELS[view].icon}
            </svg>
            <span>{VIEW_LABELS[view].label}</span>
          </a>
        ))}
      </nav>
      <select
        className="btn view-select"
        aria-label="View"
        value={props.current ?? ""}
        onChange={(event) => navigate(viewPath(archive.archiveId, event.target.value as View))}
      >
        {props.current ? null : <option value="">Choose a view</option>}
        {VIEWS.map((view) => (
          <option key={view} value={view}>
            {VIEW_LABELS[view].label}
          </option>
        ))}
      </select>
      <div className="grow" />
      <SearchBox />
      <button
        className="btn"
        type="button"
        aria-label="Calendar"
        title="Go to a year or date"
        onClick={() => windows.show(<CalendarModal />)}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <rect x="2" y="3" width="12" height="11" rx="1" />
          <path d="M2 6.5h12M5 1.5v3M11 1.5v3" />
        </svg>
      </button>
      <button
        className="btn drawer-toggle"
        type="button"
        onClick={() => props.onDrawer("characters")}
      >
        Characters
      </button>
      <div style={{ position: "relative" }}>
        <button
          className="btn"
          type="button"
          aria-haspopup="true"
          aria-expanded={menu}
          aria-label="Your account and preferences"
          onClick={() => setMenu(!menu)}
        >
          {me.user.avatarUrl ? (
            <span className="av sm">
              <img src={me.user.avatarUrl} alt="" />
            </span>
          ) : (
            <span className="av sm initials">
              {(me.user.name ?? "?").slice(0, 2).toUpperCase()}
            </span>
          )}
        </button>
        {menu ? <AccountMenu onClose={() => setMenu(false)} /> : null}
      </div>
    </header>
  );
}

const TIME_ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf(
      "timeZone",
    );
  } catch {
    return [];
  }
})();

/** The contributor's own settings, the same ones Discord's preferences commands set. */
function AccountMenu(props: { onClose(): void }) {
  const { me, setMe, archive, toast } = useArchive();
  const [zone, setZone] = useState(me.preferences.timeZone ?? "");
  const box = useRef<HTMLDivElement>(null);
  const { onClose } = props;
  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [onClose]);
  const save = async (path: string, json: unknown, method: "PUT" | "DELETE" = "PUT") => {
    try {
      const preferences = await api<Me["preferences"]>(path, { method, json });
      setMe({ ...me, preferences });
      toast("Saved your preferences.");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <div ref={box} className="popover account-menu" role="dialog" aria-label="Your account">
      <strong>{me.user.name ?? "Signed in"}</strong>
      <span className="hint">{me.isOwner ? "Bot owner" : "Archive member"}</span>
      <label className="field">
        <span>All-number dates such as 03/04/2019</span>
        <select
          value={me.preferences.dateOrder}
          onChange={(event) => save("/api/me/date-order", { dateOrder: event.target.value })}
        >
          <option value="ymd">Year, month, day (2019/04/03)</option>
          <option value="mdy">Month, day, year (04/03/2019)</option>
          <option value="dmy">Day, month, year (03/04/2019)</option>
        </select>
      </label>
      <form
        className="field"
        onSubmit={(event) => {
          event.preventDefault();
          void save("/api/me/timezone", { timeZone: zone });
        }}
      >
        <span>Your timezone, for times typed without one</span>
        <div className="jump">
          <input
            list="time-zones"
            value={zone}
            placeholder={`Archive's: ${archive.timezone}`}
            onChange={(event) => setZone(event.target.value)}
          />
          <button className="btn" type="submit">
            Save
          </button>
        </div>
        <datalist id="time-zones">
          {TIME_ZONES.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </form>
      <button
        className="btn ghost"
        type="button"
        onClick={() => save("/api/me/preferences", undefined, "DELETE")}
      >
        Reset both
      </button>
      <button
        className="btn danger"
        type="button"
        onClick={async () => {
          await api("/auth/logout", { method: "POST" });
          window.location.href = `${BASE}/`;
        }}
      >
        Sign out
      </button>
    </div>
  );
}

interface SearchHit {
  id: string;
  label: string;
}

function SearchBox() {
  const { archive } = useArchive();
  const windows = useWindows();
  const [text, setText] = useState("");
  const [hits, setHits] = useState<Record<string, SearchHit[]> | null>(null);
  const typed = useSettled(text, 200);
  useEffect(() => {
    if (!typed.trim()) {
      setHits(null);
      return;
    }
    const controller = new AbortController();
    api<Record<string, SearchHit[]>>(
      `/api/archives/${archive.archiveId}/search${query({ q: typed })}`,
      {
        signal: controller.signal,
      },
    )
      .then(setHits)
      .catch(() => undefined);
    return () => controller.abort();
  }, [typed, archive.archiveId]);
  const pick = (action: () => void) => {
    setText("");
    setHits(null);
    action();
  };
  const groups: [string, string, (hit: SearchHit) => void][] = [
    ["characters", "Characters", (hit) => navigate(characterPath(archive.archiveId, hit.id))],
    ["places", "Places", (hit) => navigate(placePath(archive.archiveId, hit.id))],
    ["artifacts", "Artifacts", (hit) => windows.openArtifact(hit.id)],
    ["events", "Events", (hit) => windows.openEvent(hit.id)],
    ["accounts", "Accounts", () => undefined],
  ];
  const empty = hits && groups.every(([key]) => !hits[key]?.length);
  return (
    <div className="search">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
      >
        <circle cx="7" cy="7" r="5" />
        <path d="M11 11l4 4" />
      </svg>
      <input
        type="search"
        placeholder="Search characters, artifacts, events"
        aria-label="Search"
        autoComplete="off"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => event.key === "Escape" && setText("")}
      />
      {hits ? (
        <div className="results">
          {empty ? (
            <p className="hint" style={{ margin: 8 }}>
              Nothing matches.
            </p>
          ) : null}
          {groups.map(([key, title, open]) =>
            hits[key]?.length ? (
              <div key={key}>
                <h4>{title}</h4>
                {hits[key]!.map((hit) => (
                  <button key={hit.id} type="button" onClick={() => pick(() => open(hit))}>
                    <span>{hit.label}</span>
                  </button>
                ))}
              </div>
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
}

function PlacesColumn(props: { open: boolean; selected: string | null }) {
  const { archive, position, revision } = useArchive();
  const day = useSettled(position, 400);
  const [places, setPlaces] = useState<PlaceSummary[] | null>(null);
  useEffect(() => {
    api<{ places: PlaceSummary[] }>(`/api/archives/${archive.archiveId}/places${query({ day })}`)
      .then((data) => setPlaces(data.places))
      .catch(() => setPlaces([]));
  }, [archive.archiveId, day, revision]);
  return (
    <nav
      className={`panel places ${props.open ? "open" : ""}`}
      aria-label="Servers and group chats"
    >
      <h2>Places</h2>
      {places && !places.length ? (
        <p className="hint" style={{ textAlign: "center" }}>
          No servers or group chats yet
        </p>
      ) : null}
      {places?.map((place) => (
        <button
          key={place.id}
          className="place-btn"
          type="button"
          aria-current={props.selected === place.id ? "true" : undefined}
          title={`${place.name} (${place.kind === "server" ? "server" : "group chat"})`}
          onClick={() => navigate(placePath(archive.archiveId, place.id))}
        >
          <span className="icon" style={{ background: place.color }}>
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
          <span className="name">{place.name}</span>
          <span className="kind">
            {place.isMain ? "main server" : place.kind === "server" ? "server" : "group chat"}
          </span>
        </button>
      ))}
    </nav>
  );
}

function CharactersColumn(props: { open: boolean; selected: string | null }) {
  const { archive, position, revision } = useArchive();
  const day = useSettled(position, 400);
  const [characters, setCharacters] = useState<CharacterSummary[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Every character is listed, a page at a time.
      const all: CharacterSummary[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: CharacterSummary[]; next: string | null } = await api(
          `/api/archives/${archive.archiveId}/entities/character${query({ day, limit: 100, cursor })}`,
        );
        all.push(...page.items);
        cursor = page.next;
      } while (cursor && !cancelled);
      if (!cancelled) setCharacters(all);
    })().catch(() => !cancelled && setCharacters([]));
    return () => {
      cancelled = true;
    };
  }, [archive.archiveId, day, revision]);
  return (
    <aside className={`panel characters ${props.open ? "open" : ""}`} aria-label="Characters">
      <h2>Characters</h2>
      <p className="pos">Pictures as of the timeline position</p>
      {characters && !characters.length ? (
        <p className="hint" style={{ textAlign: "center" }}>
          No characters yet
        </p>
      ) : null}
      {characters?.map((character) => (
        <button
          key={character.id}
          className="character-row"
          type="button"
          aria-current={props.selected === character.id ? "true" : undefined}
          onClick={() => navigate(characterPath(archive.archiveId, character.id))}
        >
          <Avatar
            archiveId={archive.archiveId}
            picture={character.picture}
            name={character.knownName}
          />
          <span>
            <span className="nm">{character.knownName}</span>
            <small>{character.realName ?? ""}</small>
          </span>
        </button>
      ))}
    </aside>
  );
}
