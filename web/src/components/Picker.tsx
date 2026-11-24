import { useEffect, useState } from "react";
import { api, query } from "../api.js";
import { useSettled } from "../Shell.js";

export interface Picked {
  id: string;
  label: string;
}

/** Chooses characters or events by typing their name. Chosen ones show as removable chips. */
export function Picker(props: {
  archiveId: string;
  kind: "character" | "event" | "account" | "server" | "channel";
  label: string;
  value: Picked[];
  onChange(value: Picked[]): void;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [hits, setHits] = useState<Picked[]>([]);
  const typed = useSettled(text, 180);
  useEffect(() => {
    if (!typed.trim()) {
      setHits([]);
      return;
    }
    const controller = new AbortController();
    const path =
      props.kind === "event"
        ? `/api/archives/${props.archiveId}/events${query({ q: typed, limit: 8 })}`
        : `/api/archives/${props.archiveId}/entities/${props.kind}${query({ q: typed, limit: 8 })}`;
    api<{ items: { id: string; label?: string; title?: string }[] }>(path, {
      signal: controller.signal,
    })
      .then((data) =>
        setHits(
          data.items.map((item) => ({ id: item.id, label: item.label ?? item.title ?? item.id })),
        ),
      )
      .catch(() => undefined);
    return () => controller.abort();
  }, [typed, props.kind, props.archiveId]);
  const chosen = new Set(props.value.map((item) => item.id));
  return (
    <div className="field picker">
      <span>{props.label}</span>
      {props.value.length ? (
        <div className="chips">
          {props.value.map((item) => (
            <span key={item.id} className="chip">
              {item.label}
              <button
                type="button"
                aria-label={`Remove ${item.label}`}
                onClick={() => props.onChange(props.value.filter((other) => other.id !== item.id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <input
        value={text}
        placeholder={props.placeholder ?? "Start typing a name"}
        aria-label={props.label}
        onChange={(event) => setText(event.target.value)}
      />
      {hits.length ? (
        <div className="picker-hits">
          {hits
            .filter((hit) => !chosen.has(hit.id))
            .map((hit) => (
              <button
                key={hit.id}
                type="button"
                onClick={() => {
                  props.onChange([...props.value, hit]);
                  setText("");
                  setHits([]);
                }}
              >
                {hit.label} <small>{hit.id.slice(0, 8)}</small>
              </button>
            ))}
        </div>
      ) : null}
    </div>
  );
}
