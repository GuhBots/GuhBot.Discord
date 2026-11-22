import {
  ApplicationCommandOptionType,
  type CommandInteraction,
  type GuildBan,
  type GuildMember,
  PermissionFlagsBits,
  type User,
} from "discord.js";
import { Discord, Guard, Slash, SlashOption } from "discordx";
import { Category } from "@discordx/utilities";
import { GUILD_ONLY } from "../lib/categories.js";
import { Cooldown } from "../lib/cooldown.js";
import { baseEmbed, replyError, userAuthor } from "../lib/embeds.js";

const CLEAR_CONFIRMATION_MS = 5_000;
const SNOWFLAKE = /^\d{17,20}$/;

const GREEN_VAN = {
  tag: "Da Vibin Mexican Green Van#1469",
  id: "353866653622337536",
  avatar:
    "https://cdn.discordapp.com/avatars/718438151848329217/609d63f182beeed1c5c840ca5d0b1545.webp?size=1024",
};

const reasonOption = {
  name: "reason",
  description: "Why (shown to the member and in the audit log)",
  type: ApplicationCommandOptionType.String,
  required: false,
  maxLength: 400,
} as const;

/** A member's tag and ID, formatted as the original moderation embeds showed them. */
function describeUser(user: User | { tag: string; id: string }): string {
  return `\`${user.tag}\nID:${user.id}\``;
}

/**
 * Checks that the moderator outranks the target and the bot can act on them.
 * Returns a reason when the action is not allowed.
 */
function checkHierarchy(
  moderator: GuildMember,
  target: GuildMember,
  action: "kick" | "ban",
): string | undefined {
  if (target.id === moderator.id) return `You can't ${action} yourself.`;
  if (target.id === target.guild.ownerId) return `You can't ${action} the server owner.`;
  const outranks =
    moderator.id === moderator.guild.ownerId ||
    moderator.roles.highest.comparePositionTo(target.roles.highest) > 0;
  if (!outranks) return `${target} has a role equal to or higher than yours.`;
  const botCan = action === "kick" ? target.kickable : target.bannable;
  if (!botCan) return `My role isn't high enough to ${action} ${target}.`;
  return undefined;
}

/** Finds a ban by user ID, or by username or tag as the original converter allowed. */
async function findBan(
  interaction: CommandInteraction,
  query: string,
): Promise<GuildBan | undefined> {
  const guild = interaction.guild!;
  if (SNOWFLAKE.test(query)) {
    return guild.bans.fetch(query).catch(() => undefined);
  }
  const bans = await guild.bans.fetch();
  return bans.find((ban) => ban.user.tag === query || ban.user.username === query);
}

@Discord()
@Category("Moderation")
export class Moderation {
  @Slash({
    name: "clear",
    description: "Deletes messages in a channel.",
    defaultMemberPermissions: PermissionFlagsBits.ManageMessages,
    ...GUILD_ONLY,
  })
  @Guard(Cooldown(8))
  async clear(
    @SlashOption({
      name: "amount",
      description: "How many messages to delete (default 6)",
      type: ApplicationCommandOptionType.Integer,
      required: false,
      minValue: 1,
      maxValue: 100,
    })
    amount: number | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    const channel = interaction.channel;
    if (!channel || channel.isDMBased() || !("bulkDelete" in channel)) {
      await replyError(interaction, "Can't clear here", "This channel doesn't support clearing.");
      return;
    }
    // Discord refuses to bulk delete messages older than two weeks, so skip them.
    const deleted = await channel.bulkDelete(amount ?? 6, true);
    const embed = baseEmbed(interaction)
      .setDescription(`Deleted ${deleted.size} messages.`)
      .setAuthor(userAuthor(interaction.user));
    await interaction.reply({ embeds: [embed] });
    setTimeout(() => interaction.deleteReply().catch(() => {}), CLEAR_CONFIRMATION_MS);
  }

  @Slash({
    name: "kick",
    description: "Kicks members from the server (They can still join back)",
    defaultMemberPermissions: PermissionFlagsBits.KickMembers,
    ...GUILD_ONLY,
  })
  @Guard(Cooldown(8))
  async kick(
    @SlashOption({
      name: "member",
      description: "The member to kick",
      type: ApplicationCommandOptionType.User,
      required: true,
    })
    user: User,
    @SlashOption(reasonOption) reason: string | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    await this.punish(interaction, user, reason, "kick");
  }

  @Slash({
    name: "ban",
    description: "Ban members from the server",
    defaultMemberPermissions: PermissionFlagsBits.BanMembers,
    ...GUILD_ONLY,
  })
  @Guard(Cooldown(8))
  async ban(
    @SlashOption({
      name: "member",
      description: "The member to ban",
      type: ApplicationCommandOptionType.User,
      required: true,
    })
    user: User,
    @SlashOption(reasonOption) reason: string | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    await this.punish(interaction, user, reason, "ban");
  }

