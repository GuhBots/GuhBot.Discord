import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type ArchiveDetails, signInUrl } from "./api.js";
import { todayDay } from "./format.js";
import { navigate, parseRoute, usePath, viewPath } from "./router.js";
import { Shell } from "./Shell.js";
import {
  ArchiveContext,
  type ArchiveState,
  EMPTY_FILTERS,
  type Filters,
  loadLocal,
  type Me,
  saveLocal,
} from "./state.js";
import { Toast } from "./ui.js";

type Archives = { archiveId: string; name: string }[];

/** Signs the contributor in, picks an archive, and shows it. */
export function App() {
  const route = parseRoute(usePath());
  const [me, setMe] = useState<Me | "signed-out" | null>(null);
  const [archives, setArchives] = useState<Archives | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    api<Me>("/api/me")
      .then(setMe)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === "no_session") setMe("signed-out");
        else setFailure(error instanceof Error ? error.message : String(error));
      });
  }, []);

  useEffect(() => {
    if (!me || me === "signed-out") return;
    api<{ archives: Archives }>("/api/archives")
      .then((data) => setArchives(data.archives))
      .catch((error: unknown) =>
        setFailure(error instanceof Error ? error.message : String(error)),
      );
  }, [me]);

  // The home page opens the archive used last in this browser, or the first one.
  useEffect(() => {
    if (route.kind !== "home" || !archives?.length) return;
    const last = loadLocal<string | null>("archivist:last-archive", null);
    const pick = archives.find((a) => a.archiveId === last) ?? archives[0]!;
    navigate(viewPath(pick.archiveId, "timeline"), true);
  }, [route.kind, archives]);

  if (failure) return <Message title="Archivist could not load">{failure}</Message>;
  if (me === "signed-out") {
    return (
      <div className="signin">
        <main>
          <h1>
            GuhBot <span style={{ color: "var(--accent)" }}>Archivist</span>
          </h1>
          <p>
            Sign in with Discord to see the archives you belong to. Signing in only shares your
            Discord name and picture.
          </p>
          <a className="btn primary" href={signInUrl}>
            Sign in with Discord
          </a>
        </main>
      </div>
    );
  }
  if (!me || !archives) return <Message title="Loading">Opening Archivist…</Message>;
  if (!archives.length) {
    return (
      <Message title="No archives yet">
        You are signed in as {me.user.name ?? me.user.id}, but you are not on any archive's
        whitelist. Ask the bot owner to add you.
      </Message>
    );
  }
  if (route.kind === "home") return <Message title="Loading">Opening Archivist…</Message>;
  return (
    <ArchiveApp
      key={route.archiveId}
      archiveId={route.archiveId}
      archives={archives}
      me={me}
      setMe={setMe}
    />
  );
}

function Message(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="signin">
      <main>
        <h1>{props.title}</h1>
        <p>{props.children}</p>
      </main>
    </div>
  );
}

function ArchiveApp(props: { archiveId: string; archives: Archives; me: Me; setMe(me: Me): void }) {
  const [archive, setArchive] = useState<ArchiveDetails | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [position, setPosition] = useState(() =>
    loadLocal(`archivist:position:${props.archiveId}`, todayDay()),
  );
  const [toastText, setToastText] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    api<ArchiveDetails>(`/api/archives/${props.archiveId}`)
      .then((details) => {
        setArchive(details);
        saveLocal("archivist:last-archive", props.archiveId);
      })
      .catch((error: unknown) =>
        setFailure(error instanceof Error ? error.message : String(error)),
      );
  }, [props.archiveId]);

  const toast = useCallback((text: string) => {
    setToastText(text);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToastText(null), 3200);
  }, []);
  const changed = useCallback(() => setRevision((n) => n + 1), []);
  const remember = useCallback(
    (day: string) => {
      setPosition(day);
      saveLocal(`archivist:position:${props.archiveId}`, day);
    },
    [props.archiveId],
  );

  const state = useMemo<ArchiveState | null>(
    () =>
      archive && {
        me: props.me,
        setMe: props.setMe,
        archive,
        archives: props.archives,
        filters,
        setFilters,
        position,
        setPosition: remember,
        toast,
        revision,
        changed,
      },
    [
      archive,
      props.me,
      props.setMe,
      props.archives,
      filters,
      position,
      remember,
      toast,
      revision,
      changed,
    ],
  );

  if (failure) return <Message title="This archive could not open">{failure}</Message>;
  if (!state) return <Message title="Loading">Opening the archive…</Message>;
  return (
    <ArchiveContext.Provider value={state}>
      <Shell />
      <Toast text={toastText} />
    </ArchiveContext.Provider>
  );
}
