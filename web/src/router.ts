import { useEffect, useState } from "react";
import { BASE } from "./api.js";

/**
 * A small router over the browser's history. Paths are relative to the
 * base path: `/a/<archive>/<view>`, `/a/<archive>/characters/<id>`, and
 * `/a/<archive>/places/<id>`.
 */

function currentPath(): string {
  const path = window.location.pathname;
  return (path.startsWith(BASE) ? path.slice(BASE.length) : path) || "/";
}

const listeners = new Set<() => void>();

export function navigate(path: string, replace = false): void {
  const target = `${BASE}${path}`;
  if (replace) window.history.replaceState(null, "", target);
  else window.history.pushState(null, "", target);
  for (const listener of listeners) listener();
}

export function usePath(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const update = () => setPath(currentPath());
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return path;
}

export const VIEWS = ["timeline", "album", "places", "graph", "heatmap", "board"] as const;
export type View = (typeof VIEWS)[number];

export type Route =
  | { kind: "home" }
  | { kind: "view"; archiveId: string; view: View }
  | { kind: "character"; archiveId: string; id: string }
  | { kind: "place"; archiveId: string; id: string };

export function parseRoute(path: string): Route {
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "a" || !parts[1]) return { kind: "home" };
  const archiveId = parts[1];
  if (parts[2] === "characters" && parts[3]) return { kind: "character", archiveId, id: parts[3] };
  if (parts[2] === "places" && parts[3]) return { kind: "place", archiveId, id: parts[3] };
  const view = VIEWS.includes(parts[2] as View) ? (parts[2] as View) : "timeline";
  return { kind: "view", archiveId, view };
}

export const viewPath = (archiveId: string, view: View) => `/a/${archiveId}/${view}`;
export const characterPath = (archiveId: string, id: string) => `/a/${archiveId}/characters/${id}`;
export const placePath = (archiveId: string, id: string) => `/a/${archiveId}/places/${id}`;
