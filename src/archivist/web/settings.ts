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
  /** The origin browsers use, which the Discord sign-in callback is registered under. */
  baseUrl: string;
  discordClientId?: string;
  discordClientSecret?: string;
  /** Signs session cookies. At least 32 bytes. */
  sessionSecret?: string;
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
    url.pathname !== "/" ||
    url.search
  ) {
    throw new ArchivistError(
      "invalid_input",
      "ARCHIVIST_BASE_URL must be an http or https origin with no path, such as http://localhost:3000.",
      { reason: "invalid_base_url" },
    );
  }
  if (!Number.isInteger(settings.port) || settings.port < 0 || settings.port > 65535) {
    throw new ArchivistError("invalid_input", "ARCHIVIST_PORT must be a port number.", {
      reason: "invalid_port",
    });
  }
}
