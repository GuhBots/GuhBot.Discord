import { createContext, useContext } from "react";
import type { ArchiveDetails, QueryValue } from "./api.js";

/** The signed-in contributor, from `/api/me`. */
export interface Me {
  user: { id: string; name: string | null; avatarUrl: string | null };
  isOwner: boolean;
  sessionExpires: string;
  preferences: { timeZone: string | null; dateOrder: "ymd" | "mdy" | "dmy" };
}

/** The shared filters. They apply in every view of one archive. */
export interface Filters {
  characters: string[];
  servers: string[];
  channels: string[];
  events: string[];
  media: string[];
  bases: string[];
  unidentified: boolean;
  q: string;
  fromDay: string;
  toDay: string;
}

export const EMPTY_FILTERS: Filters = {
  characters: [],
  servers: [],
  channels: [],
  events: [],
  media: [],
  bases: [],
  unidentified: false,
  q: "",
  fromDay: "",
  toDay: "",
};

export function filterQuery(filters: Filters): Record<string, QueryValue> {
  return {
    character: filters.characters,
    server: filters.servers,
    channel: filters.channels,
    event: filters.events,
    media: filters.media,
    basis: filters.bases,
    unidentified: filters.unidentified ? "true" : undefined,
    q: filters.q,
    fromDay: filters.fromDay,
    toDay: filters.toDay,
  };
}

export function filterCount(filters: Filters): number {
  return (
    filters.characters.length +
    filters.servers.length +
    filters.channels.length +
    filters.events.length +
    filters.media.length +
    filters.bases.length +
    (filters.unidentified ? 1 : 0) +
    (filters.q ? 1 : 0) +
    (filters.fromDay || filters.toDay ? 1 : 0)
  );
}

export interface ArchiveState {
  me: Me;
  setMe(me: Me): void;
  archive: ArchiveDetails;
  archives: { archiveId: string; name: string }[];
  filters: Filters;
  setFilters(filters: Filters): void;
  /** The day at the timeline's center. Pictures and place names follow it. */
  position: string;
  setPosition(day: string): void;
  toast(text: string): void;
  /** Counts changes, so views reload after an edit. */
  revision: number;
  changed(): void;
}

export const ArchiveContext = createContext<ArchiveState | null>(null);

export function useArchive(): ArchiveState {
  const state = useContext(ArchiveContext);
  if (!state) throw new Error("useArchive is used outside an archive.");
  return state;
}

/** Per-viewer settings kept in this browser only. Storage may be unavailable, which is fine. */
export function loadLocal<T>(key: string, fallback: T): T {
  try {
    const text = window.localStorage.getItem(key);
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveLocal(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows may refuse storage; the setting then lasts for this page only.
  }
}
