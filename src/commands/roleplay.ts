import {
  ApplicationCommandOptionType,
  type CommandInteraction,
  EmbedBuilder,
  type User,
} from "discord.js";
import { Discord, Guard, Slash, SlashOption } from "discordx";
import { Category } from "@discordx/utilities";
import { GUILD_ONLY } from "../lib/categories.js";
import { Cooldown } from "../lib/cooldown.js";
import { pick } from "../lib/random.js";
import { baseEmbed, memberColour, userAuthor } from "../lib/embeds.js";

const DAB_STYLES = [
  "with great force",
  "with everlasting power",
  "with passion",
  "in fear",
  "very epicly",
  "like ChroniC BlazE",
];

const DAB_GIFS = [
  "https://media.giphy.com/media/d4blihcFNkwE3fEI/giphy.gif",
  "https://media.giphy.com/media/wIyvbQa4g7CajwxkD5/giphy.gif",
  "https://media.giphy.com/media/l0K4mbH4lKBhAPFU4/giphy.gif",
  "https://media.giphy.com/media/lae7QSMFxEkkE/giphy.gif",
];

@Discord()
@Category("Roleplay")
export class Roleplay {
  @Slash({
    name: "dab",
    description: "A member of your choice will do an epic dab. 2015 much?",
    ...GUILD_ONLY,
  })
  @Guard(Cooldown(5))
  async dab(
    @SlashOption({
      name: "member",
      description: "Who dabs (default you)",
      type: ApplicationCommandOptionType.User,
      required: false,
    })
    user: User | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    const target = user ?? interaction.user;
    const embed = new EmbedBuilder()
      .setDescription(`*dabs ${pick(DAB_STYLES)}*`)
      .setColor(memberColour(interaction.guild?.members.resolve(target.id)))
      .setImage(pick(DAB_GIFS))
      .setAuthor(userAuthor(target))
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  }

  @Slash({ name: "fart", description: "Because h!fart sucks", ...GUILD_ONLY })
  @Guard(Cooldown(5))
  async fart(
    @SlashOption({
      name: "user",
      description: "Who smelled it (default you)",
      type: ApplicationCommandOptionType.User,
      required: false,
    })
    user: User | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    const embed = baseEmbed(interaction)
      .setDescription("*smelled HaxBot's stinky fart*")
      .setAuthor(userAuthor(user ?? interaction.user))
      .setImage("https://media.giphy.com/media/TYNhqiBl8U12w/giphy.gif")
      .setFooter({ text: "😠 happy now?" });
    await interaction.reply({ embeds: [embed] });
  }
}
