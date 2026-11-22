import { ApplicationCommandOptionType, type CommandInteraction } from "discord.js";
import { Discord, Guard, Slash, SlashChoice, SlashOption } from "discordx";
import { Category } from "@discordx/utilities";
import { GUILD_ONLY } from "../lib/categories.js";
import { Cooldown } from "../lib/cooldown.js";
import { pick, randomInt } from "../lib/random.js";
import { baseEmbed } from "../lib/embeds.js";

/** Each die's result range and the animation shown beside the result. */
const DICE = {
  D00: {
    roll: () => `${randomInt(0, 100)}%`,
    gif: "https://media.giphy.com/media/dZAD46L9Ph3zHcjXZA/giphy.gif",
  },
  D4: {
    roll: () => randomInt(1, 4),
    gif: "https://media.giphy.com/media/fiqcUhBNj6jWgJnRlu/giphy.gif",
  },
  D6: {
    roll: () => randomInt(1, 6),
    gif: "https://media.giphy.com/media/1inmH7UuBPbUGWteWb/giphy.gif",
  },
  D8: {
    roll: () => randomInt(1, 8),
    gif: "https://media.giphy.com/media/TJla6Pfq8AXHFfeDf0/giphy.gif",
  },
  D10: {
    roll: () => randomInt(1, 10),
    gif: "https://media.giphy.com/media/dZAD46L9Ph3zHcjXZA/giphy.gif",
  },
  D12: {
    roll: () => randomInt(1, 12),
    gif: "https://media.giphy.com/media/j5Eo80qWJO79MbDUxr/giphy.gif",
  },
  D20: {
    roll: () => randomInt(1, 20),
    gif: "https://media.giphy.com/media/3oriNPdeu2W1aelciY/giphy.gif",
  },
} as const;

type Die = keyof typeof DICE;

const EIGHT_BALL_RESPONSES = [
  "As I see it, yes.",
  "Ask again later.",
  "Better not tell you now.",
  "Cannot predict now.",
  "Concentrate and ask again.",
  "Don’t count on it.",
  "It is certain.",
  "It is decidedly so.",
  "Most likely.",
  "My reply is no.",
  "My sources say no.",
  "Outlook not so good.",
  "Outlook good.",
  "Reply hazy, try again.",
  "Signs point to yes.",
  "Very doubtful.",
  "Without a doubt.",
  "Yes.",
  "Yes, definitely.",
  "You may rely on it.",
  "Yesn't",
  "Idk man you tell me.",
  "LMAO don't keep your hopes up",
  "uhm, I don't think so...",
  "hell yeah",
  "wtf obviously not",
  "👍",
  "👎",
  "C3 approves",
  "Koegawa doesn't approve",
];

@Discord()
@Category("Games")
export class Games {
  @Slash({
    name: "roll",
    description: "Roll different types of dice from D4 to D20.",
    ...GUILD_ONLY,
  })
  @Guard(Cooldown(8, 3))
  async roll(
    @SlashChoice(...Object.keys(DICE))
    @SlashOption({
      name: "dice",
      description: "The die to roll (default D6)",
      type: ApplicationCommandOptionType.String,
      required: false,
    })
    die: Die | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    const { roll, gif } = DICE[die ?? "D6"];
    const embed = baseEmbed(interaction)
      .setTitle("🎲 Dice Roll")
      .setDescription(`${interaction.client.user.username} will roll a digital dice`)
      .addFields(
        { name: "From:", value: `${interaction.user}`, inline: true },
        { name: "Result:", value: `\`You rolled a ${roll()}!\``, inline: true },
      )
      .setThumbnail(gif);
    await interaction.reply({ embeds: [embed] });
  }

  @Slash({
    name: "8ball",
    description: "Digital 8ball. Answers to yes or no questions",
    ...GUILD_ONLY,
  })
  @Guard(Cooldown(8, 2))
  async eightBall(
    @SlashOption({
      name: "question",
      description: "A yes or no question",
      type: ApplicationCommandOptionType.String,
      required: true,
      maxLength: 1000,
    })
    question: string,
    interaction: CommandInteraction,
  ): Promise<void> {
    const embed = baseEmbed(interaction)
      .setTitle("🎱 8ball Simulator")
      .setDescription(`${interaction.client.user.username} will simulate a digital 8ball.`)
      .addFields(
        { name: "From:", value: `${interaction.user}`, inline: true },
        { name: "Question:", value: `*${question}*`, inline: true },
        { name: "Result:", value: `\`${pick(EIGHT_BALL_RESPONSES)}\``, inline: true },
      )
      .setThumbnail("https://media.giphy.com/media/ZxblomRBRsdDkSSK9v/giphy.gif");
    await interaction.reply({ embeds: [embed] });
  }

  @Slash({
    name: "decide",
    description: "Answers your questions with a yes or a no",
    ...GUILD_ONLY,
  })
  @Guard(Cooldown(3))
  async decide(
    @SlashOption({
      name: "question",
      description: "What to decide",
      type: ApplicationCommandOptionType.String,
      required: true,
      maxLength: 1000,
    })
    question: string,
    interaction: CommandInteraction,
  ): Promise<void> {
    const embed = baseEmbed(interaction)
      .setTitle("🍀 Decision Maker")
      .setDescription(`${interaction.client.user.username} will make a yes or no decision for you.`)
      .addFields(
        { name: "From:", value: `${interaction.user}`, inline: true },
        { name: "Question:", value: question, inline: true },
        { name: "Answer:", value: `\`${pick(["Yes", "No"])}\``, inline: true },
      )
      .setThumbnail(interaction.user.displayAvatarURL());
    await interaction.reply({ embeds: [embed] });
  }

  @Slash({ name: "coinflip", description: "Coinflip simulation. Heads or Tails", ...GUILD_ONLY })
  @Guard(Cooldown(3))
  async coinflip(interaction: CommandInteraction): Promise<void> {
    const embed = baseEmbed(interaction)
      .setTitle("🤑 Coin Flip Simulator")
      .setDescription(`${interaction.client.user.username} will flip a digital coin for you`)
      .addFields(
        { name: "From:", value: `${interaction.user}`, inline: true },
        {
          name: "Result:",
          value: `The coin landed on \`${pick(["Heads", "Tails"])}\``,
          inline: true,
        },
      )
      .setThumbnail("https://media.giphy.com/media/6jqfXikz9yzhS/giphy.gif");
    await interaction.reply({ embeds: [embed] });
  }
}
