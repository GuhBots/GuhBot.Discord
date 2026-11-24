import { useEffect, useState } from "react";
import { api, type DayCounts, query } from "../api.js";
import { dayText, MONTHS_LONG } from "../format.js";
import { navigate, viewPath } from "../router.js";
import { useWindows } from "../Shell.js";
import { filterQuery, useArchive } from "../state.js";
import { Modal } from "../ui.js";

type Jump = { day: string; zoom: "day" | "month" | "year" };

/** Reads a typed year, month, or day: 2020, Jul 2020, 2020-07, Jul 15 2020, 15 July 2020, 2020-07-15. */
export function parseJump(text: string): Jump | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/,/g, " ")
    .replace(/(\d)(st|nd|rd|th)\b/g, "$1");
  if (!t) return null;
  const build = (y: number, m: number | null, d: number | null): Jump | null => {
    if (m !== null && (m < 1 || m > 12)) return null;
    if (d !== null && (m === null || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()))
      return null;
    const pad = (n: number) => String(n).padStart(2, "0");
    if (d !== null) return { day: `${y}-${pad(m!)}-${pad(d)}`, zoom: "day" };
    if (m !== null) return { day: `${y}-${pad(m)}-15`, zoom: "month" };
    return { day: `${y}-07-01`, zoom: "year" };
  };
  const iso = t.match(/^(\d{4})(?:[-/. ](\d{1,2})(?:[-/. ](\d{1,2}))?)?$/);
  if (iso)
    return build(Number(iso[1]), iso[2] ? Number(iso[2]) : null, iso[3] ? Number(iso[3]) : null);
  let year: number | null = null;
  let month: number | null = null;
  const numbers: number[] = [];
  for (const token of t.split(/[\s/.-]+/).filter(Boolean)) {
    const named = MONTHS_LONG.findIndex(
      (name) =>
        token.length >= 3 &&
        (name.toLowerCase().startsWith(token) || token.startsWith(name.toLowerCase().slice(0, 3))),
    );
    if (named !== -1 && month === null) month = named + 1;
    else if (/^\d{4}$/.test(token) && year === null) year = Number(token);
    else if (/^\d{1,2}$/.test(token)) numbers.push(Number(token));
    else return null;
  }
  if (year === null || numbers.length > 2) return null;
  if (month === null && numbers.length === 2) {
    // All numbers: the larger-than-12 one must be the day; otherwise month first.
    const [a, b] = numbers as [number, number];
    month = a > 12 ? b : a;
    return build(year, month, a > 12 ? a : b);
  }
  if (numbers.length > 1) return null;
  return build(year, month, numbers[0] ?? null);
}

/** Moves the timeline to a typed year, month, or day, or to a day picked in a month grid. */
export function CalendarModal() {
  const { archive, filters, position, setPosition } = useArchive();
  const windows = useWindows();
  const [month, setMonth] = useState(position.slice(0, 7));
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [counts, setCounts] = useState<DayCounts | null>(null);
  useEffect(() => {
    api<DayCounts>(
      `/api/archives/${archive.archiveId}/calendar${query({ ...filterQuery(filters), month })}`,
    )
      .then(setCounts)
      .catch(() => setCounts(null));
  }, [archive.archiveId, month, filters]);
  const go = (jump: Jump) => {
    setPosition(jump.day);
    windows.close();
    navigate(viewPath(archive.archiveId, "timeline"));
    // The timeline may already be open; tell it to move.
    window.setTimeout(
      () => window.dispatchEvent(new CustomEvent("archivist:jump", { detail: jump })),
      0,
    );
  };
  const [y, m] = month.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7;
  const byDay = new Map(counts?.days.map((d) => [d.day, d]) ?? []);
  const shift = (by: number) => {
    const next = new Date(Date.UTC(y, m - 1 + by, 1));
    setMonth(next.toISOString().slice(0, 7));
  };
  return (
    <Modal title="Go to a year or date" onClose={windows.close}>
      <div className="content">
        <form
          className="jump"
          onSubmit={(event) => {
            event.preventDefault();
            const jump = parseJump(typed);
            if (jump) go(jump);
            else
              setProblem("Try a year like 2020, a month like Jul 2020, or a day like Jul 15 2020.");
          }}
        >
          <input
            aria-label="Year or date"
            placeholder="2020, Jul 2020, or Jul 15 2020"
            autoComplete="off"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
          <button className="btn primary" type="submit">
            Go
          </button>
        </form>
        <p className="hint" style={{ margin: 0, color: problem ? "var(--event)" : undefined }}>
          {problem ?? "Type a year to see the whole year, or a date to go to that day."}
        </p>
        <div
          style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}
        >
          <button
            className="btn"
            type="button"
            aria-label="Previous month"
            onClick={() => shift(-1)}
          >
            ◀
          </button>
          <strong>
            {MONTHS_LONG[m - 1]} {y}
          </strong>
          <button className="btn" type="button" aria-label="Next month" onClick={() => shift(1)}>
            ▶
          </button>
        </div>
        <div className="cal">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <span key={d} className="dow">
              {d}
            </span>
          ))}
          {Array.from({ length: offset }, (_, i) => (
            <button
              key={`blank-${i}`}
              className="blank"
              type="button"
              tabIndex={-1}
              aria-hidden="true"
            />
          ))}
          {Array.from({ length: days }, (_, i) => {
            const day = `${month}-${String(i + 1).padStart(2, "0")}`;
            const count = byDay.get(day);
            const total = (count?.artifacts ?? 0) + (count?.events ?? 0);
            return (
              <button
                key={day}
                type="button"
                aria-label={`${dayText(day)}${count ? `, ${count.artifacts} artifacts and ${count.events} events` : ""}`}
                onClick={() => go({ day, zoom: "day" })}
              >
                {i + 1}
                {total ? <small>● {total}</small> : null}
              </button>
            );
          })}
        </div>
        <p className="hint" style={{ margin: 0 }}>
          Or choose a day in this month.
        </p>
      </div>
    </Modal>
  );
}