  /** Kicks or bans a member, telling them first because a removed member can't get the DM. */
  private async punish(
    interaction: CommandInteraction,
    user: User,
    reason: string | undefined,
    action: "kick" | "ban",
  ): Promise<void> {
    const guild = interaction.guild!;
    const moderator = await guild.members.fetch(interaction.user.id);
    const target = await guild.members.fetch(user.id).catch(() => undefined);
    if (!target) {
      await replyError(interaction, "Not a member", `${user} isn't a member of this server.`);
      return;
    }
    const problem = checkHierarchy(moderator, target, action);
    if (problem) {
      await replyError(interaction, `Can't ${action}`, problem);
      return;
    }

    const isKick = action === "kick";
    const embed = baseEmbed(interaction)
      .setTitle(isKick ? "⚽Kick Command" : "🔨Ban Command")
      .setDescription(
        isKick
          ? "GuhBot will kick specified member from the server."
          : "GuhBot will ban the specified member from the server.",
      )
      .addFields(
        { name: isKick ? "Kicked Member:" : "Banned Member:", value: describeUser(user) },
        { name: "Punisher:", value: describeUser(interaction.user) },
        { name: "Reason:", value: `\`${reason ?? "None"}\`` },
      )
      .setThumbnail(
        isKick
          ? "https://media.giphy.com/media/cb4Pg4jau2SEE/giphy.gif"
          : "https://media.giphy.com/media/C51woXfgJdug/giphy.gif",
      )
      .setAuthor(userAuthor(user))
      .setFooter({ text: guild.name, iconURL: guild.iconURL() ?? undefined });

    // Members with closed DMs still get removed.
    await user.send({ embeds: [embed] }).catch(() => {});
    const auditReason = `${interaction.user.tag}: ${reason ?? "No reason given"}`;
    if (isKick) {
      await target.kick(auditReason);
    } else {
      await target.ban({ reason: auditReason });
    }
    await interaction.reply({ embeds: [embed] });
  }

  @Slash({
    name: "unban",
    description: "Unban previously banned members from the server",
    defaultMemberPermissions: PermissionFlagsBits.BanMembers,
    ...GUILD_ONLY,
  })
  @Guard(Cooldown(8))
  async unban(
    @SlashOption({
      name: "user",
      description: "The banned user's ID or username",
      type: ApplicationCommandOptionType.String,
      required: true,
    })
    query: string,
    @SlashOption(reasonOption) reason: string | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    const guild = interaction.guild!;
    const ban = await findBan(interaction, query.trim());
    if (!ban) {
      await replyError(interaction, "Not banned", "This member has not been banned before.");
      return;
    }
    await guild.bans.remove(ban.user, `${interaction.user.tag}: ${reason ?? "No reason given"}`);
    const embed = baseEmbed(interaction)
      .setTitle("😅Unban Command")
      .setDescription("GuhBot will unban previously banned members from the server.")
      .addFields(
        { name: "Unbanned Member:", value: describeUser(ban.user) },
        { name: "Unbanned by:", value: describeUser(interaction.user) },
        { name: "Reason", value: `\`${reason ?? "None"}\`` },
      )
      .setThumbnail("https://media.giphy.com/media/kz0qWS2lAqtdAnEmEM/giphy.gif")
      .setAuthor({ name: ban.user.tag })
      .setFooter({ text: guild.name, iconURL: guild.iconURL() ?? undefined });
    await interaction.reply({ embeds: [embed] });
  }

  @Slash({
    name: "unkick",
    description: "Wait what? Unkick?",
    defaultMemberPermissions: PermissionFlagsBits.KickMembers,
    ...GUILD_ONLY,
  })
  @Guard(Cooldown(8))
  async unkick(
    @SlashOption({
      name: "member",
      description: "The member to unkick",
      type: ApplicationCommandOptionType.User,
      required: false,
    })
    user: User | undefined,
    @SlashOption(reasonOption) reason: string | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    const target = user
      ? { tag: user.tag, id: user.id, avatar: user.displayAvatarURL() }
      : GREEN_VAN;
    const embed = baseEmbed(interaction)
      .setTitle("😕Unkick Command")
      .setDescription(
        "Don't worry, this command doesn't do anything. By default, kicked members are able to join back to the server anyways.",
      )
      .addFields(
        { name: "Unkicked Member:", value: describeUser(target) },
        { name: "Punisher:", value: describeUser(interaction.user) },
        { name: "Reason:", value: `\`${reason ?? 'Because "Erdem" said so.'}\`` },
      )
      .setThumbnail("https://media.giphy.com/media/WRQBXSCnEFJIuxktnw/giphy.gif")
      .setAuthor({ name: target.tag, iconURL: target.avatar })
      .setFooter({ text: "this joke was made by green van", iconURL: GREEN_VAN.avatar });
    await interaction.reply({ embeds: [embed] });
  }
}
