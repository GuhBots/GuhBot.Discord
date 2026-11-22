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
  /** Receives startup and shutdown announcements when set. */
  statusChannelId: optional("STATUS_CHANNEL_ID"),
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
