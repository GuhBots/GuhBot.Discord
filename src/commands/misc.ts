import {
  ApplicationCommandOptionType,
  ChannelType,
  type CommandInteraction,
  EmbedBuilder,
  type Guild,
  type GuildMember,
  PermissionFlagsBits,
  type Role,
  time,
  TimestampStyles,
  type User,
} from "discord.js";
import { Discord, Guard, Slash, SlashOption } from "discordx";
import { Category } from "@discordx/utilities";
import { GUILD_ONLY } from "../lib/categories.js";
import { Cooldown } from "../lib/cooldown.js";
import { afkStore } from "../lib/database.js";
import { Colours, memberColour, replyError, userAuthor } from "../lib/embeds.js";

const AFK_REASON_LIMIT = 150;

/** A full date and time that Discord shows in each reader's own time zone. */
function fullDate(date: Date | null): string {
  return date ? time(date, TimestampStyles.LongDateTime) : "Unknown";
}

/** Counts bans when the bot may read them, or returns undefined. */
async function countBans(guild: Guild): Promise<number | undefined> {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
    return undefined;
  }
  try {
    return (await guild.bans.fetch()).size;
  } catch {
    return undefined;
  }
}

function acknowledgement(member: GuildMember): string | undefined {
  if (member.id === member.guild.ownerId) return "Server Owner";
  if (member.id === member.client.user.id) return "Hey that's me!";
  if (member.user.bot) return "Discord Bot";
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return "Server Admin";
  return undefined;
}

@Discord()
@Category("Misc")
export class Misc {
  @Slash({
    name: "serverinfo",
    description: "Get information on the current server",
    ...GUILD_ONLY,
  })
  @Guard(Cooldown(8))
  async serverInfo(interaction: CommandInteraction): Promise<void> {
    const guild = interaction.guild!;
    const owner = await guild.fetchOwner();
    const channels = guild.channels.cache;
    const countChannels = (type: ChannelType) => channels.filter((c) => c.type === type).size;
    const bans = await countBans(guild);

    const embed = new EmbedBuilder()
      .setTitle("Server Information")
      .setColor(owner.displayColor)
      .setThumbnail(guild.iconURL())
      .addFields(
        { name: "📛 Name", value: `${guild.name}\n\`${guild.id}\``, inline: true },
        { name: "👑 Owner", value: `${owner.user.tag}\n\`${owner.id}\``, inline: true },
        { name: "🕑 Created At", value: `**${fullDate(guild.createdAt)}**`, inline: false },
        { name: "👥 Members", value: `${guild.memberCount}`, inline: true },
        {
          name: "📜 Text channels",
          value: `${countChannels(ChannelType.GuildText)}`,
          inline: true,
        },
        {
          name: "🔊 Voice channels",
          value: `${countChannels(ChannelType.GuildVoice)}`,
          inline: true,
        },
        {
          name: "🌀 Categories",
          value: `${countChannels(ChannelType.GuildCategory)}`,
          inline: true,
        },
        { name: "🏁 Roles", value: `${guild.roles.cache.size}`, inline: true },
        { name: "🥇 Boost Level", value: `${guild.premiumTier}`, inline: true },
        { name: "💎 Boosts", value: `${guild.premiumSubscriptionCount ?? 0}`, inline: true },
        { name: "🌊 Server Splash", value: guild.splashURL() ?? "None", inline: true },
      )
      .setFooter({ text: `${owner.user.tag} | ${owner.id}`, iconURL: owner.displayAvatarURL() })
      .setTimestamp();
    if (bans !== undefined) {
      embed.addFields({ name: "🔨 Banned Members", value: `${bans}`, inline: true });
    }
    await interaction.reply({ embeds: [embed] });
  }

