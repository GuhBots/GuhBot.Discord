import { ArchivistError } from "../errors.js";

/**
 * Discord sign-in over plain HTTPS, with no Discord library, so the website
 * can run apart from the bot. Only the `identify` scope is requested. The
 * access token is used once to learn who signed in and is then revoked, so
 * Archivist keeps no Discord credentials for anyone.
 */

export const DISCORD_API = "https://discord.com/api/v10";
const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const CDN = "https://cdn.discordapp.com";
const REQUEST_TIMEOUT_MS = 10_000;

export interface OAuthSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface DiscordIdentity {
  id: string;
  /** The name shown on Discord: the display name when set, else the username. */
  name: string;
  avatarUrl: string;
}

export type Fetch = typeof fetch;

export function authorizeUrl(settings: OAuthSettings, state: string): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: settings.clientId,
    scope: "identify",
    redirect_uri: settings.redirectUri,
    state,
    // Someone who already allowed the app is not asked again.
    prompt: "none",
  });
  return `${AUTHORIZE_URL}?${query}`;
}

function unavailable(step: string, status?: number): ArchivistError {
  return new ArchivistError(
    "dependency_unavailable",
    "Discord did not answer the sign-in. Try again in a moment.",
    { reason: "discord_unavailable", step, ...(status ? { status } : {}) },
  );
}

async function call(
  fetchImpl: Fetch,
  step: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw unavailable(step);
  }
}

function basicAuth(settings: OAuthSettings): string {
  return `Basic ${Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString("base64")}`;
}

/** Trades the code Discord sent back for an access token. */
export async function exchangeCode(
  settings: OAuthSettings,
  code: string,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const response = await call(fetchImpl, "token", `${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: basicAuth(settings),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: settings.redirectUri,
    }),
  });
  if (response.status === 400 || response.status === 401) {
    // An old or reused code, or a redirect that does not match the registered one.
    throw new ArchivistError(
      "invalid_input",
      "That sign-in link expired or was already used. Sign in again.",
      {
        reason: "invalid_code",
      },
    );
  }
  if (!response.ok) throw unavailable("token", response.status);
  const body = (await response.json().catch(() => null)) as { access_token?: unknown } | null;
  if (typeof body?.access_token !== "string") throw unavailable("token");
  return body.access_token;
}

/** Who the access token belongs to. */
export async function fetchIdentity(
  accessToken: string,
  fetchImpl: Fetch = fetch,
): Promise<DiscordIdentity> {
  const response = await call(fetchImpl, "identity", `${DISCORD_API}/users/@me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw unavailable("identity", response.status);
  const user = (await response.json().catch(() => null)) as {
    id?: unknown;
    username?: unknown;
    global_name?: unknown;
    avatar?: unknown;
  } | null;
  if (
    typeof user?.id !== "string" ||
    !/^\d{17,20}$/.test(user.id) ||
    typeof user.username !== "string"
  ) {
    throw unavailable("identity");
  }
  return {
    id: user.id,
    name:
      typeof user.global_name === "string" && user.global_name ? user.global_name : user.username,
    avatarUrl: avatarUrl(user.id, typeof user.avatar === "string" ? user.avatar : null),
  };
}

/** Revokes the access token. Failure is ignored: the token expires on its own. */
export async function revokeToken(
  settings: OAuthSettings,
  accessToken: string,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  await call(fetchImpl, "revoke", `${DISCORD_API}/oauth2/token/revoke`, {
    method: "POST",
    headers: {
      authorization: basicAuth(settings),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token: accessToken, token_type_hint: "access_token" }),
  }).catch(() => undefined);
}

/** A user's avatar address, animated when the avatar is, or Discord's default picture. */
export function avatarUrl(userId: string, hash: string | null): string {
  if (hash)
    return `${CDN}/avatars/${userId}/${hash}.${hash.startsWith("a_") ? "gif" : "png"}?size=128`;
  return `${CDN}/embed/avatars/${Number((BigInt(userId) >> 22n) % 6n)}.png`;
}
