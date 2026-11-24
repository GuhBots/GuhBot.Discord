import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildWebApp } from "../../../src/archivist/web/app.js";
import { hashToken } from "../../../src/archivist/web/sessions.js";
import { checkWebSettings, type WebSettings } from "../../../src/archivist/web/settings.js";
import { makeArchivist, MEMBER, NOW, OWNER } from "../helpers/context.js";
import { makeTempDir } from "../helpers/temp-dir.js";

const SETTINGS: WebSettings = {
  host: "127.0.0.1",
  port: 0,
  baseUrl: "http://localhost:3000",
  discordClientId: "707321853198467163",
  discordClientSecret: "test-client-secret",
  sessionSecret: "s".repeat(64),
};

interface FakeDiscord {
  calls: { url: string; method: string; headers: Record<string, string>; body: string }[];
  revoked: string[];
  /** The Discord user each good code signs in as. */
  users: Record<
    string,
    { id: string; username: string; global_name: string | null; avatar: string | null }
  >;
  down: boolean;
}

/** Stands in for Discord's OAuth endpoints. Codes in `users` are valid once. */
function fakeDiscord(): { discord: FakeDiscord; fetch: typeof fetch } {
  const discord: FakeDiscord = { calls: [], revoked: [], users: {}, down: false };
  const used = new Set<string>();
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const body =
      init.body instanceof URLSearchParams ? init.body.toString() : String(init.body ?? "");
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    discord.calls.push({ url, method: init.method ?? "GET", headers, body });
    if (discord.down) throw new TypeError("fetch failed");
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.endsWith("/oauth2/token")) {
      const code = new URLSearchParams(body).get("code") ?? "";
      if (!discord.users[code] || used.has(code)) return json(400, { error: "invalid_grant" });
      used.add(code);
      return json(200, { access_token: `access-${code}`, token_type: "Bearer" });
    }
    if (url.endsWith("/oauth2/token/revoke")) {
      discord.revoked.push(new URLSearchParams(body).get("token") ?? "");
      return json(200, {});
    }
    if (url.endsWith("/users/@me")) {
      const code = (headers.authorization ?? "").replace("Bearer access-", "");
      const user = discord.users[code];
      return user ? json(200, user) : json(401, { message: "401: Unauthorized" });
    }
    return json(404, {});
  }) as typeof fetch;
  return { discord, fetch: fakeFetch };
}

interface Harness {
  app: FastifyInstance;
  discord: FakeDiscord;
  owners: Set<string>;
  clock: { ms: number };
  db: import("better-sqlite3").Database;
  origin: string;
  /** Signs in through the whole flow and returns the session cookie. */
  signIn(userId: string, code?: string): Promise<string>;
}

async function harness(t: TestContext, settings: WebSettings = SETTINGS): Promise<Harness> {
  checkWebSettings(settings);
  const { context } = makeArchivist(t);
  const clock = { ms: NOW.getTime() };
  context.now = () => new Date(clock.ms);
  const owners = new Set([OWNER.userId]);
  const { discord, fetch } = fakeDiscord();
  const { app } = buildWebApp({
    context,
    settings,
    isOwner: async (userId) => owners.has(userId),
    frontendRoot: makeTempDir(t),
    logError: () => undefined,
    fetch,
  });
  await app.ready();
  t.after(() => app.close());
  const base = new URL(settings.baseUrl).pathname.replace(/\/+$/, "");
  const h: Harness = {
    app,
    discord,
    owners,
    clock,
    db: context.botDb,
    origin: new URL(settings.baseUrl).origin,
    async signIn(userId, code = `code-${userId}-${clock.ms}`) {
      discord.users[code] = {
        id: userId,
        username: `user${userId.slice(-3)}`,
        global_name: "Sam",
        avatar: "a_1234",
      };
      const start = await app.inject({ method: "GET", url: `${base}/auth/discord` });
      const state = new URL(start.headers.location as string).searchParams.get("state")!;
      const back = await app.inject({
        method: "GET",
        url: `${base}/auth/discord/callback?code=${code}&state=${state}`,
        cookies: { archivist_signin: cookieValue(start, "archivist_signin")! },
      });
      assert.equal(back.statusCode, 302, back.body);
      return cookieValue(back, "archivist_session")!;
    },
  };
  return h;
}

function setCookies(response: LightMyRequestResponse): string[] {
  const header = response.headers["set-cookie"];
  return Array.isArray(header) ? header : header ? [header] : [];
}

