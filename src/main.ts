import "reflect-metadata";
import { DiscordAPIError, type Interaction, RESTJSONErrorCodes } from "discord.js";
import { Client } from "discordx";
import { config, readToken } from "./config.js";
import { syncAllCommands, syncGuildCommands } from "./lib/command-sync.js";
import { replyError } from "./lib/embeds.js";
import { announce, shutdown } from "./lib/lifecycle.js";
import { startPresence } from "./lib/presence.js";
import { loadModules, requiredIntents } from "./modules.js";

// Importing a module's files registers its commands and listeners with
// discordx. A module that is off never loads, so the command sync removes
// its commands from Discord.
await loadModules();

if (config.ownerGuildId) {
  await import("./commands/owner.js");
}

const client = new Client({
  // Only the intents the enabled modules need. None of them is privileged.
  intents: requiredIntents(),
  // In development, register every command in one guild so changes appear at once.
  botGuilds: config.devGuildId ? [config.devGuildId] : undefined,
  silent: false,
});

client.once("clientReady", async () => {
  startPresence(client);
  console.log(`Logged in as ${client.user?.tag}, version ${config.version}`);
  await announce(client, ":wave: Hello everyone! I'm back online!");
  // The code is the only source of commands. This registers its commands and
  // removes every other command, globally and in each server.
  try {
    await syncAllCommands(client);
  } catch (error) {
    console.error("Could not sync commands:", error);
  }
});

// Sync a server's commands when the bot joins it, so that a newly joined
// development or owner server gets its commands without a restart.
client.on("guildCreate", async (guild) => {
  console.log(`Joined ${guild.name} (${guild.id})`);
  try {
    await syncGuildCommands(client, guild);
  } catch (error) {
    console.error(`Could not sync commands after joining ${guild.id}:`, error);
  }
});

/** Discord's deadline for the first reply to an interaction. */
const INTERACTION_REPLY_WINDOW_MS = 3_000;

/** Unknown interaction (10062) or already acknowledged (40060). */
function isLostInteraction(error: unknown): error is DiscordAPIError {
  return (
    error instanceof DiscordAPIError &&
    (error.code === RESTJSONErrorCodes.UnknownInteraction ||
      error.code === RESTJSONErrorCodes.InteractionHasAlreadyBeenAcknowledged)
  );
}

client.on("interactionCreate", async (interaction: Interaction) => {
  try {
    await client.executeInteraction(interaction);
  } catch (error) {
    const name = interaction.isCommand() ? `/${interaction.commandName}` : "interaction";
    const ageMs = Date.now() - interaction.createdTimestamp;
    if (isLostInteraction(error)) {
      // Replying again would fail the same way, so only log it. Discord allows
      // 3 seconds for the first reply. A younger interaction that is already
      // gone was almost certainly answered by another copy of the bot.
      console.warn(
        `${name} was already answered or expired after ${ageMs}ms (${error.code}).` +
          (ageMs < INTERACTION_REPLY_WINDOW_MS
            ? " Another copy of the bot is probably running with the same token."
            : ""),
      );
      return;
    }
    console.error(`Error in ${name} after ${ageMs}ms:`, error);
    if (interaction.isCommand()) {
      const message = error instanceof Error ? error.message : String(error);
      await replyError(
        interaction,
        `Error in /${interaction.commandName}`,
        message.slice(0, 1000),
      ).catch(() => {});
    }
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(client));
}

await client.login(readToken());
