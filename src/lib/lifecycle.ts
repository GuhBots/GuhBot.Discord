import type { Client } from "discord.js";
import { config } from "../config.js";
import { closeDatabase } from "./database.js";

/** Posts a message in the status channel when STATUS_CHANNEL_ID is set. Failures are logged. */
export async function announce(client: Client, message: string): Promise<void> {
  if (!config.statusChannelId) return;
  try {
    const channel = await client.channels.fetch(config.statusChannelId);
    if (channel?.isSendable()) {
      await channel.send(message);
    }
  } catch (error) {
    console.error("Could not post in the status channel:", error);
  }
}

type ShutdownHook = () => Promise<void> | void;

const shutdownHooks: ShutdownHook[] = [];

/**
 * Runs `hook` during shutdown, before the database closes. Features that hold
 * files or child processes, such as Archivist, register one when they load.
 */
export function onShutdown(hook: ShutdownHook): void {
  shutdownHooks.push(hook);
}

/** Disconnects from Discord, runs shutdown hooks, closes the database, and exits. */
export async function shutdown(client: Client, exitCode = 0): Promise<never> {
  await client.destroy();
  for (const hook of shutdownHooks) {
    try {
      await hook();
    } catch (error) {
      console.error("A shutdown step failed:", error);
    }
  }
  closeDatabase();
  process.exit(exitCode);
}
