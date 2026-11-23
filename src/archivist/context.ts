import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openArchiveDatabase } from "./archive-database.js";
import { SYSTEM_EDITOR, syncGaps } from "./board.js";
import { ArchivistError } from "./errors.js";
import { nameKey, timestamp } from "./fields.js";
import {
  type ArchiveStore,
  type FollowUp,
  type MutationHooks,
  recoverPendingMutation,
} from "./mutations.js";
import { prepareOperationalDatabase } from "./operational-database.js";
import { archiveFolder, archivistPaths, type ArchivistPaths } from "./paths.js";

/** The contributor performing an operation. Adapters decide `isOwner` from the bot's owner rule. */
export interface Actor {
  userId: string;
  isOwner: boolean;
}

/**
 * Shared state for every Archivist operation. The bot creates one context at
 * startup, and the Discord commands and web routes both use it, so they
 * share the same open archives and rules.
 */
export interface ArchivistContext {
  paths: ArchivistPaths;
  botDb: Database.Database;
  now(): Date;
  stores: Map<string, ArchiveStore>;
}

export interface ContextOptions {
  dataDir: string;
  botDb: Database.Database;
  now?: () => Date;
}

export function createArchivistContext(options: ContextOptions): ArchivistContext {
  const paths = archivistPaths(options.dataDir);
  for (const dir of [paths.archivesRoot, paths.tmpDir, paths.exportsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  prepareOperationalDatabase(options.botDb);
  return {
    paths,
    botDb: options.botDb,
    now: options.now ?? (() => new Date()),
    stores: new Map(),
  };
}

/** Closes every open archive. The bot database belongs to the bot and stays open. */
export function closeArchivistContext(context: ArchivistContext): void {
  for (const store of context.stores.values()) store.db.close();
  context.stores.clear();
}

/** Applies the bot-database follow-ups of archive mutations. Each is safe to repeat. */
export function mutationHooks(context: ArchivistContext): MutationHooks {
  return {
    applyFollowUp(followUp: FollowUp) {
      if (followUp.kind === "archive_name") {
        const name = String(followUp.name);
        context.botDb
          .prepare("UPDATE archivist_archives SET name = ?, name_key = ? WHERE archive_id = ?")
          .run(name, nameKey(name), String(followUp.archiveId));
        return;
      }
      throw new Error(`Unknown follow-up ${followUp.kind}`);
    },
  };
}

export function journalFile(context: ArchivistContext, archiveId: string): string {
  return join(context.paths.tmpDir, "journals", `${archiveId}.json`);
}

/**
 * Opens a registered archive, or returns it if already open, and finishes
 * any change an earlier run left unfinished. Callers check access first.
 */
export function openStore(context: ArchivistContext, archiveId: string): ArchiveStore {
  const open = context.stores.get(archiveId);
  if (open) return open;
  const folder = archiveFolder(context.paths, archiveId);
  const file = join(folder, "archive.db");
  if (!existsSync(file)) {
    throw new ArchivistError(
      "dependency_unavailable",
      "This archive's folder is missing. Ask the bot owner to check its files.",
      { archiveId },
    );
  }
  const store: ArchiveStore = {
    archiveId,
    folder,
    db: openArchiveDatabase(file),
    journalFile: journalFile(context, archiveId),
  };
  try {
    recoverPendingMutation(store, mutationHooks(context));
    // Archives from before the research board, or edited elsewhere, get
    // their derived gap cards in line before anyone reads them.
    store.db.transaction(() => syncGaps(store.db, timestamp(context.now()), SYSTEM_EDITOR))();
  } catch (error) {
    store.db.close();
    throw error;
  }
  context.stores.set(archiveId, store);
  return store;
}

/** Closes one archive, such as after unregistering it. */
export function closeStore(context: ArchivistContext, archiveId: string): void {
  context.stores.get(archiveId)?.db.close();
  context.stores.delete(archiveId);
}
