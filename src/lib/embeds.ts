import {
  type CommandInteraction,
  EmbedBuilder,
  GuildMember,
  type InteractionReplyOptions,
  MessageFlags,
  type User,
} from "discord.js";

/** Embed colours carried over from the original bot. */
export const Colours = {
  white: 0xffffff,
  aqua: 0x1abc9c,
  yellow: 0xffff00,
  green: 0x2ecc71,
  blue: 0x3498db,
  purple: 0x9b59b6,
  pink: 0xe91e63,
  gold: 0xf1c40f,
  orange: 0xe67e22,
  red: 0xe74c3c,
  navy: 0x34495e,
} as const;

const ERROR_THUMBNAIL = "https://media.giphy.com/media/8L0Pky6C83SzkzU55a/giphy.gif";

/** The colour of a member's highest coloured role, or 0 (no colour) outside a guild. */
export function memberColour(member: unknown): number {
  return member instanceof GuildMember ? member.displayColor : 0;
}

/** The embed author line the original bot used: a user's tag and avatar. */
export function userAuthor(user: User): { name: string; iconURL: string } {
  return { name: user.tag, iconURL: user.displayAvatarURL() };
}

/** A new embed coloured by the invoking member, with the current time. */
export function baseEmbed(interaction: CommandInteraction): EmbedBuilder {
  return new EmbedBuilder().setColor(memberColour(interaction.member)).setTimestamp();
}

/** The red error embed used across commands. */
export function errorEmbed(interaction: CommandInteraction, title: string, message: string) {
  return new EmbedBuilder()
    .setTitle("⛔ Error!")
    .setDescription(
      `Sorry ${interaction.user}, but ${interaction.client.user.username} found an error.`,
    )
    .addFields({ name: title, value: message })
    .setColor(Colours.red)
    .setThumbnail(ERROR_THUMBNAIL)
    .setAuthor(userAuthor(interaction.user))
    .setTimestamp();
}

/** Replies with an error embed visible only to the user, whatever the interaction's state. */
export async function replyError(
  interaction: CommandInteraction,
  title: string,
  message: string,
): Promise<void> {
  const reply: InteractionReplyOptions = {
    embeds: [errorEmbed(interaction, title, message)],
    flags: MessageFlags.Ephemeral,
  };
  if (interaction.deferred) {
    await interaction.editReply({ embeds: reply.embeds });
  } else if (interaction.replied) {
    await interaction.followUp(reply);
  } else {
    await interaction.reply(reply);
  }
}
