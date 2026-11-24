import { useEffect, useState } from "react";
import { api, type DayCounts, query } from "../api.js";
import { dayNumber, dayOfNumber, dayText, MONTHS_LONG } from "../format.js";
import { FiltersModal } from "../modals/FiltersModal.js";
import { navigate, viewPath } from "../router.js";
import { useWindows } from "../Shell.js";
import { filterCount, filterQuery, useArchive } from "../state.js";
import { ErrorNote } from "../ui.js";
import { ViewFrame } from "./ViewFrame.js";

/** Separate artifact and event calendars, using the archive's shared day buckets. */
export function HeatmapView() {
  const { archive, filters, position, setPosition, revision } = useArchive();
  const windows = useWindows();
  const [year, setYear] = useState(Number(position.slice(0, 4)));
  const [size, setSize] = useState(26);
  const [data, setData] = useState<DayCounts | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    api<DayCounts>(
      `/api/archives/${archive.archiveId}/heatmap${query({ ...filterQuery(filters), year: String(year).padStart(4, "0") })}`,
      { signal: controller.signal },
    )
      .then(setData)
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure);
      });
    return () => controller.abort();
  }, [archive.archiveId, filters, year, revision]);
  const byDay = new Map(data?.days.map((entry) => [entry.day, entry]));
  const totals = data?.days.reduce(
    (sum, entry) => ({
      artifacts: sum.artifacts + entry.artifacts,
      events: sum.events + entry.events,
    }),
    { artifacts: 0, events: 0 },
  );
  const go = (day: string) => {
    setPosition(day);
    navigate(viewPath(archive.archiveId, "timeline"));
    window.setTimeout(
      () =>
        window.dispatchEvent(new CustomEvent("archivist:jump", { detail: { day, zoom: "day" } })),
      0,
    );
  };
  return (
    <ViewFrame
      label="Heatmap"
      head={
        <>
          <h1>Heatmap</h1>
          <span className="meta">
            {year} · {archive.timezone}
          </span>
        </>
      }
      tray={
        <>
          <button
            className="btn"
            type="button"
            aria-label="Previous year"
            disabled={year <= 1}
            onClick={() => setYear(year - 1)}
          >
            ◀
          </button>
          <label className="jump">
            Year{" "}
            <input
              aria-label="Heatmap year"
              type="number"
              min={1}
              max={9999}
              value={year}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isInteger(value) && value >= 1 && value <= 9999) setYear(value);
              }}
              style={{ width: 100 }}
            />
          </label>
          <button
            className="btn"
            type="button"
            aria-label="Next year"
            disabled={year >= 9999}
            onClick={() => setYear(year + 1)}
          >
            ▶
          </button>
          <span className="sep" />
          <button
            className="btn"
            type="button"
            aria-label="Zoom out heatmap"
            disabled={size <= 18}
            onClick={() => setSize(size - 4)}
          >
            −
          </button>
          <span className="label">Cell size</span>
          <button
            className="btn"
            type="button"
            aria-label="Zoom in heatmap"
            disabled={size >= 46}
            onClick={() => setSize(size + 4)}
          >
            +
          </button>
          <button className="btn" type="button" onClick={() => windows.show(<FiltersModal />)}>
            Filters{filterCount(filters) ? ` (${filterCount(filters)})` : ""}
          </button>
        </>
      }
    >
      <ErrorNote error={error} />
      {!data && !error ? <div className="empty">Loading…</div> : null}
      {data ? (
        <div className="heat">
          <p className="hint">
            {totals?.artifacts} dated artifacts · {totals?.events} event starts · {data.undated}{" "}
            undated artifacts excluded. Select a day to open the timeline with these filters.
          </p>
          <p className="hint">
            Darker cells mean more records. Dashed outlines mark estimated events or artifacts dated
            by an estimate or file metadata. Events count once, on their start or earliest possible
            day.
          </p>
          {(["artifacts", "events"] as const).map((kind) => (
            <section
              key={kind}
              aria-label={kind === "artifacts" ? "Artifact counts" : "Event counts"}
            >
              <h2>{kind === "artifacts" ? "Artifacts" : "Event starts"}</h2>
              <div
                className="heat-months"
                style={{
                  gridTemplateColumns: `repeat(auto-fit, minmax(${size * 7 + 18}px, max-content))`,
                }}
              >
                {MONTHS_LONG.map((month, index) => {
                  const start = `${String(year).padStart(4, "0")}-${String(index + 1).padStart(2, "0")}-01`;
                  const first = dayNumber(start);
                  const date = new Date(`${start}T00:00:00Z`);
                  const offset = (date.getUTCDay() + 6) % 7;
                  date.setUTCMonth(index + 1, 0);
                  const days = date.getUTCDate();
                  return (
                    <div key={month}>
                      <h3>{month}</h3>
                      <div
                        className="heat-month"
                        style={{ gridTemplateColumns: `repeat(7, ${size}px)` }}
                      >
                        {["M", "T", "W", "T", "F", "S", "S"].map((label, i) => (
                          <span key={i} aria-hidden="true" className="hint">
                            {label}
                          </span>
                        ))}
                        {Array.from({ length: offset }, (_, i) => (
                          <span key={`blank-${i}`} />
                        ))}
                        {Array.from({ length: days }, (_, i) => {
                          const day = dayOfNumber(first + i);
                          const entry = byDay.get(day);
                          const count = entry?.[kind] ?? 0;
                          const uncertain =
                            kind === "artifacts"
                              ? (entry?.uncertainArtifacts ?? 0)
                              : (entry?.estimatedEvents ?? 0);
                          const tier = count >= 7 ? 4 : count >= 4 ? 3 : count >= 2 ? 2 : count;
                          const label = `${dayText(day)}: ${entry?.artifacts ?? 0} artifacts (${entry?.uncertainArtifacts ?? 0} estimated or file dates), ${entry?.events ?? 0} event starts (${entry?.estimatedEvents ?? 0} estimated)`;
                          return (
                            <button
                              key={day}
                              type="button"
                              className="heat-day"
                              title={label}
                              aria-label={label}
                              onClick={() => go(day)}
                              style={{
                                width: size,
                                height: size,
                                background: tier ? `var(--dot-${tier})` : "var(--side)",
                                color: tier && tier < 3 ? "#111214" : "var(--text)",
                                borderStyle: uncertain ? "dashed" : "solid",
                                borderColor: uncertain ? "var(--text)" : "var(--line)",
                              }}
                            >
                              {i + 1}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : null}
    </ViewFrame>
  );
}