function cookieHeader(response: LightMyRequestResponse, name: string): string | undefined {
  return setCookies(response).find((c) => c.startsWith(`${name}=`));
}

function cookieValue(response: LightMyRequestResponse, name: string): string | undefined {
  return cookieHeader(response, name)
    ?.split(";")[0]
    ?.slice(name.length + 1);
}

test("signing in with Discord creates a seven-day session and keeps no Discord token", async (t) => {
  const h = await harness(t);
  const start = await h.app.inject({ method: "GET", url: "/auth/discord" });
  assert.equal(start.statusCode, 302);
  const location = new URL(start.headers.location as string);
  assert.equal(location.origin + location.pathname, "https://discord.com/oauth2/authorize");
  assert.equal(location.searchParams.get("client_id"), SETTINGS.discordClientId);
  assert.equal(location.searchParams.get("scope"), "identify");
  assert.equal(
    location.searchParams.get("redirect_uri"),
    "http://localhost:3000/auth/discord/callback",
  );
  const state = location.searchParams.get("state")!;
  assert.ok(state.length >= 40);
  const stateCookie = cookieHeader(start, "archivist_signin")!;
  assert.match(stateCookie, /HttpOnly/);
  assert.match(stateCookie, /SameSite=Lax/);
  assert.match(stateCookie, /Path=\/auth/);
  assert.doesNotMatch(stateCookie, /Secure/);

  h.discord.users["good"] = {
    id: MEMBER.userId,
    username: "sam",
    global_name: "Sam",
    avatar: "a_abc",
  };
  const back = await h.app.inject({
    method: "GET",
    url: `/auth/discord/callback?code=good&state=${state}`,
    cookies: { archivist_signin: cookieValue(start, "archivist_signin")! },
  });
  assert.equal(back.statusCode, 302);
  assert.equal(back.headers.location, "/");
  const sessionCookie = cookieHeader(back, "archivist_session")!;
  assert.match(sessionCookie, /HttpOnly/);
  assert.match(sessionCookie, /SameSite=Lax/);
  assert.match(sessionCookie, /Max-Age=604800/);
  assert.match(sessionCookie, /Path=\//);

  // The code was exchanged with the registered redirect, and the token revoked afterwards.
  const exchange = h.discord.calls.find((c) => c.url.endsWith("/oauth2/token"))!;
  assert.equal(
    new URLSearchParams(exchange.body).get("redirect_uri"),
    "http://localhost:3000/auth/discord/callback",
  );
  assert.match(exchange.headers.authorization ?? "", /^Basic /);
  assert.deepEqual(h.discord.revoked, ["access-good"]);

  // Only a hash of the session token is stored.
  const token = decodeURIComponent(cookieValue(back, "archivist_session")!).split(".")[0]!;
  const rows = h.db
    .prepare("SELECT token_hash, display_name, avatar_url FROM archivist_sessions")
    .all();
  assert.deepEqual(rows, [
    {
      token_hash: hashToken(token),
      display_name: "Sam",
      avatar_url: `https://cdn.discordapp.com/avatars/${MEMBER.userId}/a_abc.gif?size=128`,
    },
  ]);

  const me = await h.app.inject({
    method: "GET",
    url: "/api/me",
    cookies: { archivist_session: cookieValue(back, "archivist_session")! },
  });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json(), {
    user: {
      id: MEMBER.userId,
      name: "Sam",
      avatarUrl: `https://cdn.discordapp.com/avatars/${MEMBER.userId}/a_abc.gif?size=128`,
    },
    isOwner: false,
    sessionExpires: new Date(NOW.getTime() + 7 * 24 * 3600_000).toISOString(),
    preferences: { timeZone: null, dateOrder: "ymd" },
  });

  // Seven days later the session is gone, whatever happened in between.
  h.clock.ms += 7 * 24 * 3600_000;
  const expired = await h.app.inject({
    method: "GET",
    url: "/api/me",
    cookies: { archivist_session: cookieValue(back, "archivist_session")! },
  });
  assert.equal(expired.statusCode, 401);
  assert.equal(expired.json().code, "no_session");
  assert.equal(
    (h.db.prepare("SELECT count(*) AS n FROM archivist_sessions").get() as { n: number }).n,
    0,
  );
});

