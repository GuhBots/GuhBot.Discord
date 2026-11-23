import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  type DownloadLimits,
  downloadDiscordAttachment,
  type Fetch,
} from "../../../src/archivist/download.js";
import { DriveClient, parseDriveLink } from "../../../src/archivist/drive.js";
import { ArchivistError, type ErrorCode } from "../../../src/archivist/errors.js";
import { makeTempDir } from "../helpers/temp-dir.js";

const FILE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_-012";
const API_KEY = "test-api-key-should-never-leak";
const LIMITS: DownloadLimits = {
  maxBytes: 1000,
  stallMs: 60,
  totalMs: 3000,
  retryDelaysMs: [10, 30],
};

function fails(code: ErrorCode) {
  return (error: unknown) => {
    assert.ok(error instanceof ArchivistError, String(error));
    assert.equal(error.code, code, error.message);
    assert.equal(
      JSON.stringify({ message: error.message, details: error.details }).includes(API_KEY),
      false,
    );
    return true;
  };
}

interface Call {
  url: URL;
  headers: Record<string, string>;
}

/** A fetch that answers each call with the next response in the list. */
function scripted(responses: (Response | Error | (() => Response))[]): {
  fetch: Fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: new URL(String(input)),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = responses.shift();
    if (!next) throw new Error("No scripted response left");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  }) as Fetch;
  return { fetch: fetchImpl, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const PHOTO = {
  id: FILE_ID,
  name: "photo.jpg",
  mimeType: "image/jpeg",
  size: "4",
  trashed: false,
  capabilities: { canDownload: true },
};

test("Drive file links of every supported form name the same file", () => {
  const forms = [
    `https://drive.google.com/file/d/${FILE_ID}/view?usp=sharing`,
    `https://drive.google.com/file/d/${FILE_ID}/view?usp=drive_link&resourcekey=0-AbC_d`,
    `https://drive.google.com/open?id=${FILE_ID}&resourcekey=0-AbC_d`,
    `https://drive.google.com/uc?id=${FILE_ID}&export=download`,
    `https://docs.google.com/uc?export=download&id=${FILE_ID}`,
  ];
  for (const form of forms) assert.equal(parseDriveLink(form).fileId, FILE_ID, form);
  assert.equal(parseDriveLink(forms[1]).resourceKey, "0-AbC_d");
  assert.equal(parseDriveLink(forms[0]).resourceKey, null);
});

test("folders, Google documents, other hosts, and plain HTTP are refused", () => {
  for (const bad of [
    "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp",
    "https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOp",
    `https://docs.google.com/document/d/${FILE_ID}/edit`,
    `https://photos.google.com/share/${FILE_ID}`,
    `http://drive.google.com/file/d/${FILE_ID}/view`,
    "https://example.com/photo.jpg",
    "not a link",
    "",
  ]) {
    assert.throws(() => parseDriveLink(bad), fails("invalid_input"), bad);
  }
});

test("metadata is read with the API key and resource key, and media files are accepted", async () => {
  const { fetch, calls } = scripted([json(PHOTO)]);
  const client = new DriveClient({ apiKey: API_KEY, fetch, limits: LIMITS });
  const file = await client.metadata(
    parseDriveLink(`https://drive.google.com/open?id=${FILE_ID}&resourcekey=0-key`),
  );
  assert.equal(file.mimeType, "image/jpeg");
  assert.equal(calls[0]!.url.hostname, "www.googleapis.com");
  assert.equal(calls[0]!.url.searchParams.get("key"), API_KEY);
  assert.equal(calls[0]!.headers["X-Goog-Drive-Resource-Keys"], `${FILE_ID}/0-key`);
});

test("private, trashed, folder, shortcut, native, oversized, and non-media files are refused", async () => {
  const link = parseDriveLink(`https://drive.google.com/file/d/${FILE_ID}/view`);
  const cases: [Response, ErrorCode][] = [
    [json({ error: { errors: [{ reason: "notFound" }] } }, 404), "invalid_input"],
    [json({ ...PHOTO, trashed: true }), "invalid_input"],
    [json({ ...PHOTO, capabilities: { canDownload: false } }), "invalid_input"],
    [json({ ...PHOTO, mimeType: "application/vnd.google-apps.folder" }), "invalid_input"],
    [json({ ...PHOTO, mimeType: "application/vnd.google-apps.shortcut" }), "invalid_input"],
    [json({ ...PHOTO, mimeType: "application/vnd.google-apps.document" }), "invalid_input"],
    [json({ ...PHOTO, size: "5000" }), "media_too_large"],
    [json({ ...PHOTO, mimeType: "application/zip" }), "unsupported_media_type"],
  ];
  for (const [response, code] of cases) {
    const client = new DriveClient({
      apiKey: API_KEY,
      fetch: scripted([response]).fetch,
      limits: LIMITS,
    });
    await assert.rejects(client.metadata(link), fails(code));
  }
  const unconfigured = new DriveClient({
    apiKey: undefined,
    fetch: scripted([]).fetch,
    limits: LIMITS,
  });
  await assert.rejects(unconfigured.metadata(link), fails("dependency_unavailable"));
});

test("downloads write the original bytes", async (t) => {
  const file = join(makeTempDir(t), "original");
  const bytes = Buffer.from([1, 2, 3, 4]);
  const { fetch, calls } = scripted([new Response(bytes)]);
  const client = new DriveClient({ apiKey: API_KEY, fetch, limits: LIMITS });
  assert.equal(
    await client.download(parseDriveLink(`https://drive.google.com/uc?id=${FILE_ID}`), file),
    4,
  );
  assert.deepEqual(readFileSync(file), bytes);
  assert.equal(calls[0]!.url.searchParams.get("alt"), "media");
});

test("files over the limit are refused while streaming and leave nothing behind", async (t) => {
  const dir = makeTempDir(t);
  const link = parseDriveLink(`https://drive.google.com/uc?id=${FILE_ID}`);
  const declared = new DriveClient({
    apiKey: API_KEY,
    fetch: scripted([new Response("x", { headers: { "content-length": "5000" } })]).fetch,
    limits: LIMITS,
  });
  await assert.rejects(declared.download(link, join(dir, "a")), fails("media_too_large"));
  const streamed = new DriveClient({
    apiKey: API_KEY,
    fetch: scripted([new Response(Buffer.alloc(1500))]).fetch,
    limits: LIMITS,
  });
  await assert.rejects(streamed.download(link, join(dir, "b")), fails("media_too_large"));
  assert.equal(existsSync(join(dir, "a")), false);
  assert.equal(existsSync(join(dir, "b")), false);
});

/** A response that sends one chunk and then stops without closing. */
function stalling(): () => Response {
  return () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
        },
      }),
    );
}

