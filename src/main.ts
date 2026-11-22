import "reflect-metadata";
import { GatewayIntentBits, type Interaction } from "discord.js";
import { Client } from "discordx";
import { config, readToken } from "./config.js";
import { syncAllCommands, syncGuildCommands } from "./lib/command-sync.js";
import { replyError } from "./lib/embeds.js";
import { announce, shutdown } from "./lib/lifecycle.js";
import { startPresence } from "./lib/presence.js";

// Importing a module registers its commands and listeners with discordx.
import "./commands/fun.js";
import "./commands/games.js";
import "./commands/images.js";
import "./commands/meta.js";
import "./commands/misc.js";
import "./commands/moderation.js";
import "./commands/roleplay.js";
import "./events/afk.js";

if (config.ownerGuildId) {
  await import("./commands/owner.js");
}

const client = new Client({
  // Neither intent is privileged. Guild Messages lets the AFK listener see
  // who talks and who they mention.
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
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

client.on("interactionCreate", async (interaction: Interaction) => {
  try {
    await client.executeInteraction(interaction);
  } catch (error) {
    console.error(
      `Error in ${interaction.isCommand() ? `/${interaction.commandName}` : "interaction"}:`,
      error,
    );
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
