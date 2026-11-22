import { cpus, totalmem } from "node:os";
import {
  ApplicationCommandOptionType,
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
  SlashChoice,
  SlashOption,
} from "discordx";
import { Category, type ICategory } from "@discordx/utilities";
import { config } from "../config.js";
import { CATEGORIES, type CategoryName, GUILD_ONLY, HIDDEN_COMMANDS } from "../lib/categories.js";
import { Cooldown } from "../lib/cooldown.js";
import { baseEmbed, userAuthor } from "../lib/embeds.js";
import { pick } from "../lib/random.js";

const CPU_SAMPLE_MS = 200;

/** The permissions the original bot's invite link requested. */
const INVITE_PERMISSIONS = 536210679n;

/** Shows a command's usage, such as `/roll [dice]` or `/kick <member> [reason]`. */
function usage(command: DApplicationCommand): string {
  // discordx stores options in reverse because parameter decorators run last to first.
  const options = [...command.options]
    .reverse()
    .map((option) => (option.required ? `<${option.name}>` : `[${option.name}]`));
  return `\`/${[command.name, ...options].join(" ")}\``;
}

/** Commands in a /help module, in the order they were declared. */
function commandsIn(category: CategoryName): DApplicationCommand[] {
  return MetadataStorage.instance.applicationCommandSlashesFlat.filter(
    (command) =>
      (command as DApplicationCommand & ICategory).category === category &&
      !HIDDEN_COMMANDS.has(command.name),
  );
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
    @SlashChoice(...Object.keys(CATEGORIES))
    @SlashOption({
      name: "module",
      description: "Show the commands in one module",
      type: ApplicationCommandOptionType.String,
      required: false,
    })
    module: CategoryName | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    const embed = baseEmbed(interaction)
      .setAuthor(userAuthor(interaction.user))
      .setThumbnail(interaction.client.user.displayAvatarURL());

    if (!module) {
      embed
        .setTitle("🔧 Module List")
        .setDescription("Do `/help [module]` for more info on a specific module.")
        .addFields(
          Object.entries(CATEGORIES).map(([name, description]) => ({ name, value: description })),
        );
    } else {
      embed
        .setTitle(`🚧 ${module} Command List`)
        .setDescription(`**${module} - ${CATEGORIES[module]}**`)
        .addFields(
          commandsIn(module).map((command) => ({
            name: usage(command),
            value: command.description,
          })),
        );
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
      .setFooter({ text: `GuhBean#8433 | ${botName}` })
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
      .setFooter({ text: "GuhBean#8433 | GuhBot" });
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
