import { InteractionContextType } from "discord.js";

/**
 * Commands that were hidden from help in the original bot. Slash commands
 * cannot be hidden from Discord's command list, so /help leaves them out.
 */
export const HIDDEN_COMMANDS: ReadonlySet<string> = new Set([
  "pp",
  "guh",
  "fart",
  "unkick",
  "serverinfo",
]);

/**
 * Restricts a command to servers. The original bot ignored direct messages,
 * and most commands rely on a guild member. Spread it into `@Slash` options.
 */
export const GUILD_ONLY = { contexts: [InteractionContextType.Guild] };
