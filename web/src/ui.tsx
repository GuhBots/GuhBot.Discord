import { type ReactNode, useEffect, useRef } from "react";
import { mediaUrl, type Picture } from "./api.js";
import { initials } from "./format.js";

/** A dialog over the page. Escape and the backdrop close it, and focus returns where it was. */
export function Modal(props: {
  title: string;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
  children: ReactNode;
  onKey?: (event: KeyboardEvent) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { onClose, onKey } = props;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>(
      "input, select, textarea, button:not(.icon-btn):not([disabled])",
    );
    first?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else onKey?.(event);
    };
    document.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("keydown", keys);
      previous?.focus?.();
    };
  }, [onClose, onKey]);
  return (
    <div
      className="backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={box}
        className={`modal ${props.wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
      >
        <header>
          <h2>{props.title}</h2>
          <button className="icon-btn" type="button" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </header>
        {props.children}
        {props.footer ? <footer>{props.footer}</footer> : <span />}
      </div>
    </div>
  );
}

/** A character's or place's picture, with initials when none is known. */
export function Avatar(props: {
  archiveId: string;
  picture: Picture | { mediaId: string | null } | null;
  name: string;
  size?: "sm" | "lg" | "xl";
  color?: string;
}) {
  const mediaId = props.picture && "mediaId" in props.picture ? props.picture.mediaId : null;
  const fallback =
    props.picture && "source" in props.picture && props.picture.source === "fallback";
  if (!mediaId) {
    return (
      <span
        className={`av ${props.size ?? ""} ${props.color ? "" : "initials"}`}
        style={props.color ? { background: props.color } : undefined}
        aria-hidden="true"
      >
        {initials(props.name)}
      </span>
    );
  }
  // Originals, so an animated GIF avatar plays as it was uploaded.
  return (
    <span className={`av ${props.size ?? ""} ${fallback ? "fallback" : ""}`} aria-hidden="true">
      <img src={mediaUrl(props.archiveId, mediaId)} alt="" loading="lazy" />
    </span>
  );
}

export function Toast(props: { text: string | null }) {
  if (!props.text) return null;
  return (
    <div className="toast" role="status">
      {props.text}
    </div>
  );
}

export function ErrorNote(props: { error: unknown }) {
  if (!props.error) return null;
  const message = props.error instanceof Error ? props.error.message : String(props.error);
  return (
    <p className="error-note" role="alert">
      {message}
    </p>
  );
}
