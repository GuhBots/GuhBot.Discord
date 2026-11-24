import { useEffect, useState } from "react";
import { api, type PlaceSummary } from "../api.js";
import { type Picked, Picker } from "../components/Picker.js";
import { useWindows } from "../Shell.js";
import { EMPTY_FILTERS, type Filters, useArchive } from "../state.js";
import { Modal } from "../ui.js";

/** The shared filters: every chosen category must match, any value within one matches. */
export function FiltersModal() {
  const { archive, filters, setFilters } = useArchive();
  const windows = useWindows();
  const [draft, setDraft] = useState<Filters>(filters);
  const [places, setPlaces] = useState<PlaceSummary[]>([]);
  const [characters, setCharacters] = useState<Picked[]>([]);
  const [events, setEvents] = useState<Picked[]>([]);
  useEffect(() => {
    api<{ places: PlaceSummary[] }>(`/api/archives/${archive.archiveId}/places`).then((data) =>
      setPlaces(data.places),
    );
    // Show names for filters chosen before.
    Promise.all(
      filters.characters.map((id) =>
        api<{ knownName: string }>(`/api/archives/${archive.archiveId}/entities/character/${id}`)
          .then((c) => ({ id, label: c.knownName }))
          .catch(() => ({ id, label: id.slice(0, 8) })),
      ),
    ).then(setCharacters);
    Promise.all(
      filters.events.map((id) =>
        api<{ title: string }>(`/api/archives/${archive.archiveId}/events/${id}`)
          .then((e) => ({ id, label: e.title }))
          .catch(() => ({ id, label: id.slice(0, 8) })),
      ),
    ).then(setEvents);
  }, [archive.archiveId, filters.characters, filters.events]);
  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  const apply = () => {
    setFilters({
      ...draft,
      characters: characters.map((c) => c.id),
      events: events.map((e) => e.id),
    });
    windows.close();
  };
  return (
    <Modal
      title="Filters"
      onClose={windows.close}
      footer={
        <>
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              windows.close();
            }}
          >
            Clear all
          </button>
          <button className="btn primary" type="button" onClick={apply}>
            Apply
          </button>
        </>
      }
    >
      <div className="content">
        <p className="hint" style={{ margin: 0 }}>
          Every view in this archive uses these filters. A record must match each section you fill
          in, and any choice within one.
        </p>
        <Picker
          archiveId={archive.archiveId}
          kind="character"
          label="Characters (any of)"
          value={characters}
          onChange={setCharacters}
        />
        <div className="field">
          <span>Places (any of)</span>
          <div className="checks">
            {places.map((place) => {
              const key = place.kind === "server" ? "servers" : "channels";
              return (
                <label key={place.id}>
                  <input
                    type="checkbox"
                    checked={draft[key].includes(place.id)}
                    onChange={() => setDraft({ ...draft, [key]: toggle(draft[key], place.id) })}
                  />
                  {place.name}
                </label>
              );
            })}
          </div>
        </div>
        <Picker
          archiveId={archive.archiveId}
          kind="event"
          label="Events (any of)"
          value={events}
          onChange={setEvents}
        />
        <div className="field">
          <span>Kind of file</span>
          <div className="checks">
            {["image", "video", "audio"].map((kind) => (
              <label key={kind}>
                <input
                  type="checkbox"
                  checked={draft.media.includes(kind)}
                  onChange={() => setDraft({ ...draft, media: toggle(draft.media, kind) })}
                />
                {kind}
              </label>
            ))}
          </div>
        </div>
        <div className="field">
          <span>How the date is known</span>
          <div className="checks">
            {[
              ["exact", "Exact"],
              ["estimated", "Estimated"],
              ["file", "From the file"],
              ["undated", "No date"],
            ].map(([basis, label]) => (
              <label key={basis}>
                <input
                  type="checkbox"
                  checked={draft.bases.includes(basis!)}
                  onChange={() => setDraft({ ...draft, bases: toggle(draft.bases, basis!) })}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
        <label className="checks">
          <input
            type="checkbox"
            checked={draft.unidentified}
            onChange={(event) => setDraft({ ...draft, unidentified: event.target.checked })}
          />
          Only artifacts with an unidentified character
        </label>
        <label className="field">
          <span>Description contains</span>
          <input
            value={draft.q}
            onChange={(event) => setDraft({ ...draft, q: event.target.value })}
          />
        </label>
        <div className="grid2">
          <label className="field">
            <span>From day</span>
            <input
              type="date"
              value={draft.fromDay}
              onChange={(event) => setDraft({ ...draft, fromDay: event.target.value })}
            />
          </label>
          <label className="field">
            <span>To day</span>
            <input
              type="date"
              value={draft.toDay}
              onChange={(event) => setDraft({ ...draft, toDay: event.target.value })}
            />
          </label>
        </div>
      </div>
    </Modal>
  );
}
