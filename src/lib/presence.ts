import { ActivityType, type Client } from "discord.js";
import { config } from "../config.js";

export const DEFAULT_STATUS =
  "watching /help | {guilds} servers & {users} users | version {version}";

/** The first word of a status selects the activity type. */
const ACTIVITY_TYPES = {
  playing: ActivityType.Playing,
  watching: ActivityType.Watching,
  "listening-to": ActivityType.Listening,
  competing: ActivityType.Competing,
} as const;

export const ACTIVITY_WORDS = Object.keys(ACTIVITY_TYPES);

const REFRESH_INTERVAL_MS = 60_000;

let template = DEFAULT_STATUS;
let timer: NodeJS.Timeout | undefined;

/** Returns whether a status starts with a known activity word. */
export function isValidStatus(status: string): boolean {
  return status.split(" ")[0]! in ACTIVITY_TYPES;
}

function render(client: Client): { type: ActivityType; name: string } {
  const users = client.guilds.cache.reduce((sum, guild) => sum + guild.memberCount, 0);
  const text = template
    .replaceAll("{guilds}", client.guilds.cache.size.toLocaleString("en-US"))
    .replaceAll("{users}", users.toLocaleString("en-US"))
    .replaceAll("{version}", config.version);
  const [word, ...rest] = text.split(" ");
  const type = ACTIVITY_TYPES[word as keyof typeof ACTIVITY_TYPES];
  return type === undefined
    ? { type: ActivityType.Watching, name: text }
    : { type, name: rest.join(" ") };
}

function apply(client: Client): void {
  const { type, name } = render(client);
  client.user?.setActivity({ type, name });
}

/** Sets the status now and refreshes its counts every minute. */
export function startPresence(client: Client): void {
  apply(client);
  clearInterval(timer);
  timer = setInterval(() => apply(client), REFRESH_INTERVAL_MS);
}

/**
 * Changes the status template. It can contain {guilds}, {users}, and
 * {version}. Passing nothing restores the default.
 */
export function setStatusTemplate(client: Client, status = DEFAULT_STATUS): void {
  template = status;
  apply(client);
}
