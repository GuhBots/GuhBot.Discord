import type {} from "@fastify/cookie";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Actor, ArchivistContext } from "../../../src/archivist/context.js";
import { buildWebApp } from "../../../src/archivist/web/app.js";
import { createSession } from "../../../src/archivist/web/sessions.js";
import { checkWebSettings, type WebSettings } from "../../../src/archivist/web/settings.js";
import { makeArchivist, NOW } from "./context.js";
import { makeTempDir } from "./temp-dir.js";

export const WEB_SETTINGS: WebSettings = {
  host: "127.0.0.1",
  port: 0,
  baseUrl: "http://localhost:3000",
  discordClientId: "707321853198467163",
  discordClientSecret: "test-client-secret",
  sessionSecret: "s".repeat(64),
};

export interface WebHarness {
  app: FastifyInstance;
  context: ArchivistContext;
  /** Moves the clock the website and its sessions use. */
  clock: { ms: number };
  origin: string;
  /** A signed session cookie for the actor, as if they had signed in with Discord. */
  cookie(actor: Actor): string;
}

/** The website on an in-memory request injector, with a temporary data directory. */
export async function webHarness(
  t: TestContext,
  settings: WebSettings = WEB_SETTINGS,
): Promise<WebHarness> {
  checkWebSettings(settings);
  const { context } = makeArchivist(t);
  const clock = { ms: NOW.getTime() };
  context.now = () => new Date(clock.ms);
  const { app } = buildWebApp({
    context,
    settings,
    isOwner: async () => false,
    frontendRoot: makeTempDir(t),
    logError: (message, error) => {
      throw new Error(`Unexpected website failure: ${message}`, { cause: error });
    },
    fetch: (async () => {
      throw new Error("Tests do not reach Discord.");
    }) as typeof fetch,
  });
  await app.ready();
  t.after(() => app.close());
  return {
    app,
    context,
    clock,
    origin: new URL(settings.baseUrl).origin,
    cookie(actor) {
      const token = createSession(context, {
        userId: actor.userId,
        isOwner: actor.isOwner,
        displayName: "Tester",
        avatarUrl: null,
      });
      return app.signCookie(token);
    },
  };
}
