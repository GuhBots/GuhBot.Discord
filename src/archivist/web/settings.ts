import { ArchivistError } from "../errors.js";

/**
 * The web listener's settings, read from the environment by `config.ts`.
 * They are checked when the owner starts the listener, not at bot startup,
 * because the bot runs normally without the website.
 */
export interface WebSettings {
  /** The address to listen on. `127.0.0.1` for local testing. */
  host: string;
  /** The port to listen on. 0 picks a free port, which tests use. */
  port: number;
  /**
   * The address browsers use, which the Discord sign-in callback is registered
   * under. It may include a path, such as `https://example.com/archivist`.
   */
  baseUrl: string;
  discordClientId?: string;
  discordClientSecret?: string;
  /** Signs session cookies. At least 32 bytes. */
  sessionSecret?: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The path the website lives under, such as `/archivist` for
 * `https://example.com/archivist`, or an empty string at the root.
 */
export function basePathOf(baseUrl: string): string {
  return new URL(baseUrl).pathname.replace(/\/+$/, "");
}

/** The sign-in callback, which must be registered in the Discord application exactly. */
export function redirectUriOf(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.origin}${basePathOf(baseUrl)}/auth/discord/callback`;
}

/** Signing secrets shorter than this are refused. */
export const MIN_SESSION_SECRET_BYTES = 32;

/** The settings the listener needs, or an error naming what is missing or wrong. */
export function checkWebSettings(settings: WebSettings): void {
  const missing = [
    ["DISCORD_CLIENT_ID", settings.discordClientId],
    ["DISCORD_CLIENT_SECRET", settings.discordClientSecret],
    ["ARCHIVIST_SESSION_SECRET", settings.sessionSecret],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name as string);
  if (missing.length > 0) {
    throw new ArchivistError(
      "invalid_input",
      `Set ${missing.join(", ")} in the bot's environment before starting the website. The Discord setup guide explains each one.`,
      { reason: "missing_settings", missing },
    );
  }
  if (Buffer.byteLength(settings.sessionSecret!, "utf8") < MIN_SESSION_SECRET_BYTES) {
    throw new ArchivistError(
      "invalid_input",
      `ARCHIVIST_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_BYTES} bytes. Generate one with \`openssl rand -hex 32\`.`,
      { reason: "short_session_secret" },
    );
  }
  let url: URL;
  try {
    url = new URL(settings.baseUrl);
  } catch {
    throw new ArchivistError(
      "invalid_input",
      "ARCHIVIST_BASE_URL must be a full address, such as http://localhost:3000.",
      { reason: "invalid_base_url" },
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.search ||
    url.hash ||
    url.username
  ) {
    throw new ArchivistError(
      "invalid_input",
      "ARCHIVIST_BASE_URL must be an http or https address with no query, such as http://localhost:3000 or https://example.com/archivist.",
      { reason: "invalid_base_url" },
    );
  }
  // Sign-in cookies need HTTPS, except on this machine while testing.
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ArchivistError(
      "invalid_input",
      "ARCHIVIST_BASE_URL must use https unless it is localhost. Put the website behind a reverse proxy that provides HTTPS.",
      { reason: "insecure_base_url" },
    );
  }
  if (!Number.isInteger(settings.port) || settings.port < 0 || settings.port > 65535) {
    throw new ArchivistError("invalid_input", "ARCHIVIST_PORT must be a port number.", {
      reason: "invalid_port",
    });
  }
}
