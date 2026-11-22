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

/** Disconnects from Discord, closes the database, and exits. */
export async function shutdown(client: Client, exitCode = 0): Promise<never> {
  await client.destroy();
  closeDatabase();
  process.exit(exitCode);
}
