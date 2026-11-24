import { useEffect, useRef, useState } from "react";
import { api, type ArtifactPage, type ArtifactSummary, query } from "../api.js";
import { Thumb } from "../components/Media.js";
import { dayText, MONTHS_LONG } from "../format.js";
import { AddArtifactModal } from "../modals/AddArtifactModal.js";
import { FiltersModal } from "../modals/FiltersModal.js";
import { useWindows } from "../Shell.js";
import { filterCount, filterQuery, loadLocal, saveLocal, useArchive } from "../state.js";
import { ViewFrame } from "./ViewFrame.js";

type Sort = "newest" | "oldest" | "added";
type Size = "s" | "m" | "l";

/** Every artifact as tiles, like a photo library, grouped by month when sorted by date. */
export function AlbumView() {
  const { archive, filters, revision } = useArchive();
  const windows = useWindows();
  const [sort, setSort] = useState<Sort>(() => loadLocal("archivist:album-sort", "newest"));
  const [size, setSize] = useState<Size>(() => loadLocal("archivist:album-size", "m"));
  const [items, setItems] = useState<ArtifactSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const filterKey = JSON.stringify(filterQuery(filters));

  const load = async (cursor: string | null, replace: boolean) => {
    setLoading(true);
    try {
      const page = await api<ArtifactPage>(
        `/api/archives/${archive.archiveId}/artifacts${query({ ...filterQuery(filters), sort, limit: 60, cursor })}`,
      );
      setItems((current) => (replace ? page.items : [...current, ...page.items]));
      setNext(page.next);
      setTotal(page.total);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(null, true);
  }, [archive.archiveId, sort, filterKey, revision]);

  // More tiles load as the end of the album comes into view.
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !next) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !loading) void load(next, false);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [next, loading]);

  const groups: { title: string | null; items: ArtifactSummary[] }[] = [];
  for (const item of items) {
    const title =
      sort === "added"
        ? null
        : item.day
          ? `${MONTHS_LONG[Number(item.day.slice(5, 7)) - 1]} ${item.day.slice(0, 4)}`
          : "No date yet";
    const last = groups.at(-1);
    if (last && last.title === title) last.items.push(item);
    else groups.push({ title, items: [item] });
  }
  const ids = items.map((item) => item.id);
  const choose =
    <T,>(key: string, setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      saveLocal(key, value);
    };
  const seg = <T extends string>(
    label: string,
    current: T,
    options: [T, string][],
    onPick: (value: T) => void,
  ) => (
    <>
      <span className="label">{label}</span>
      <div className="seg" role="group" aria-label={label}>
        {options.map(([value, text]) => (
          <button
            key={value}
            className="btn"
            type="button"
            aria-pressed={current === value}
            onClick={() => onPick(value)}
          >
            {text}
          </button>
        ))}
      </div>
    </>
  );

  return (
    <ViewFrame
      label="Album"
      head={
        <>
          <h1>Album</h1>
          <span className="meta">{total === null ? "" : `${total} artifacts`}</span>
          {filterCount(filters) ? <span className="meta">Filtered</span> : null}
        </>
      }
      tray={
        <>
          {seg<Sort>(
            "Sort",
            sort,
            [
              ["newest", "Newest first"],
              ["oldest", "Oldest first"],
              ["added", "Recently added"],
            ],
            choose("archivist:album-sort", setSort),
          )}
          <span className="sep" />
          {seg<Size>(
            "Size",
            size,
            [
              ["s", "S"],
              ["m", "M"],
              ["l", "L"],
            ],
            choose("archivist:album-size", setSize),
          )}
          <span className="sep" />
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
        </>
      }
    >
      <div className="album">
        {total === 0 ? <div className="empty">Nothing here matches the filters.</div> : null}
        {groups.map((group, g) => (
          <section
            key={`${group.title}-${g}`}
            className="album-group"
            aria-label={group.title ?? "All artifacts"}
          >
            {group.title ? (
              <h2>
                {group.title} <span>{group.items.length}</span>
              </h2>
            ) : null}
            <div className={`album-grid ${size}`}>
              {group.items.map((item) => {
                const badge = !item.media.readable
                  ? "can't be read"
                  : item.media.kind !== "image"
                    ? item.media.kind
                    : item.day && item.basis !== "exact"
                      ? "~ date"
                      : null;
                return (
                  <button
                    key={item.id}
                    className="tile"
                    type="button"
                    aria-label={`${item.description}, ${dayText(item.day)}`}
                    onClick={() =>
                      windows.openArtifact(item.id, { ids, index: ids.indexOf(item.id) })
                    }
                  >
                    <Thumb archiveId={archive.archiveId} media={item.media} />
                    {badge ? <span className="badge">{badge}</span> : null}
                    <span className="cap">
                      <strong style={{ display: "block" }}>
                        {item.day
                          ? `${item.basis === "estimated" ? "around " : ""}${dayText(item.day)}`
                          : "No date yet"}
                      </strong>
                      {item.description.length > 60
                        ? `${item.description.slice(0, 59)}…`
                        : item.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        <div ref={sentinel} style={{ height: 1 }} />
        {loading ? (
          <p className="hint" style={{ textAlign: "center" }}>
            Loading…
          </p>
        ) : null}
      </div>
    </ViewFrame>
  );
}
