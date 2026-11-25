import { cpus, totalmem } from "node:os";
import {
  ApplicationCommandOptionType,
  type AutocompleteInteraction,
  type CommandInteraction,
  MessageFlags,
  OAuth2Scopes,
  version as discordJsVersion,
} from "discord.js";
import {
  type DApplicationCommand,
  Discord,
  Guard,
  MetadataStorage,
  Slash,
  SlashOption,
} from "discordx";
import { Category, type ICategory } from "@discordx/utilities";
import { config } from "../config.js";
import { GUILD_ONLY, HIDDEN_COMMANDS } from "../lib/categories.js";
import { Cooldown } from "../lib/cooldown.js";
import { baseEmbed, replyError, userAuthor } from "../lib/embeds.js";
import { pick } from "../lib/random.js";
import { type BotModule, ENABLED_MODULES, isAvailableIn } from "../modules.js";

/** Discord shows at most this many autocomplete suggestions. */
const MAX_SUGGESTIONS = 25;

/** Discord embeds hold at most this many fields. */
const MAX_EMBED_FIELDS = 25;

const CPU_SAMPLE_MS = 200;

/** The permissions the original bot's invite link requested. */
const INVITE_PERMISSIONS = 536210679n;

/** Shows a command's usage, such as `/roll [dice]` or `/kick <member> [reason]`. */
function usage(command: DApplicationCommand): string {
  // discordx stores options in reverse because parameter decorators run last to first.
  const options = [...command.options]
    .reverse()
    .map((option) => (option.required ? `<${option.name}>` : `[${option.name}]`));
  const path = [command.group, command.subgroup, command.name].filter(Boolean);
  return `\`/${[...path, ...options].join(" ")}\``;
}

/** Commands in a /help module, in the order they were declared. */
function commandsIn(module: BotModule): DApplicationCommand[] {
  return MetadataStorage.instance.applicationCommandSlashesFlat.filter(
    (command) =>
      (command as DApplicationCommand & ICategory).category === module.name &&
      !HIDDEN_COMMANDS.has(command.name),
  );
}

/** The loaded modules that work in a server, which are the ones /help shows there. */
function modulesIn(guildId: string | null): BotModule[] {
  return ENABLED_MODULES.filter((module) => isAvailableIn(module, guildId));
}

/**
 * Suggests module names for /help. Choices would be the same in every
 * server, so autocomplete keeps server-limited modules out of other servers.
 */
async function suggestModules(interaction: AutocompleteInteraction): Promise<void> {
  const typed = interaction.options.getFocused().toLowerCase();
  const names = modulesIn(interaction.guildId)
    .map((module) => module.name)
    .filter((name) => name.toLowerCase().includes(typed))
    .slice(0, MAX_SUGGESTIONS);
  await interaction.respond(names.map((name) => ({ name, value: name })));
}

