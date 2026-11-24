import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ArchivistError, type ErrorCode } from "../../../src/archivist/errors.js";
import { buildWebApp } from "../../../src/archivist/web/app.js";
import { WebListener } from "../../../src/archivist/web/listener.js";
import { checkWebSettings, type WebSettings } from "../../../src/archivist/web/settings.js";
import { makeArchivist } from "../helpers/context.js";
import { makeTempDir } from "../helpers/temp-dir.js";

const SETTINGS: WebSettings = {
  host: "127.0.0.1",
  port: 0,
  baseUrl: "http://localhost:3000",
  discordClientId: "123456789012345678",
  discordClientSecret: "client-secret",
  sessionSecret: "x".repeat(32),
};

function fails(code: ErrorCode, reason?: string) {
  return (error: unknown) =>
    error instanceof ArchivistError &&
    error.code === code &&
    (reason === undefined || error.details.reason === reason);
}

/** A listener on a free port with an unbuilt frontend, stopped when the test ends. */
function makeListener(
  t: TestContext,
  options: { port?: number; settings?: WebSettings; frontendRoot?: string } = {},
) {
  const { context } = makeArchivist(t);
  const errors: unknown[] = [];
  const settings = options.settings ?? SETTINGS;
  const listener = new WebListener({
    host: "127.0.0.1",
    port: options.port ?? 0,
    url: settings.baseUrl,
    build() {
      checkWebSettings(settings);
      const app = buildWebApp({
        context,
        frontendRoot: options.frontendRoot ?? makeTempDir(t),
        logError: (_message, error) => errors.push(error),
      });
      // Routes that only these tests use.
      app.get("/api/test/slow", async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { done: true };
      });
      app.get("/api/test/refused", async () => {
        throw new ArchivistError("forbidden", "Not for you.", { field: "x" });
      });
      app.get("/api/test/broken", async () => {
        throw new Error("secret path /srv/data/archive.db");
      });
      return app;
    },
  });
  t.after(() => listener.stop());
  return { listener, errors };
}

const base = (port: number) => `http://127.0.0.1:${port}`;

test("settings are checked when the website starts, naming what is missing", () => {
  assert.doesNotThrow(() => checkWebSettings(SETTINGS));
  assert.throws(
    () => checkWebSettings({ ...SETTINGS, discordClientId: undefined, sessionSecret: undefined }),
    (error: unknown) =>
      fails("invalid_input", "missing_settings")(error) &&
      /DISCORD_CLIENT_ID, ARCHIVIST_SESSION_SECRET/.test((error as Error).message),
  );
  assert.throws(
    () => checkWebSettings({ ...SETTINGS, sessionSecret: "short" }),
    fails("invalid_input", "short_session_secret"),
  );
  for (const baseUrl of ["localhost:3000", "ftp://example.com", "http://example.com/archive"]) {
    assert.throws(
      () => checkWebSettings({ ...SETTINGS, baseUrl }),
      fails("invalid_input", "invalid_base_url"),
      baseUrl,
    );
  }
});

test("the website starts once, stops once, and starts again", async (t) => {
  const { listener } = makeListener(t);
  assert.deepEqual(listener.status(), { running: false, url: null, listening: null, since: null });

  const started = await listener.start();
  assert.equal(started.running, true);
  assert.equal(started.url, "http://localhost:3000");
  const port = started.listening!.port;
  assert.ok(port > 0);

  // A repeated start reports the same listener instead of opening another.
  const again = await listener.start();
  assert.equal(again.listening!.port, port);
  assert.equal(again.since, started.since);

  const page = await fetch(base(port) + "/timeline");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /pages have not been built/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("x-frame-options"), "DENY");

  const missing = await fetch(base(port) + "/api/nothing");
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), {
    code: "not_found",
    message: "There is nothing at that address.",
    details: {},
  });

  assert.equal((await listener.stop()).running, false);
  assert.equal((await listener.stop()).running, false);
  await assert.rejects(fetch(base(port) + "/"));

  const restarted = await listener.start();
  assert.equal(restarted.running, true);
  assert.equal((await fetch(base(restarted.listening!.port) + "/")).status, 200);
});

test("a busy port is reported, and the website stays stopped until it is free", async (t) => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = (blocker.address() as AddressInfo).port;
  const { listener } = makeListener(t, { port });

  await assert.rejects(listener.start(), (error: unknown) => {
    assert.ok(fails("dependency_unavailable", "port_in_use")(error));
    assert.match((error as Error).message, /already using 127\.0\.0\.1:\d+.*ARCHIVIST_PORT/);
    return true;
  });
  assert.equal(listener.status().running, false);

  await new Promise<void>((resolve) => blocker.close(() => resolve()));
  assert.equal((await listener.start()).listening!.port, port);
});

test("missing settings stop the start without opening a port", async (t) => {
  const { listener } = makeListener(t, {
    settings: { ...SETTINGS, discordClientSecret: undefined },
  });
  await assert.rejects(listener.start(), fails("invalid_input", "missing_settings"));
  assert.equal(listener.status().running, false);
});

test("starts and stops run one at a time", async (t) => {
  const { listener } = makeListener(t);
  const [a, b] = await Promise.all([listener.start(), listener.start()]);
  assert.equal(a.listening!.port, b.listening!.port);
  const [, stopped, startedAgain, last] = await Promise.all([
    listener.stop(),
    listener.stop(),
    listener.start(),
    listener.stop(),
  ]);
  assert.equal(stopped.running, false);
  assert.equal(startedAgain.running, true);
  assert.equal(last.running, false);
  assert.equal(listener.status().running, false);
});

test("stopping waits for a request in progress", async (t) => {
  const { listener } = makeListener(t);
  const { listening } = await listener.start();
  const slow = fetch(base(listening!.port) + "/api/test/slow");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await listener.stop();
  const response = await slow;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { done: true });
});

test("errors use the shared shape, and unexpected ones hide their details", async (t) => {
  const { listener, errors } = makeListener(t);
  const { listening } = await listener.start();

  const refused = await fetch(base(listening!.port) + "/api/test/refused");
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), {
    code: "forbidden",
    message: "Not for you.",
    details: { field: "x" },
  });

  const broken = await fetch(base(listening!.port) + "/api/test/broken");
  assert.equal(broken.status, 500);
  const body = (await broken.json()) as { code: string; message: string };
  assert.equal(body.code, "internal_error");
  assert.doesNotMatch(JSON.stringify(body), /secret|\/srv/);
  assert.equal(errors.length, 1);

  const post = await fetch(base(listening!.port) + "/api/test/refused", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(post.status, 400);
  assert.equal(((await post.json()) as { code: string }).code, "invalid_input");
});

test("a built frontend serves its files, and every other page gets the app shell", async (t) => {
  const root = makeTempDir(t);
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>Shell</title>");
  writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
  const { listener } = makeListener(t, { frontendRoot: root });
  const { listening } = await listener.start();
  const url = base(listening!.port);

  const script = await fetch(url + "/assets/app.js");
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type") ?? "", /javascript/);
  for (const page of ["/", "/timeline", "/archives/abc/album"]) {
    const response = await fetch(url + page);
    assert.equal(response.status, 200, page);
    assert.equal(await response.text(), "<!doctype html><title>Shell</title>");
  }
  assert.equal((await fetch(url + "/assets/missing.js")).status, 404);
  assert.equal((await fetch(url + "/api/missing")).status, 404);
});