test("a sign-in must come back to the same browser, once, within ten minutes", async (t) => {
  const h = await harness(t);
  h.discord.users["c1"] = { id: MEMBER.userId, username: "sam", global_name: null, avatar: null };
  const start = async () => {
    const response = await h.app.inject({ method: "GET", url: "/auth/discord" });
    return {
      state: new URL(response.headers.location as string).searchParams.get("state")!,
      cookie: cookieValue(response, "archivist_signin")!,
    };
  };
  const callback = (query: string, cookie?: string) =>
    h.app.inject({
      method: "GET",
      url: `/auth/discord/callback?${query}`,
      cookies: cookie ? { archivist_signin: cookie } : {},
    });

  const a = await start();
  // No cookie: the link was opened in another browser, or forged.
  const noCookie = await callback(`code=c1&state=${a.state}`);
  assert.equal(noCookie.statusCode, 400);
  assert.match(noCookie.body, /expired or was started somewhere else/);
  // The cookie from another sign-in does not match.
  const b = await start();
  assert.equal((await callback(`code=c1&state=${a.state}`, b.cookie)).statusCode, 400);
  // A tampered cookie is refused.
  assert.equal((await callback(`code=c1&state=${b.state}`, `${b.state}.forged`)).statusCode, 400);
  // The right pair works once.
  assert.equal((await callback(`code=c1&state=${b.state}`, b.cookie)).statusCode, 302);
  assert.equal((await callback(`code=c1&state=${b.state}`, b.cookie)).statusCode, 400);
  // An old state expires.
  const c = await start();
  h.clock.ms += 10 * 60_000;
  assert.equal((await callback(`code=c1&state=${c.state}`, c.cookie)).statusCode, 400);
  // Cancelling on Discord's page.
  const d = await start();
  const cancelled = await callback(`error=access_denied&state=${d.state}`, d.cookie);
  assert.equal(cancelled.statusCode, 400);
  assert.match(cancelled.body, /cancelled/);
  // Nothing was signed in except the one good attempt.
  assert.equal(
    (h.db.prepare("SELECT count(*) AS n FROM archivist_sessions").get() as { n: number }).n,
    1,
  );
});

test("a reused code or an unreachable Discord shows a sign-in error page", async (t) => {
  const h = await harness(t);
  const attempt = async (code: string) => {
    const start = await h.app.inject({ method: "GET", url: "/auth/discord" });
    const state = new URL(start.headers.location as string).searchParams.get("state")!;
    return h.app.inject({
      method: "GET",
      url: `/auth/discord/callback?code=${code}&state=${state}`,
      cookies: { archivist_signin: cookieValue(start, "archivist_signin")! },
    });
  };
  const unknown = await attempt("never-issued");
  assert.equal(unknown.statusCode, 400);
  assert.match(unknown.body, /expired or was already used/);
  h.discord.down = true;
  h.discord.users["c2"] = { id: MEMBER.userId, username: "sam", global_name: null, avatar: null };
  const down = await attempt("c2");
  assert.equal(down.statusCode, 503);
  assert.match(down.body, /Discord did not answer/);
  assert.doesNotMatch(down.body, /test-client-secret/);
});

test("sessions refuse tampering, and owner status is checked again after five minutes", async (t) => {
  const h = await harness(t);
  const me = (cookie: string) =>
    h.app.inject({ method: "GET", url: "/api/me", cookies: { archivist_session: cookie } });
  assert.equal((await h.app.inject({ method: "GET", url: "/api/me" })).statusCode, 401);
  assert.equal((await me("not-a-real-session")).statusCode, 401);

  const cookie = await h.signIn(OWNER.userId);
  const [token, signature] = decodeURIComponent(cookie).split(".");
  assert.equal((await me(`${token}x.${signature}`)).statusCode, 401);
  assert.equal((await me(cookie)).json().isOwner, true);

  // Ownership removed: still the old answer within five minutes, then the new one.
  h.owners.delete(OWNER.userId);
  h.clock.ms += 4 * 60_000;
  assert.equal((await me(cookie)).json().isOwner, true);
  h.clock.ms += 60_000;
  assert.equal((await me(cookie)).json().isOwner, false);
});

