import { join } from "node:path";
import type { TestContext } from "node:test";
import Database from "better-sqlite3";
import {
  type Actor,
  type ArchivistContext,
  closeArchivistContext,
  createArchivistContext,
} from "../../../src/archivist/context.js";
import { makeTempDir } from "./temp-dir.js";

export const NOW = new Date("2026-11-23T12:00:00.000Z");

export const OWNER: Actor = { userId: "100000000000000001", isOwner: true };
export const MEMBER: Actor = { userId: "200000000000000002", isOwner: false };
export const OTHER: Actor = { userId: "300000000000000003", isOwner: false };

export interface TestArchivist {
  context: ArchivistContext;
  dataDir: string;
  /** Closes everything, as a bot restart would, and opens a fresh context on the same files. */
  restart(): ArchivistContext;
}

/** An Archivist context on a temporary data directory, closed when the test ends. */
export function makeArchivist(t: TestContext): TestArchivist {
  const dataDir = makeTempDir(t);
  let botDb = new Database(join(dataDir, "guhbot.db"));
  let context = createArchivistContext({ dataDir, botDb, now: () => NOW });
  t.after(() => {
    closeArchivistContext(context);
    botDb.close();
  });
  const archivist: TestArchivist = {
    context,
    dataDir,
    restart() {
      closeArchivistContext(context);
      botDb.close();
      botDb = new Database(join(dataDir, "guhbot.db"));
      context = createArchivistContext({ dataDir, botDb, now: () => NOW });
      archivist.context = context;
      return context;
    },
  };
  return archivist;
}
