import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type ArtifactPage, type EventDetails, query } from "../api.js";
import { DateField } from "../components/DateField.js";
import { Thumb } from "../components/Media.js";
import { type Picked, Picker } from "../components/Picker.js";
import { dayText } from "../format.js";
import { characterPath, navigate } from "../router.js";
import { useWindows } from "../Shell.js";
import { useArchive } from "../state.js";
import { ErrorNote, Modal } from "../ui.js";

type Loaded = EventDetails & { names: Record<string, string> };

export function eventWhen(event: EventDetails): string {
  const start = dayText(event.start.archiveDay);
  const end = event.end ? dayText(event.end.archiveDay) : start;
  const around = event.certainty === "estimated" ? "around " : "";
  if (event.dateKind === "single") return `${around ? "Around " : ""}${start}`;
  if (event.dateKind === "duration") return `Lasted from ${around}${start} to ${end}`;
  return `Happened sometime between ${start} and ${end}`;
}

/** An event: when, who, where, and the artifacts that support it. */
export function EventModal(props: { id: string }) {
  const { archive, toast, changed } = useArchive();
  const windows = useWindows();
  const [event, setEvent] = useState<Loaded | null>(null);
  const [support, setSupport] = useState<ArtifactPage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const base = `/api/archives/${archive.archiveId}/events/${props.id}`;
  const load = useCallback(() => {
    api<Loaded>(base).then(setEvent).catch(setError);
    api<ArtifactPage>(
      `/api/archives/${archive.archiveId}/artifacts${query({ event: props.id, limit: 60 })}`,
    )
      .then(setSupport)
      .catch(() => undefined);
  }, [base, archive.archiveId, props.id]);
  useEffect(load, [load]);

  if (!event) {
    return (
      <Modal title="Event" onClose={windows.close}>
        <div className="content">{error ? <ErrorNote error={error} /> : "Loading…"}</div>
      </Modal>
    );
  }
  if (confirmDelete) {
    return (
      <Modal
        title={`Delete ${event.title}?`}
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <button className="btn ghost" type="button" onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
            <button
              className="btn danger"
              type="button"
              onClick={async () => {
                try {
                  await api(`${base}?expectedVersion=${event.version}`, { method: "DELETE" });
                  toast("Deleted the event. The artifacts that supported it stay.");
                  changed();
                  windows.close();
                } catch (failure) {
                  setError(failure);
                  setConfirmDelete(false);
                }
              }}
            >
              Delete permanently
            </button>
          </>
        }
      >
        <div className="content">
          <p style={{ margin: 0 }}>
            This is permanent. Its links and its own edit history are removed. The artifacts that
            supported it stay.
          </p>
        </div>
      </Modal>
    );
  }
  const places = [...event.links.servers, ...event.links.channels];
  const ids = support?.items.map((item) => item.id) ?? [];
  return (
    <Modal
      title={event.title}
      wide
      onClose={windows.close}
      footer={
        <>
          <button
            className="btn danger"
            type="button"
            onClick={async () => {
              // A request that uses the event as its date blocks deletion before any confirmation.
              try {
                const requests = await api<{
                  items: { constraint: { anchorEventId: string | null } }[];
                }>(`/api/archives/${archive.archiveId}/requests`);
                const anchored = requests.items.filter(
                  (r) => r.constraint.anchorEventId === event.id,
                ).length;
                if (anchored) {
                  setError(
                    new Error(
                      `${anchored} missing-media request${anchored === 1 ? " uses" : "s use"} this event as ${anchored === 1 ? "its" : "their"} date. Give ${anchored === 1 ? "it" : "them"} another date first.`,
                    ),
                  );
                  return;
                }
              } catch {
                // The delete itself still refuses if the check could not run.
              }
              setConfirmDelete(true);
            }}
          >
            Delete
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={() => windows.show(<EventFormModal event={event} />)}
          >
            Edit
          </button>
        </>
      }
    >
      <div className="content">
        <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{event.description}</p>
        <dl className="kv">
          <dt>When</dt>
          <dd>
            {eventWhen(event)} ({event.certainty})
          </dd>
          <dt>Characters</dt>
          <dd>
            {event.links.characters.length
              ? event.links.characters.map((id, i) => (
                  <span key={id}>
                    {i ? ", " : ""}
                    <button
                      className="linkish"
                      type="button"
                      onClick={() => {
                        windows.close();
                        navigate(characterPath(archive.archiveId, id));
                      }}
                    >
                      {event.names[id] ?? id.slice(0, 8)}
                    </button>
                  </span>
                ))
              : "None linked"}
          </dd>
          <dt>Places</dt>
          <dd>
            {places.length
              ? places.map((id) => event.names[id] ?? id.slice(0, 8)).join(", ")
              : "None linked"}
          </dd>
          {event.disputedReason ? (
            <>
              <dt>Disputed</dt>
              <dd>{event.disputedReason}</dd>
            </>
          ) : null}
        </dl>
        <div className="field">
          <span>Supporting artifacts ({support?.total ?? "…"})</span>
          {support && !support.items.length ? (
            <span className="flag" style={{ justifySelf: "start" }}>
              No supporting artifacts
            </span>
          ) : (
            <div className="thumbs">
              {support?.items.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  aria-label={item.description}
                  onClick={() => windows.openArtifact(item.id, { ids, index, title: event.title })}
                >
                  <Thumb archiveId={archive.archiveId} media={item.media} />
                </button>
              ))}
            </div>
          )}
        </div>
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}

