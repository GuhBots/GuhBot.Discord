import { useState } from "react";
import { api, type ArtifactDetails } from "../api.js";
import { DateField } from "../components/DateField.js";
import { type Picked, Picker } from "../components/Picker.js";
import { shortId } from "../format.js";
import { useWindows } from "../Shell.js";
import { useArchive } from "../state.js";
import { ErrorNote, Modal } from "../ui.js";

interface Difference {
  key: string;
  current: string;
  proposed: string;
}

type Result =
  | {
      status: "created";
      artifact: ArtifactDetails;
      announcement: { status: string; reason?: string };
    }
  | {
      status: "duplicate";
      artifact: ArtifactDetails;
      differences: Difference[];
      reviewToken: string | null;
    };

const DIFFERENCE_LABELS: Record<string, string> = {
  description: "Description",
  exactDate: "Exact date",
  estimatedDate: "Estimated date",
  characters: "Add characters",
  accounts: "Add accounts",
  servers: "Add servers",
  channels: "Add channels",
  events: "Add events",
};

/** Adds one artifact from a file or a public Google Drive link, as `/archivist artifact add` does. */
export function AddArtifactModal(props: { characters?: Picked[] }) {
  const { archive, toast, changed } = useArchive();
  const windows = useWindows();
  const [file, setFile] = useState<File | null>(null);
  const [drive, setDrive] = useState("");
  const [description, setDescription] = useState("");
  const [exact, setExact] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [estimate, setEstimate] = useState("");
  const [reason, setReason] = useState("");
  const [characters, setCharacters] = useState<Picked[]>(props.characters ?? []);
  const [events, setEvents] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [review, setReview] = useState<Extract<Result, { status: "duplicate" }> | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    // Fields go before the file, so the server checks them before keeping any of it.
    const form = new FormData();
    form.append("description", description);
    if (exact.trim()) form.append("exactDate", exact);
    if (confirmed) form.append("zoneConfirmed", "true");
    if (estimate.trim()) {
      form.append("estimatedDay", estimate);
      form.append("estimateReason", reason);
    }
    for (const c of characters) form.append("characters", c.id);
    for (const e of events) form.append("events", e.id);
    if (drive.trim()) form.append("driveLink", drive.trim());
    if (file) form.append("file", file, file.name);
    try {
      const result = await api<Result>(`/api/archives/${archive.archiveId}/artifacts/intake`, {
        method: "POST",
        form,
      });
      if (result.status === "created") {
        const posted =
          result.announcement.status === "failed" || result.announcement.status === "indeterminate";
        toast(
          `Saved artifact ${shortId(result.artifact.id)}.${posted ? ` Not announced: ${result.announcement.reason ?? "the logs channel failed"}.` : ""}`,
        );
        changed();
        windows.openArtifact(result.artifact.id);
      } else if (!result.reviewToken) {
        toast("That file is already in the archive, and everything you entered matches it.");
        windows.openArtifact(result.artifact.id);
      } else {
        setReview(result);
      }
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!review?.reviewToken) return;
    setBusy(true);
    try {
      const artifact = await api<ArtifactDetails>(
        `/api/archives/${archive.archiveId}/artifacts/reviews/${review.reviewToken}/apply`,
        { method: "POST", json: { selected } },
      );
      toast(selected.length ? "Applied the changes you ticked." : "Nothing was changed.");
      changed();
      windows.openArtifact(artifact.id);
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  if (review) {
    return (
      <Modal
        title="Already in the archive"
        onClose={windows.close}
        footer={
          <>
            <button className="btn ghost" type="button" onClick={windows.close}>
              Leave it as it is
            </button>
            <button className="btn primary" type="button" disabled={busy} onClick={apply}>
              Apply ticked changes
            </button>
          </>
        }
      >
        <div className="content">
          <p style={{ margin: 0 }}>
            This file is already artifact {shortId(review.artifact.id)}. Nothing was saved yet. Tick
            what to change; links are only added, and the original file stays as it is.
          </p>
          {review.differences.map((difference) => (
            <label key={difference.key} className="review-row">
              <input
                type="checkbox"
                checked={selected.includes(difference.key)}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? [...selected, difference.key]
                      : selected.filter((key) => key !== difference.key),
                  )
                }
              />
              <span>
                <strong>{DIFFERENCE_LABELS[difference.key] ?? difference.key}</strong>
                <span className="hint">
                  {difference.current} → {difference.proposed}
                </span>
              </span>
            </label>
          ))}
          <ErrorNote error={error} />
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Add an artifact"
      wide
      onClose={windows.close}
      footer={
        <>
          <button className="btn ghost" type="button" onClick={windows.close}>
            Cancel
          </button>
          <button className="btn primary" type="button" disabled={busy} onClick={submit}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="content">
        <div className="grid2">
          <label className="field">
            <span>A file (image, video, or audio, up to 100 MiB)</span>
            <input
              type="file"
              accept="image/*,video/*,audio/*"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <label className="field">
            <span>Or a public Google Drive file link</span>
            <input
              value={drive}
              placeholder="https://drive.google.com/file/d/…"
              onChange={(event) => setDrive(event.target.value)}
            />
          </label>
        </div>
        <label className="field">
          <span>Description</span>
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <Picker
          archiveId={archive.archiveId}
          kind="character"
          label="Characters in it"
          value={characters}
          onChange={setCharacters}
        />
        <Picker
          archiveId={archive.archiveId}
          kind="event"
          label="Events it shows"
          value={events}
          onChange={setEvents}
        />
        <div className="grid2">
          <DateField
            archiveId={archive.archiveId}
            label="Exact date (optional)"
            value={exact}
            onChange={setExact}
            confirmed={confirmed}
            onConfirm={setConfirmed}
            placeholder="Jul 15 2019 6:30pm"
          />
          <DateField
            archiveId={archive.archiveId}
            label="Or an estimated day"
            value={estimate}
            onChange={setEstimate}
            placeholder="early Jul 2019"
          />
        </div>
        {estimate.trim() ? (
          <label className="field">
            <span>Why you estimate that day</span>
            <input value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
        ) : null}
        <p className="hint" style={{ margin: 0 }}>
          With no date typed, the file's own date is used when it has one.
        </p>
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}
