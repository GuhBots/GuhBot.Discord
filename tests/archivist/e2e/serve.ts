import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createArchivistContext } from "../../../src/archivist/context.js";
import { buildWebApp } from "../../../src/archivist/web/app.js";
import { createSession } from "../../../src/archivist/web/sessions.js";
import { MEMBER, OWNER } from "../helpers/context.js";
import { closeFixtureWriter } from "../helpers/media.js";
import { seedArchive } from "./seed.js";

/**
 * Runs the website on a made-up archive for browser checks, without Discord:
 *
 *   npm run build && npm run build:tests
 *   node .test-build/tests/archivist/e2e/serve.js [port] [base path]
 *
 * It prints the address and a session cookie for a member and for the
 * owner, and runs until stopped. Data lives in a temporary folder.
 */

const port = Number(process.argv[2] ?? 3100);
const basePath = process.argv[3] ?? "";
const dataDir = mkdtempSync(join(tmpdir(), "archivist-e2e-"));
const context = createArchivistContext({
  dataDir,
  botDb: new Database(join(dataDir, "guhbot.db")),
});
const seeded = await seedArchive(context);
await closeFixtureWriter();
const baseUrl = `http://127.0.0.1:${port}${basePath}`;
const { app } = buildWebApp({
  context,
  settings: {
    host: "127.0.0.1",
    port,
    baseUrl,
    discordClientId: "000000000000000000",
    discordClientSecret: "unused",
    sessionSecret: "e2e-only-".padEnd(64, "x"),
  },
  isOwner: async (userId) => userId === OWNER.userId,
  frontendRoot: fileURLToPath(new URL("../../../../build/web/", import.meta.url)),
  logError: (message, error) => console.error(message, error),
});
await app.listen({ host: "127.0.0.1", port });
const cookie = (actor: typeof MEMBER) =>
  app.signCookie(
    createSession(context, {
      userId: actor.userId,
      isOwner: actor.isOwner,
      displayName: actor === OWNER ? "Owner" : "Member",
      avatarUrl: null,
    }),
  );
console.log(
  JSON.stringify({
    url: `${baseUrl}/`,
    dataDir,
    archiveId: seeded.archiveId,
    ids: seeded.ids,
    member: cookie(MEMBER),
    owner: cookie(OWNER),
  }),
);
