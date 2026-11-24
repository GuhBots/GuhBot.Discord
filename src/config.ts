import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Settings read from environment variables. `.env.example` documents each one.
 * Commands read this module while their decorators run, so it must not depend
 * on the Discord client.
 */

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** Reads a comma-separated list, ignoring blank entries. Returns undefined when unset. */
function optionalList(name: string): string[] | undefined {
  const items = optional(name)
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items?.length ? items : undefined;
}

const SNOWFLAKE = /^\d{17,20}$/;

/** Reads a comma-separated list of Discord IDs, and fails on anything that is not an ID. */
function idList(name: string): string[] {
  const ids = optionalList(name) ?? [];
  const invalid = ids.filter((id) => !SNOWFLAKE.test(id));
  if (invalid.length) {
    throw new Error(
      `${name} must hold Discord IDs separated by commas. Invalid: ${invalid.join(", ")}`,
    );
  }
  return ids;
}

/** Reads a port number, and fails on anything else. */
function portNumber(name: string, fallback: number): number {
  const value = optional(name);
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a port number from 1 to 65535. Got: ${value}`);
  }
  return port;
}

/** Reads the bot token. Only the entry point calls this, so imports never need it. */
export function readToken(): string {
  const token = optional("DISCORD_TOKEN");
  if (!token) {
    throw new Error("DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.");
  }
  return token;
}

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export const config = {
  version: packageJson.version,
  /** Registers every command in this guild instead of globally, so changes appear at once. */
  devGuildId: optional("DEV_GUILD_ID"),
  /** The only guild where owner commands are registered. Owner commands are off when unset. */
  ownerGuildId: optional("OWNER_GUILD_ID"),
  /**
   * Lowercase names of the modules to load. Every module loads when unset.
   * `modules.ts` checks the names.
   */
  modules: optionalList("MODULES")?.map((name) => name.toLowerCase()),
  /** The servers where the Archivist module works. The module is off when empty. */
  archivistGuildIds: idList("ARCHIVIST_GUILD_IDS"),
  /** Receives startup and shutdown announcements when set. */
  statusChannelId: optional("STATUS_CHANNEL_ID"),
  /**
   * Google API key for reading public Drive files that contributors link to
   * in Archivist. When unset, public Drive files download from Google's public
   * download address instead.
   */
  googleDriveApiKey: optional("GOOGLE_DRIVE_API_KEY"),
  /**
   * Archivist's website. It starts only when the owner runs
   * `/archivist-admin web start`, which checks these settings.
   */
  archivistWeb: {
    host: optional("ARCHIVIST_HOST") ?? "127.0.0.1",
    port: portNumber("ARCHIVIST_PORT", 3000),
    baseUrl: optional("ARCHIVIST_BASE_URL") ?? "http://localhost:3000",
    discordClientId: optional("DISCORD_CLIENT_ID"),
    discordClientSecret: optional("DISCORD_CLIENT_SECRET"),
    sessionSecret: optional("ARCHIVIST_SESSION_SECRET"),
  },
  /** Holds the SQLite database. The container image sets it to the /data volume. */
  dataDir: optional("DATA_DIR") ?? "data",
  /** Links shown by /support, /stats, and /upvote. Each one is hidden when unset. */
  links: {
    support: optional("SUPPORT_URL"),
    website: optional("WEBSITE_URL"),
    topgg: optional("TOPGG_URL"),
    discordBotList: optional("DISCORDBOTLIST_URL"),
  },
};

/** Returns the absolute path of a file in the repository's `assets/` directory. */
export function assetPath(relativePath: string): string {
  return fileURLToPath(new URL(`../assets/${relativePath}`, import.meta.url));
}
