import "reflect-metadata";
import { GatewayIntentBits, type Interaction } from "discord.js";
import { Client } from "discordx";
import { config, readToken } from "./config.js";
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
  await client.initApplicationCommands();
  startPresence(client);
  console.log(`Logged in as ${client.user?.tag}, version ${config.version}`);
  await announce(client, ":wave: Hello everyone! I'm back online!");
});

// Sync commands again when the bot joins a server, so that a newly joined
// development or owner server gets its commands without a restart.
client.on("guildCreate", async (guild) => {
  console.log(`Joined ${guild.name} (${guild.id}), refreshing commands`);
  try {
    await client.initApplicationCommands();
  } catch (error) {
    console.error(`Could not refresh commands after joining ${guild.id}:`, error);
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
