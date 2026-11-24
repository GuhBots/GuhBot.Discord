import { useEffect, useState } from "react";
import { api, type CharacterSummary, query } from "../api.js";

/** Every character's name by ID, fetched once per archive and change, for rows that list who is in an artifact. */
const cache = new Map<string, Promise<Record<string, string>>>();

export function useCharacterNames(archiveId: string, revision: number): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    const key = `${archiveId}:${revision}`;
    let load = cache.get(key);
    if (!load) {
      for (const cachedKey of cache.keys()) {
        if (cachedKey.startsWith(`${archiveId}:`)) cache.delete(cachedKey);
      }
      load = (async () => {
        const all: Record<string, string> = {};
        let cursor: string | null = null;
        do {
          const page: { items: CharacterSummary[]; next: string | null } = await api(
            `/api/archives/${archiveId}/entities/character${query({ limit: 100, cursor })}`,
          );
          for (const item of page.items) all[item.id] = item.knownName;
          cursor = page.next;
        } while (cursor);
        return all;
      })();
      cache.set(key, load);
    }
    let live = true;
    load.then((result) => live && setNames(result)).catch(() => cache.delete(key));
    return () => {
      live = false;
    };
  }, [archiveId, revision]);
  return names;
}
