import { InteractionContextType } from "discord.js";

/**
 * Command modules shown by /help, with the descriptions from the original
 * bot's cogs. Each command class uses one of these names with `@Category`.
 */
export const CATEGORIES = {
  Fun: "What more can I say? They're fun commands.",
  Games: "Some games to play in your server!",
  Images: "Image manipulation commands",
  Misc: "Miscellaneous Commands",
  Moderation: "Commands for your Moderators",
  Roleplay: "Roleplay Commands!!!",
  Meta: "About the bot",
} as const;

export type CategoryName = keyof typeof CATEGORIES;

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
