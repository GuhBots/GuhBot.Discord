import { EmbedBuilder, MessageFlags, Team, type CommandInteraction } from "discord.js";
import type { GuardFunction } from "discordx";
import { memberColour, userAuthor } from "./embeds.js";

const RICKROLL = "https://media.giphy.com/media/lgcUUCXgC8mEo/giphy.gif";

/**
 * Returns the IDs of the people who own the Discord application. A team-owned
 * application counts every team member as an owner.
 */
async function fetchOwnerIds(interaction: CommandInteraction): Promise<string[]> {
  const application = await interaction.client.application.fetch();
  const owner = application.owner;
  if (owner instanceof Team) {
    return [...owner.members.keys()];
  }
  return owner ? [owner.id] : [];
}

/** Lets only the application's owners run a command, and rickrolls everyone else. */
export const IsOwner: GuardFunction<CommandInteraction> = async (interaction, _client, next) => {
  if ((await fetchOwnerIds(interaction)).includes(interaction.user.id)) {
    await next();
    return;
  }
  const embed = new EmbedBuilder()
    .setColor(memberColour(interaction.member))
    .addFields({
      name: "You Silly Billy 😜",
      value: "You thought you can actually use this command!",
    })
    .setImage(RICKROLL)
    .setAuthor(userAuthor(interaction.user))
    .setTimestamp();
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
};
