import { useEffect, useState } from "react";
import { api, ApiError, query } from "../api.js";
import { dayText } from "../format.js";
import { useSettled } from "../Shell.js";

interface Preview {
  value: { kind: string; instantMs?: number; timezone?: string; localDateTime?: string };
  archiveDay: string;
  assumedZone: boolean;
}

/**
 * A typed date with how it will be read, using the contributor's timezone
 * and date order. A time typed without a zone must be confirmed, as Discord
 * asks for it.
 */
export function DateField(props: {
  archiveId: string;
  label: string;
  value: string;
  onChange(value: string): void;
  confirmed?: boolean;
  onConfirm?(confirmed: boolean): void;
  placeholder?: string;
  hint?: string;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const typed = useSettled(props.value, 250);
  const { onConfirm } = props;
  useEffect(() => {
    if (!typed.trim()) {
      setPreview(null);
      setProblem(null);
      return;
    }
    const controller = new AbortController();
    api<Preview>(`/api/archives/${props.archiveId}/date-preview${query({ text: typed })}`, {
      signal: controller.signal,
    })
      .then((result) => {
        setPreview(result);
        setProblem(null);
        onConfirm?.(false);
      })
      .catch((error: unknown) => {
        if ((error as Error).name === "AbortError") return;
        setPreview(null);
        setProblem(error instanceof ApiError ? error.message : "That date could not be read.");
      });
    return () => controller.abort();
  }, [typed, props.archiveId, onConfirm]);
  let reading: string | null = null;
  if (preview?.value.kind === "instant" && preview.value.instantMs !== undefined) {
    reading = `${new Date(preview.value.instantMs).toLocaleString("en-US", {
      timeZone: preview.value.timezone,
      dateStyle: "medium",
      timeStyle: "short",
    })} ${preview.value.timezone}`;
  } else if (preview) {
    reading = `${dayText(preview.archiveDay)}${preview.value.kind === "unknown_local" ? ", local time" : ""}`;
  }
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {reading ? <span className="hint">Read as {reading}</span> : null}
      {problem ? <span className="error-note">{problem}</span> : null}
      {preview?.assumedZone && props.onConfirm ? (
        <span className="checks">
          <input
            type="checkbox"
            checked={Boolean(props.confirmed)}
            onChange={(event) => props.onConfirm!(event.target.checked)}
          />
          Yes, that time is right. To use another zone, add it after the time, such as Europe/London
          or -04:00.
        </span>
      ) : null}
      {props.hint ? <span className="hint">{props.hint}</span> : null}
    </label>
  );
}
