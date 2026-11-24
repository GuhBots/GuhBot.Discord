import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { ArchivistContext } from "../context.js";
import { ArchivistError } from "../errors.js";

/**
 * The website's HTTP app: the JSON routes under `/api` and `/auth`, and the
 * built frontend for every other page. Routes call the same shared
 * operations as the Discord commands, so both apply the same rules.
 */

export interface WebAppOptions {
  context: ArchivistContext;
  /** The built frontend (`build/web`). Pages show a short notice when it has not been built. */
  frontendRoot: string;
  /** Records unexpected failures. Their details never reach the browser. */
  logError(message: string, error: unknown): void;
}

/** Requests larger than this are refused before any handler runs. Uploads use their own limit. */
const BODY_LIMIT_BYTES = 1024 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
};

const NOT_BUILT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>GuhBot Archivist</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1e1f22;color:#f2f3f5;font:16px/1.5 monospace}main{max-width:36rem;padding:24px}</style>
</head><body><main><h1>GuhBot Archivist</h1><p>The website is running, but its pages have not been built on this host yet.</p></main></body></html>`;

export function buildWebApp(options: WebAppOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES, trustProxy: false });

  app.addHook("onSend", async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    return payload;
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

  const built = existsSync(join(options.frontendRoot, "index.html"));
  if (built) {
    // `wildcard: false` serves only files that exist, so unknown pages fall through to the app shell.
    app.register(fastifyStatic, { root: options.frontendRoot, wildcard: false, index: false });
  }

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (
      path.startsWith("/api/") ||
      path === "/api" ||
      path.startsWith("/auth/") ||
      request.method !== "GET"
    ) {
      return reply
        .status(404)
        .send({ code: "not_found", message: "There is nothing at that address.", details: {} });
    }
    // A missing file, such as an old script name, is a plain 404 rather than the page shell.
    if (/\.[a-z0-9]+$/i.test(path)) {
      return reply
        .status(404)
        .send({ code: "not_found", message: "There is nothing at that address.", details: {} });
    }
    // Every other page is part of the single-page frontend, which routes it in the browser.
    if (built) return reply.type("text/html").sendFile("index.html");
    return reply.type("text/html").send(NOT_BUILT_PAGE);
  });

  return app;
}