test("a stalled download is retried twice, then refused, leaving nothing behind", async (t) => {
  const file = join(makeTempDir(t), "original");
  const { fetch, calls } = scripted([stalling(), stalling(), stalling()]);
  const client = new DriveClient({ apiKey: API_KEY, fetch, limits: LIMITS });
  await assert.rejects(
    client.download(parseDriveLink(`https://drive.google.com/uc?id=${FILE_ID}`), file),
    fails("dependency_unavailable"),
  );
  assert.equal(calls.length, 3);
  assert.equal(existsSync(file), false);
});

test("server errors and dropped connections are retried, honoring Retry-After", async (t) => {
  const file = join(makeTempDir(t), "original");
  const { fetch, calls } = scripted([
    new TypeError("fetch failed"),
    new Response("busy", { status: 503, headers: { "retry-after": "0.1" } }),
    new Response(Buffer.from([9, 9])),
  ]);
  const client = new DriveClient({ apiKey: API_KEY, fetch, limits: LIMITS });
  const started = Date.now();
  assert.equal(
    await client.download(parseDriveLink(`https://drive.google.com/uc?id=${FILE_ID}`), file),
    2,
  );
  assert.equal(calls.length, 3);
  assert.ok(Date.now() - started >= 100, "waited at least the Retry-After delay");
});

test("rate limits that outlast the retries are reported as rate limits", async () => {
  const limited = () => json({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }, 403);
  const { fetch, calls } = scripted([limited(), new Response("", { status: 429 }), limited()]);
  const client = new DriveClient({ apiKey: API_KEY, fetch, limits: LIMITS });
  await assert.rejects(
    client.metadata(parseDriveLink(`https://drive.google.com/uc?id=${FILE_ID}`)),
    fails("upstream_rate_limited"),
  );
  assert.equal(calls.length, 3);
});

test("downloads follow redirects only to Google's download hosts", async (t) => {
  const dir = makeTempDir(t);
  const link = parseDriveLink(`https://drive.google.com/uc?id=${FILE_ID}`);
  const allowed = scripted([
    new Response(null, {
      status: 302,
      headers: { location: "https://doc-0c-docs.googleusercontent.com/file" },
    }),
    new Response(Buffer.from([7])),
  ]);
  const client = new DriveClient({ apiKey: API_KEY, fetch: allowed.fetch, limits: LIMITS });
  assert.equal(await client.download(link, join(dir, "a")), 1);

  const foreign = scripted([
    new Response(null, { status: 302, headers: { location: "https://evil.example/file" } }),
  ]);
  const redirected = new DriveClient({ apiKey: API_KEY, fetch: foreign.fetch, limits: LIMITS });
  await assert.rejects(redirected.download(link, join(dir, "b")), fails("invalid_input"));
  assert.equal(foreign.calls.length, 1);
});

test("Discord attachments download only from Discord's CDN", async (t) => {
  const dir = makeTempDir(t);
  const { fetch } = scripted([new Response(Buffer.from([1, 2, 3]))]);
  assert.equal(
    await downloadDiscordAttachment(
      "https://cdn.discordapp.com/attachments/1/2/photo.jpg",
      join(dir, "a"),
      { fetch, limits: LIMITS },
    ),
    3,
  );
  await assert.rejects(
    downloadDiscordAttachment("https://example.com/photo.jpg", join(dir, "b"), {
      fetch: scripted([]).fetch,
      limits: LIMITS,
    }),
    fails("invalid_input"),
  );
});
