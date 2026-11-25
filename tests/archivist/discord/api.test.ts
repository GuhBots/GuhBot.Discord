import assert from "node:assert/strict";
import { test } from "node:test";
import { ArchivistApi, archivePath } from "../../../src/lib/archivist-api.js";
import { ArchivistError } from "../../../src/lib/archivist-errors.js";

const TOKEN = "f".repeat(64);
const USER = "200000000000000002";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: RequestInit["redirect"];
}

/** A fake fetch that answers from a list, recording what was sent. */
function fakeFetch(answers: (Response | Error)[]) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    seen.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body,
      redirect: init.redirect,
    });
    const answer = answers.shift();
    if (!answer) throw new Error("no more answers");
    if (answer instanceof Error) throw answer;
    return answer;
  }) as typeof fetch;
  return { fetchImpl, seen };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(answers: (Response | Error)[]) {
  const { fetchImpl, seen } = fakeFetch(answers);
  const waits: number[] = [];
  const api = new ArchivistApi({
    baseUrl: "https://example.com/archivist/",
    token: TOKEN,
    fetch: fetchImpl,
    sleep: async (ms) => void waits.push(ms),
  });
  return { api, seen, waits };
}

function fails(code: string, reason?: string) {
  return (error: unknown) =>
    error instanceof ArchivistError &&
    error.code === code &&
    (reason === undefined || error.details.reason === reason);
}

test("requests carry the token, name the contributor, and refuse to follow redirects", async () => {
  const { api, seen } = client([
    json(200, { archives: [] }),
    json(200, { ok: true }),
    json(200, { items: [] }),
  ]);
  assert.deepEqual(await api.get(USER, "/api/archives", { character: ["a", "b"], q: "" }), {
    archives: [],
  });
  await api.post(USER, "/api/me/archive-selection", { archiveId: "x" });
  await api.service("POST", "/api/service/announcements/claim", { limit: 2 });

  assert.equal(seen[0]!.url, "https://example.com/archivist/api/archives?character=a&character=b");
  assert.equal(seen[0]!.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[0]!.headers["x-archivist-user"], USER);
  assert.equal(seen[0]!.redirect, "manual");
  assert.equal(seen[1]!.method, "POST");
  assert.equal(seen[1]!.headers["content-type"], "application/json");
  assert.equal(seen[1]!.body, JSON.stringify({ archiveId: "x" }));
  // The bot's own routes act for nobody.
  assert.equal(seen[2]!.headers["x-archivist-user"], undefined);
  assert.equal(seen[2]!.headers.authorization, `Bearer ${TOKEN}`);
});

test("uploads pass the form through, and an empty reply is undefined", async () => {
  const { api, seen } = client([
    json(201, { status: "created" }),
    new Response(null, { status: 204 }),
  ]);
  const form = new FormData();
  form.append("description", "Photo");
  await api.upload(USER, "/api/archives/a/artifacts/intake", form);
  assert.equal(seen[0]!.body, form);
  assert.equal(seen[0]!.headers["content-type"], undefined, "fetch sets the multipart boundary");
  assert.equal(
    await api.delete(USER, "/api/archives/a/artifacts/b", { expectedVersion: 2 }),
    undefined,
  );
  assert.equal(
    seen[1]!.url,
    "https://example.com/archivist/api/archives/a/artifacts/b?expectedVersion=2",
  );
});

test("the service's errors keep their code and message, and a 401 is the operator's problem", async () => {
  const { api } = client([
    json(409, {
      code: "stale_version",
      message: "Someone else changed this.",
      details: { currentVersion: 3 },
    }),
    json(401, {
      code: "no_session",
      message: "That service credential is not valid.",
      details: {},
    }),
    json(500, { code: "internal_error", message: "Archivist could not finish that.", details: {} }),
    new Response("<html>bad gateway</html>", { status: 418 }),
  ]);
  await assert.rejects(api.patch(USER, "/x", {}), (error: unknown) => {
    assert.ok(error instanceof ArchivistError);
    assert.equal(error.code, "stale_version");
    assert.equal(error.status, 409);
    assert.deepEqual(error.details, { currentVersion: 3 });
    return true;
  });
  await assert.rejects(api.post(USER, "/x"), fails("dependency_unavailable", "service_auth"));
  await assert.rejects(api.post(USER, "/x"), fails("internal_error"));
  await assert.rejects(api.post(USER, "/x"), fails("dependency_unavailable"));
});

test("a redirect is refused so the token never reaches another address", async () => {
  const { api } = client([
    new Response(null, { status: 301, headers: { location: "https://elsewhere.example/" } }),
  ]);
  await assert.rejects(api.post(USER, "/x"), fails("dependency_unavailable", "redirected"));
});

test("reads are retried twice when the service is briefly unreachable", async () => {
  const flaky = client([new TypeError("fetch failed"), json(503, {}), json(200, { ok: true })]);
  assert.deepEqual(await flaky.api.get(USER, "/x"), { ok: true });
  assert.deepEqual(flaky.waits, [500, 1_500]);

  const down = client([
    new TypeError("fetch failed"),
    new TypeError("fetch failed"),
    new TypeError("fetch failed"),
  ]);
  await assert.rejects(
    down.api.get(USER, "/x"),
    fails("dependency_unavailable", "service_unreachable"),
  );
  assert.equal(down.seen.length, 3);
});

test("changes are never retried, because the service may have saved them", async () => {
  const { api, seen } = client([new TypeError("fetch failed"), json(200, {})]);
  await assert.rejects(api.post(USER, "/x", {}), (error: unknown) => {
    assert.ok(fails("dependency_unavailable", "service_unreachable")(error));
    assert.match((error as Error).message, /may or may not have been saved/);
    return true;
  });
  assert.equal(seen.length, 1);

  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const slow = client([timeout]);
  await assert.rejects(
    slow.api.patch(USER, "/x", {}),
    fails("dependency_unavailable", "service_timeout"),
  );
});

test("bytes download as a buffer, and paths encode each part", async () => {
  const { api } = client([new Response(new Uint8Array([1, 2, 3]))]);
  assert.deepEqual(await api.bytes(null, "/preview"), Buffer.from([1, 2, 3]));
  assert.equal(
    archivePath("a b", "entities", "character", "x/y"),
    "/api/archives/a%20b/entities/character/x%2Fy",
  );
});