test("signing out ends the session, and changes must come from the website", async (t) => {
  const h = await harness(t);
  const cookie = await h.signIn(MEMBER.userId);
  const logout = (headers: Record<string, string>) =>
    h.app.inject({
      method: "POST",
      url: "/auth/logout",
      headers,
      cookies: { archivist_session: cookie },
    });

  const attempts: Record<string, string>[] = [
    {},
    { origin: "https://evil.example" },
    { "sec-fetch-site": "cross-site" },
  ];
  for (const headers of attempts) {
    const refused = await logout(headers);
    assert.equal(refused.statusCode, 403, JSON.stringify(headers));
    assert.equal(refused.json().details.reason, "cross_origin");
  }
  assert.equal(
    (await h.app.inject({ method: "GET", url: "/api/me", cookies: { archivist_session: cookie } }))
      .statusCode,
    200,
  );

  const out = await logout({ origin: h.origin });
  assert.equal(out.statusCode, 204);
  assert.match(cookieHeader(out, "archivist_session") ?? "", /Expires=Thu, 01 Jan 1970/);
  assert.equal(
    (await h.app.inject({ method: "GET", url: "/api/me", cookies: { archivist_session: cookie } }))
      .statusCode,
    401,
  );
  // Signing out twice is harmless.
  assert.equal((await logout({ origin: h.origin })).statusCode, 204);
});

test("the account menu sets and resets the contributor's own date order and timezone", async (t) => {
  const h = await harness(t);
  const cookie = await h.signIn(MEMBER.userId);
  const send = (method: "PUT" | "DELETE", url: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      payload: payload as object,
      headers: { origin: h.origin },
      cookies: { archivist_session: cookie },
    });

  const order = await send("PUT", "/api/me/date-order", { dateOrder: "dmy" });
  assert.equal(order.statusCode, 200);
  assert.deepEqual(order.json(), { timeZone: null, dateOrder: "dmy" });
  const zone = await send("PUT", "/api/me/timezone", { timeZone: "Europe/London" });
  assert.deepEqual(zone.json(), { timeZone: "Europe/London", dateOrder: "dmy" });
  const bad = await send("PUT", "/api/me/timezone", { timeZone: "Mars/Olympus" });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, "invalid_input");
  assert.equal((await send("PUT", "/api/me/date-order", { dateOrder: "yolo" })).statusCode, 400);
  assert.deepEqual((await send("DELETE", "/api/me/preferences")).json(), {
    timeZone: null,
    dateOrder: "ymd",
  });
  // Without a session nothing changes.
  const anonymous = await h.app.inject({
    method: "PUT",
    url: "/api/me/date-order",
    payload: { dateOrder: "mdy" },
    headers: { origin: h.origin },
  });
  assert.equal(anonymous.statusCode, 401);
});

test("the website works under a path, with secure cookies on HTTPS", async (t) => {
  const h = await harness(t, { ...SETTINGS, baseUrl: "https://guhbot.example.com/archivist" });
  const start = await h.app.inject({ method: "GET", url: "/archivist/auth/discord" });
  assert.equal(
    new URL(start.headers.location as string).searchParams.get("redirect_uri"),
    "https://guhbot.example.com/archivist/auth/discord/callback",
  );
  assert.match(cookieHeader(start, "archivist_signin")!, /Path=\/archivist\/auth/);
  assert.match(cookieHeader(start, "archivist_signin")!, /Secure/);

  h.discord.users["p1"] = { id: MEMBER.userId, username: "sam", global_name: null, avatar: null };
  const state = new URL(start.headers.location as string).searchParams.get("state")!;
  const back = await h.app.inject({
    method: "GET",
    url: `/archivist/auth/discord/callback?code=p1&state=${state}`,
    cookies: { archivist_signin: cookieValue(start, "archivist_signin")! },
  });
  assert.equal(back.headers.location, "/archivist/");
  assert.match(cookieHeader(back, "archivist_session")!, /Path=\/archivist;/);
  assert.match(cookieHeader(back, "archivist_session")!, /Secure/);
  const me = await h.app.inject({
    method: "GET",
    url: "/archivist/api/me",
    cookies: { archivist_session: cookieValue(back, "archivist_session")! },
  });
  assert.equal(
    me.json().user.avatarUrl,
    `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(MEMBER.userId) >> 22n) % 6n)}.png`,
  );

  assert.equal((await h.app.inject({ method: "GET", url: "/archivist/timeline" })).statusCode, 200);
  assert.equal((await h.app.inject({ method: "GET", url: "/archivist" })).statusCode, 200);
  assert.equal((await h.app.inject({ method: "GET", url: "/timeline" })).statusCode, 404);
  assert.equal((await h.app.inject({ method: "GET", url: "/api/me" })).statusCode, 404);
  const wrongOrigin = await h.app.inject({
    method: "POST",
    url: "/archivist/auth/logout",
    headers: { origin: "http://guhbot.example.com" },
  });
  assert.equal(wrongOrigin.statusCode, 403);
});
