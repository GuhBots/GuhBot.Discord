import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { ArchivistContext } from "../context.js";
import { ArchivistError } from "../errors.js";
import { MAX_MEDIA_BYTES } from "../media.js";
import { type Auth, createAuth } from "./auth.js";
import { registerChangeRoutes } from "./change-routes.js";
import { type IntakeOptions, registerIntakeRoutes } from "./intake-routes.js";
import { registerMediaRoutes } from "./media-routes.js";
import { registerReadRoutes } from "./read-routes.js";
import { registerViewRoutes } from "./view-routes.js";
import type { Fetch } from "./discord-oauth.js";
import { basePathOf, redirectUriOf, type WebSettings } from "./settings.js";

/**
 * The website's HTTP app: sign-in, the JSON routes under `/api`, and the
 * built frontend for every other page, all under the base path. Routes call
 * the same shared operations as the Discord commands, so both apply the same
 * rules. Nothing here depends on the Discord bot, so the website can later
 * run as its own service.
 */

export interface WebAppOptions {
  context: ArchivistContext;
  /** Already checked with `checkWebSettings`. */
  settings: WebSettings;
  /** Whether a Discord user owns the bot's application. */
  isOwner(userId: string): Promise<boolean>;
  /** The built frontend (`build/web`). Pages show a short notice when it has not been built. */
  frontendRoot: string;
  /** Records unexpected failures. Their details never reach the browser. */
  logError(message: string, error: unknown): void;
  /** Replaced in tests, which stand in for Discord and Google Drive. */
  fetch?: Fetch;
  /** Posts web uploads to the logs channel. The bot provides it. */
  announce?: IntakeOptions["announce"];
  /** Checks a Discord channel chosen for announcements. The bot provides it. */
  checkAnnouncementChannel?: IntakeOptions["checkAnnouncementChannel"];
  /** Switches Drive links to Google's official API, as in Discord. */
  driveApiKey?: string;
}

/** Requests larger than this are refused before any handler runs. Uploads use their own limit. */
const BODY_LIMIT_BYTES = 1024 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const NOT_BUILT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>GuhBot Archivist</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1e1f22;color:#f2f3f5;font:16px/1.5 monospace}main{max-width:36rem;padding:24px}</style>
</head><body><main><h1>GuhBot Archivist</h1><p>The website is running, but its pages have not been built on this host yet.</p></main></body></html>`;

function notFound() {
  return { code: "not_found", message: "There is nothing at that address.", details: {} };
}

export interface WebApp {
  app: FastifyInstance;
  auth: Auth;
}

export function buildWebApp(options: WebAppOptions): WebApp {
  const { settings } = options;
  const origin = new URL(settings.baseUrl).origin;
  const basePath = basePathOf(settings.baseUrl);
  const app = Fastify({
    logger: false,
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: false,
    ignoreTrailingSlash: true,
  });
  app.register(fastifyCookie, { secret: settings.sessionSecret! });

  app.addHook("onSend", async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    return payload;
  });

  // Changes must come from the website's own pages. Browsers send Origin on
  // every such request, so a cross-site form or script is refused.
  app.addHook("onRequest", async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    const from = request.headers.origin;
    const sameSite =
      from === origin || (!from && request.headers["sec-fetch-site"] === "same-origin");
    if (!sameSite) {
      throw new ArchivistError(
        "forbidden",
        "That change must come from the Archivist website itself.",
        {
          reason: "cross_origin",
        },
      );
    }
  });

  app.setErrorHandler((error: FastifyError | ArchivistError, request, reply) => {
    if (error instanceof ArchivistError) {
      return reply.status(error.status).send(error.toJSON());
    }
    // Fastify's own request errors, such as a malformed body or a body that is too large.
    if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      const tooLarge = error.statusCode === 413;
      return reply.status(tooLarge ? 413 : 400).send({
        code: tooLarge ? "media_too_large" : "invalid_input",
        message: tooLarge ? "That request is too large." : "That request could not be read.",
        details: {},
      });
    }
    options.logError(`${request.method} ${request.url} failed`, error);
    return reply.status(500).send({
      code: "internal_error",
      message:
        "Archivist could not finish that. Nothing was half-saved. Try again, and tell the bot owner if it keeps happening.",
      details: {},
    });
  });

  const auth = createAuth({
    context: options.context,
    oauth: {
      clientId: settings.discordClientId!,
      clientSecret: settings.discordClientSecret!,
      redirectUri: redirectUriOf(settings.baseUrl),
    },
    basePath,
    secure: origin.startsWith("https:"),
    isOwner: options.isOwner,
    fetch: options.fetch ?? fetch,
    logError: options.logError,
  });

  const built = existsSync(join(options.frontendRoot, "index.html"));

  app.register(
    async (scope) => {
      auth.register(scope);
      registerReadRoutes(scope, options.context, auth);
      registerChangeRoutes(scope, options.context, auth);
      registerViewRoutes(scope, options.context, auth);
      // Serves the built frontend, and gives routes `reply.sendFile` for media either way.
      // `wildcard: false` serves only files that exist, so other pages fall through to the app shell.
      await scope.register(fastifyStatic, {
        root: built ? options.frontendRoot : options.context.paths.archivesRoot,
        serve: built,
        wildcard: false,
        index: false,
      });
      registerMediaRoutes(scope, options.context, auth);
      await scope.register(fastifyMultipart, { limits: { fileSize: MAX_MEDIA_BYTES, files: 1 } });
      registerIntakeRoutes(scope, {
        context: options.context,
        auth,
        announce: options.announce,
        checkAnnouncementChannel: options.checkAnnouncementChannel,
        driveApiKey: options.driveApiKey,
        fetch: options.fetch ?? fetch,
        logError: options.logError,
      });
      scope.setNotFoundHandler((request, reply) => {
        const path = (request.url.split("?")[0] ?? "").slice(basePath.length);
        if (
          path.startsWith("/api/") ||
          path === "/api" ||
          path.startsWith("/auth/") ||
          request.method !== "GET"
        ) {
          return reply.status(404).send(notFound());
        }
        // A missing file, such as an old script name, is a plain 404 rather than the page shell.
        if (/\.[a-z0-9]+$/i.test(path)) return reply.status(404).send(notFound());
        // Every other page is part of the single-page frontend, which routes it in the browser.
        if (built) return reply.type("text/html").sendFile("index.html");
        return reply.type("text/html").send(NOT_BUILT_PAGE);
      });
    },
    { prefix: basePath },
  );
  // Addresses outside the base path belong to whatever else the host serves.
  if (basePath) app.setNotFoundHandler((_request, reply) => reply.status(404).send(notFound()));

  return { app, auth };
}