  @Slash({ name: "roleinfo", description: "Learn more about a specific role", ...GUILD_ONLY })
  @Guard(Cooldown(8))
  async roleInfo(
    @SlashOption({
      name: "role",
      description: "The role to inspect (default your highest role)",
      type: ApplicationCommandOptionType.Role,
      required: false,
    })
    option: Role | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    const guild = interaction.guild!;
    const member = await guild.members.fetch(interaction.user.id);
    const role = option ?? member.roles.highest;
    const embed = new EmbedBuilder()
      .setTitle("Role Information")
      .setColor(role.color)
      .addFields(
        { name: "📛 Name", value: role.name, inline: true },
        { name: "💳 ID", value: role.id, inline: true },
        { name: "🎨 Colour", value: role.hexColor, inline: true },
        { name: "🕑 Created At", value: fullDate(role.createdAt), inline: true },
        {
          name: "🏆 Position",
          value: `Role ${role.position + 1}/${guild.roles.cache.size}`,
          inline: true,
        },
      )
      .setThumbnail(guild.iconURL())
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  }

  @Slash({
    name: "avatar",
    description: "Returns the user's profile picture and ID",
    ...GUILD_ONLY,
  })
  @Guard(Cooldown(8))
  async avatar(
    @SlashOption({
      name: "member",
      description: "Whose avatar to show (default you)",
      type: ApplicationCommandOptionType.User,
      required: false,
    })
    user: User | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    const target = user ?? interaction.user;
    const member = interaction.guild?.members.resolve(target.id);
    const embed = new EmbedBuilder()
      .setColor(memberColour(member))
      .addFields({ name: target.tag, value: `User ID: ${target.id}` })
      .setImage(target.displayAvatarURL({ size: 1024 }))
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  }

  @Slash({ name: "whois", description: "Get info on a specific user", ...GUILD_ONLY })
  @Guard(Cooldown(8))
  async whois(
    @SlashOption({
      name: "member",
      description: "Who to look up (default you)",
      type: ApplicationCommandOptionType.User,
      required: false,
    })
    user: User | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    const guild = interaction.guild!;
    const target = user ?? interaction.user;
    const member = await guild.members.fetch(target.id).catch(() => undefined);
    if (!member) {
      await replyError(interaction, "Not a member", `${target} isn't a member of this server.`);
      return;
    }

    const roles = member.roles.cache
      .filter((role) => role.id !== guild.id)
      .sort((a, b) => b.position - a.position);
    const embed = new EmbedBuilder()
      .setDescription(`${member}\nID: ${member.id}`)
      .setColor(member.displayColor)
      .addFields(
        { name: "Nickname", value: member.displayName, inline: true },
        { name: "Joined", value: fullDate(member.joinedAt), inline: false },
        { name: "Registered", value: fullDate(member.user.createdAt), inline: true },
        {
          name: `Roles [${roles.size || 1}]`,
          value: roles.size
            ? roles
                .map((role) => `${role}`)
                .join(" ")
                .slice(0, 1024)
            : "@everyone",
          inline: false,
        },
        {
          name: "Highest Role",
          value: roles.size ? `${member.roles.highest}` : "@everyone",
          inline: true,
        },
      )
      .setThumbnail(member.displayAvatarURL())
      .setAuthor(userAuthor(member.user))
      .setFooter({ text: guild.name, iconURL: guild.iconURL() ?? undefined })
      .setTimestamp();
    const note = acknowledgement(member);
    if (note) {
      embed.addFields({ name: "Acknowledgements", value: note, inline: true });
    }
    await interaction.reply({ embeds: [embed] });
  }

  @Slash({ name: "afk", description: "Set your account to an AFK status", ...GUILD_ONLY })
  @Guard(Cooldown(8))
  async afk(
    @SlashOption({
      name: "reason",
      description: "Why you're away",
      type: ApplicationCommandOptionType.String,
      required: false,
      maxLength: AFK_REASON_LIMIT,
    })
    reason: string | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    const text = reason ?? "No Reason";
    afkStore.set(interaction.user.id, text);
    const botName = interaction.client.user.username;
    const embed = new EmbedBuilder()
      .setTitle("🟡 Now AFK")
      .setDescription(`${interaction.user} is now **AFK** for: **${text}**`)
      .setColor(Colours.yellow)
      .addFields({
        name: "❓ How to remove an AFK status",
        value:
          `If you wish to **remove** your **AFK status**, say something in one of the channels that ${botName} can see.\n\n` +
          `You can **clear** your **AFK status** in any server that ${botName} is in.`,
      })
      .setAuthor(userAuthor(interaction.user))
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  }
}