/** Formats seconds as the original bot did, one unit per line. */
function formatDuration(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${days} day(s)\n${hours} hour(s)\n${minutes} minute(s)\n${seconds} second(s)`;
}

/** Measures the bot process's CPU use, as a percentage of all cores, over a short sample. */
async function sampleCpuPercent(): Promise<number> {
  const start = process.cpuUsage();
  await new Promise((resolve) => setTimeout(resolve, CPU_SAMPLE_MS));
  const { user, system } = process.cpuUsage(start);
  return ((user + system) / 1000 / CPU_SAMPLE_MS / cpus().length) * 100;
}

function inviteUrl(interaction: CommandInteraction): string {
  return interaction.client.generateInvite({
    scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
    permissions: INVITE_PERMISSIONS,
  });
}

/** The support, invite, and website fields. Unset links are left out. */
function linkFields(interaction: CommandInteraction) {
  const botName = interaction.client.user.username;
  const fields = [];
  if (config.links.support) {
    fields.push({
      name: "🙋 Support Server",
      value: `[Support Server](${config.links.support})`,
      inline: true,
    });
  }
  fields.push({
    name: "🤖 Bot Invite",
    value: `[${botName} Invite](${inviteUrl(interaction)})`,
    inline: true,
  });
  if (config.links.website) {
    fields.push({
      name: `🔗 ${botName} Website`,
      value: `[${botName} Website](${config.links.website})`,
      inline: true,
    });
  }
  return fields;
}

/**
 * Sends a loading embed and returns how long Discord took to acknowledge it,
 * as the original ping and stats commands did.
 */
async function measureRoundTrip(interaction: CommandInteraction): Promise<number> {
  const loading = baseEmbed(interaction).setDescription("Loading...").setTimestamp(null);
  const start = performance.now();
  await interaction.reply({ embeds: [loading] });
  return performance.now() - start;
}

function latencyField(interaction: CommandInteraction, roundTripMs: number) {
  return {
    name: pick(["🏓 Pong", "🏓 Ping"]),
    value:
      `Websocket Latency: **${interaction.client.ws.ping}ms**\n` +
      `Command Latency: **${roundTripMs.toFixed(3)}ms**`,
    inline: true,
  };
}

@Discord()
@Category("Meta")
export class Meta {
  @Slash({ name: "help", description: "Displays this message", ...GUILD_ONLY })
  @Guard(Cooldown(5, 2))
  async help(
    @SlashOption({
      name: "module",
      description: "Show the commands in one module",
      type: ApplicationCommandOptionType.String,
      required: false,
      autocomplete: suggestModules,
    })
    moduleName: string | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    const available = modulesIn(interaction.guildId);
    const embed = baseEmbed(interaction)
      .setAuthor(userAuthor(interaction.user))
      .setThumbnail(interaction.client.user.displayAvatarURL());

    if (!moduleName) {
      embed
        .setTitle("🔧 Module List")
        .setDescription("Do `/help [module]` for more info on a specific module.")
        .addFields(available.map((module) => ({ name: module.name, value: module.description })));
    } else {
      // Autocomplete only suggests names, so the member can still type anything.
      const module = available.find(
        (candidate) => candidate.name.toLowerCase() === moduleName.trim().toLowerCase(),
      );
      if (!module) {
        await replyError(
          interaction,
          "Unknown module",
          `There is no \`${moduleName.slice(0, 100)}\` module here. Do \`/help\` to list the modules.`,
        );
        return;
      }
      const commands = commandsIn(module);
      embed.setTitle(`🚧 ${module.name} Command List`);
      if (commands.length <= MAX_EMBED_FIELDS) {
        embed
          .setDescription(`**${module.name} - ${module.description}**`)
          .addFields(
            commands.map((command) => ({ name: usage(command), value: command.description })),
          );
      } else {
        // Embeds hold at most 25 fields, so larger modules list one command per line.
        const lines = commands.map((command) => `${usage(command)}\n${command.description}`);
        embed.setDescription(
          [`**${module.name} - ${module.description}**`, ...lines].join("\n").slice(0, 4096),
        );
      }
    }
    await interaction.reply({ embeds: [embed] });
  }

  @Slash({ name: "stats", description: "Displays GuhBot's statistics", ...GUILD_ONLY })
  @Guard(Cooldown(8))
  async stats(interaction: CommandInteraction): Promise<void> {
    const client = interaction.client;
    const botName = client.user.username;
    const roundTrip = await measureRoundTrip(interaction);

    const cpuPercent = await sampleCpuPercent();
    const { user, system } = process.cpuUsage();
    const memoryTotalMiB = totalmem() / 1024 ** 2;
    const memoryUsedMiB = process.memoryUsage.rss() / 1024 ** 2;
    const memberCount = client.guilds.cache.reduce((sum, guild) => sum + guild.memberCount, 0);

    const embed = baseEmbed(interaction)
      .setTitle("📊 Stats")
      .setDescription(`List of ${botName}'s statistics`)
      .addFields(
        {
          name: "🔢 Server Count",
          value: `Working in **${client.guilds.cache.size.toLocaleString("en-US")}** servers.`,
          inline: true,
        },
        {
          name: "👥 Member Count",
          value: `Serving **${memberCount.toLocaleString("en-US")}** members.`,
          inline: true,
        },
        { name: "🌐 Version", value: `GuhBot Version **${config.version}**`, inline: true },
        {
          name: "🟩 Node.js Version",
          value: `${botName} runs on **Node.js ${process.versions.node}**.`,
          inline: true,
        },
        {
          name: "📜 discord.js Version",
          value: `${botName} runs on **discord.js ${discordJsVersion}**.`,
          inline: true,
        },
        latencyField(interaction, roundTrip),
        { name: "⏰ Uptime", value: formatDuration(process.uptime()), inline: true },
        { name: "💾 CPU Time", value: formatDuration((user + system) / 1_000_000), inline: true },
        { name: "⚙️ CPU Usage", value: `**${cpuPercent.toFixed(1)}%**`, inline: true },
        {
          name: "💽 Memory Usage",
          value: `${memoryUsedMiB.toFixed(3)} / ${memoryTotalMiB.toFixed(0)} MiB (${((memoryUsedMiB / memoryTotalMiB) * 100).toFixed(0)}%)`,
          inline: true,
        },
        ...linkFields(interaction),
      )
      .setFooter({ text: `@guhbean | ${botName}` })
      .setAuthor({ name: botName, iconURL: client.user.displayAvatarURL() })
      .setThumbnail(client.user.displayAvatarURL());
    await interaction.editReply({ embeds: [embed] });
  }

  @Slash({
    name: "ping",
    description: "Returns the Discord API / Websocket latency",
    ...GUILD_ONLY,
  })
  @Guard(Cooldown(5))
  async ping(interaction: CommandInteraction): Promise<void> {
    const roundTrip = await measureRoundTrip(interaction);
    const client = interaction.client;
    const embed = baseEmbed(interaction)
      .setAuthor({ name: client.user.username, iconURL: client.user.displayAvatarURL() })
      .addFields(latencyField(interaction, roundTrip));
    await interaction.editReply({ embeds: [embed] });
  }

  @Slash({
    name: "support",
    description: "Returns both support server invite and the bot invite hyperlink",
    ...GUILD_ONLY,
  })
  @Guard(Cooldown(5))
  async support(interaction: CommandInteraction): Promise<void> {
    const client = interaction.client;
    const embed = baseEmbed(interaction)
      .setTitle("Need Help❓")
      .setDescription("Use the hyperlinks below to get access to the GuhBot support server")
      .addFields(linkFields(interaction))
      .setAuthor({ name: client.user.username, iconURL: client.user.displayAvatarURL() })
      .setThumbnail("https://media.giphy.com/media/9ZOyRdXL7ZVKg/giphy.gif")
      .setFooter({ text: "@guhbean | GuhBot" });
    await interaction.reply({ embeds: [embed] });
  }

  @Slash({
    name: "upvote",
    description: "Support GuhBot? Upvote using this command!",
    ...GUILD_ONLY,
  })
  @Guard(Cooldown(5))
  async upvote(interaction: CommandInteraction): Promise<void> {
    const sites = [
      { name: "Top Discord Bots", label: "top.gg", url: config.links.topgg },
      { name: "Discord Bot List", label: "discordbotlist.com", url: config.links.discordBotList },
    ].filter((site) => site.url);
    if (sites.length === 0) {
      await interaction.reply({
        content: "No vote links are set up.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const client = interaction.client;
    const embed = baseEmbed(interaction)
      .setTitle("🔺 Upvote GuhBot")
      .setDescription(
        "Provided hyperlinks bring you to GuhBot's upvote links.\nUpvoting the bot gets us more users 😀",
      )
      .addFields(
        sites.map((site) => ({
          name: site.name,
          value: `[${site.label}](${site.url})`,
          inline: true,
        })),
      )
      .setAuthor({ name: client.user.username, iconURL: client.user.displayAvatarURL() })
      .setThumbnail("https://media.giphy.com/media/4eQFLKTo1Tymc/giphy.gif")
      .setFooter({ text: "Thanks for upvoting GuhBot!👍" });
    await interaction.reply({ embeds: [embed] });
  }
}