const KINDS: [EventDetails["dateKind"], string][] = [
  ["single", "One day"],
  ["duration", "Lasted across a range"],
  ["occurrence_window", "Happened sometime within a range"],
];

/** Adds an event, or edits one. No evidence or explanation is needed. */
export function EventFormModal(props: { event?: Loaded }) {
  const { archive, toast, changed } = useArchive();
  const windows = useWindows();
  const existing = props.event;
  const [title, setTitle] = useState(existing?.title ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [dateKind, setDateKind] = useState<EventDetails["dateKind"]>(
    existing?.dateKind ?? "single",
  );
  const [certainty, setCertainty] = useState<EventDetails["certainty"]>(
    existing?.certainty ?? "exact",
  );
  const [start, setStart] = useState(existing?.start.originalText ?? "");
  const [end, setEnd] = useState(existing?.end?.originalText ?? "");
  const [disputed, setDisputed] = useState(existing?.disputedReason ?? "");
  const named = (ids: string[] = []): Picked[] =>
    ids.map((id) => ({ id, label: existing?.names[id] ?? id.slice(0, 8) }));
  const [characters, setCharacters] = useState<Picked[]>(named(existing?.links.characters));
  const [servers, setServers] = useState<Picked[]>(named(existing?.links.servers));
  const [channels, setChannels] = useState<Picked[]>(named(existing?.links.channels));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    const links = {
      characters: characters.map((c) => c.id),
      servers: servers.map((s) => s.id),
      channels: channels.map((c) => c.id),
    };
    try {
      if (!existing) {
        const created = await api<EventDetails>(`/api/archives/${archive.archiveId}/events`, {
          method: "POST",
          json: {
            title,
            description,
            dateKind,
            certainty,
            start,
            end: dateKind === "single" ? undefined : end,
            links,
          },
        });
        toast(`Added the event ${created.title}.`);
        changed();
        windows.openEvent(created.id);
        return;
      }
      const before = existing.links;
      const added = (now: string[], was: string[]) => now.filter((id) => !was.includes(id));
      const patch: Record<string, unknown> = { expectedVersion: existing.version };
      if (title !== existing.title) patch.title = title;
      if (description !== existing.description) patch.description = description;
      if (disputed !== (existing.disputedReason ?? ""))
        patch.disputedReason = disputed.trim() ? disputed : null;
      const datesChanged =
        dateKind !== existing.dateKind ||
        certainty !== existing.certainty ||
        start !== existing.start.originalText ||
        end !== (existing.end?.originalText ?? "");
      if (datesChanged)
        Object.assign(patch, {
          dateKind,
          certainty,
          start,
          end: dateKind === "single" ? null : end,
        });
      patch.addLinks = {
        characters: added(links.characters, before.characters),
        servers: added(links.servers, before.servers),
        channels: added(links.channels, before.channels),
      };
      patch.removeLinks = {
        characters: added(before.characters, links.characters),
        servers: added(before.servers, links.servers),
        channels: added(before.channels, links.channels),
      };
      await api(`/api/archives/${archive.archiveId}/events/${existing.id}`, {
        method: "PATCH",
        json: patch,
      });
      toast("Saved.");
      changed();
      windows.openEvent(existing.id);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.code === "stale_version"
          ? new Error(
              "Someone else changed this event. Close this form and open it again to see their changes.",
            )
          : failure,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={existing ? `Edit ${existing.title}` : "Add an event"}
      wide
      onClose={windows.close}
      footer={
        <>
          <button
            className="btn ghost"
            type="button"
            onClick={() => (existing ? windows.openEvent(existing.id) : windows.close())}
          >
            Cancel
          </button>
          <button className="btn primary" type="button" disabled={busy} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="content">
        <label className="field">
          <span>Title</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <div className="field">
          <span>When</span>
          <div className="checks">
            {KINDS.map(([kind, label]) => (
              <label key={kind}>
                <input
                  type="radio"
                  name="date-kind"
                  checked={dateKind === kind}
                  onChange={() => setDateKind(kind)}
                />
                {label}
              </label>
            ))}
          </div>
          <div className="checks">
            <label>
              <input
                type="radio"
                name="certainty"
                checked={certainty === "exact"}
                onChange={() => setCertainty("exact")}
              />
              Exact
            </label>
            <label>
              <input
                type="radio"
                name="certainty"
                checked={certainty === "estimated"}
                onChange={() => setCertainty("estimated")}
              />
              Estimated
            </label>
          </div>
        </div>
        <div className="grid2">
          <DateField
            archiveId={archive.archiveId}
            label={dateKind === "single" ? "Day" : "Start"}
            value={start}
            onChange={setStart}
            placeholder="Jun 1 2020"
          />
          {dateKind === "single" ? null : (
            <DateField
              archiveId={archive.archiveId}
              label={dateKind === "duration" ? "End" : "Latest possible day"}
              value={end}
              onChange={setEnd}
              placeholder="Aug 31 2020"
            />
          )}
        </div>
        <Picker
          archiveId={archive.archiveId}
          kind="character"
          label="Characters"
          value={characters}
          onChange={setCharacters}
        />
        <div className="grid2">
          <Picker
            archiveId={archive.archiveId}
            kind="server"
            label="Servers"
            value={servers}
            onChange={setServers}
          />
          <Picker
            archiveId={archive.archiveId}
            kind="channel"
            label="Channels or group chats"
            value={channels}
            onChange={setChannels}
          />
        </div>
        {existing ? (
          <label className="field">
            <span>Disputed (optional): why the date or details are in question</span>
            <input value={disputed} onChange={(event) => setDisputed(event.target.value)} />
          </label>
        ) : null}
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}
