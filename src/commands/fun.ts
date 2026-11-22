import {
  ApplicationCommandOptionType,
  type CommandInteraction,
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  type User,
} from "discord.js";
import { Discord, Guard, Slash, SlashOption } from "discordx";
import { Category } from "@discordx/utilities";
import { GUILD_ONLY } from "../lib/categories.js";
import { Cooldown } from "../lib/cooldown.js";
import { pick } from "../lib/random.js";
import { baseEmbed, memberColour, replyError, userAuthor } from "../lib/embeds.js";

const CUSTOM_EMOJI = /^<(a?):(\w{2,32}):(\d{17,20})>$/;

const KANYE_IMAGES = [
  "https://cdn.discordapp.com/attachments/732800092045836338/755602650761920522/9k.png",
  "https://cdn.discordapp.com/attachments/755144098578563164/755600589232013402/unknown.png",
  "https://cdn.discordapp.com/attachments/732800092045836338/755600986315292773/GettyImages-599438126.png",
];

/** Parses a custom emoji such as `<:name:123>`, or returns undefined for anything else. */
function parseCustomEmoji(text: string) {
  const match = CUSTOM_EMOJI.exec(text.trim());
  return match ? { animated: match[1] === "a", name: match[2]!, id: match[3]! } : undefined;
}

@Discord()
@Category("Fun")
export class Fun {
  @Slash({
    name: "echo",
    description: "This command repeats what you say.",
    defaultMemberPermissions: PermissionFlagsBits.ManageMessages,
    ...GUILD_ONLY,
  })
  @Guard(Cooldown(3))
  async echo(
    @SlashOption({
      name: "message",
      description: "What GuhBot should say",
      type: ApplicationCommandOptionType.String,
      required: true,
      maxLength: 4000,
    })
    message: string,
    interaction: CommandInteraction,
  ): Promise<void> {
    // The original deleted the command message so the echo looked anonymous.
    // A slash command leaves no message, so post to the channel and confirm privately.
    const channel = interaction.channel;
    if (!channel?.isSendable()) {
      await replyError(interaction, "Can't send here", "I can't send messages in this channel.");
      return;
    }
    const embed = new EmbedBuilder()
      .setDescription(message)
      .setColor(memberColour(interaction.member));
    await channel.send({ embeds: [embed] });
    await interaction.reply({ content: "Sent!", flags: MessageFlags.Ephemeral });
  }

  @Slash({
    name: "pp",
    description: "Revolutionary peepee measurement system. 100% accuracy",
    ...GUILD_ONLY,
  })
  @Guard(Cooldown(5))
  async pp(
    @SlashOption({
      name: "member",
      description: "Whose to measure",
      type: ApplicationCommandOptionType.User,
      required: false,
    })
    user: GuildMember | User | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    const target = user instanceof GuildMember ? user.user : (user ?? interaction.user);
    const member = interaction.guild?.members.resolve(target.id);
    const inches = Math.floor(Math.random() * 21);
    const embed = new EmbedBuilder()
      .setTitle("🌭Glizzy Machine")
      .setDescription("With outstanding accuracy, GuhBot measures your *schlong*")
      .setColor(memberColour(member))
      .addFields(
        { name: `🍆${target.tag}'s penis`, value: `8${"=".repeat(inches)}D`, inline: true },
        { name: "📏Size Check", value: `A whopping ${inches} inches!`, inline: true },
      )
      .setThumbnail("https://media.giphy.com/media/qLa4BxKoJphYI/giphy.gif")
      .setAuthor(userAuthor(target))
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  }

  @Slash({ name: "emoji", description: "Send animated server emojis", ...GUILD_ONLY })
  @Guard(Cooldown(5))
  async emoji(
    @SlashOption({
      name: "emoji",
      description: "A custom emoji from a server GuhBot is in",
      type: ApplicationCommandOptionType.String,
      required: true,
    })
    text: string,
    interaction: CommandInteraction,
  ): Promise<void> {
    const emoji = parseCustomEmoji(text);
    if (!emoji || !interaction.client.emojis.cache.has(emoji.id)) {
      await interaction.reply({
        content: `${interaction.user}, I can't use that emoji.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply(`<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`);
  }

  @Slash({
    name: "enlarge",
    description: "Get a gif or image version of a custom emoji",
    ...GUILD_ONLY,
  })
  @Guard(Cooldown(5))
  async enlarge(
    @SlashOption({
      name: "emoji",
      description: "A custom emoji",
      type: ApplicationCommandOptionType.String,
      required: true,
    })
    text: string,
    interaction: CommandInteraction,
  ): Promise<void> {
    const emoji = parseCustomEmoji(text);
    if (!emoji) {
      await replyError(interaction, "Not a custom emoji", "Pick a custom server emoji to enlarge.");
      return;
    }
    await interaction.reply(
      `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? "gif" : "png"}`,
    );
  }

  @Slash({ name: "guh", description: "Goo Goo", ...GUILD_ONLY })
  @Guard(Cooldown(5))
  async guh(interaction: CommandInteraction): Promise<void> {
    const embed = baseEmbed(interaction)
      .setTitle("👶 GAH GAH")
      .setImage("https://media.giphy.com/media/14kqI3Y4urS3rG/giphy.gif")
      .setFooter({ text: "GuhBoyooo" });
    await interaction.reply({ embeds: [embed] });
  }

  @Slash({
    name: "kanye",
    description: "Random Kanye West quotes. Thank you Kanye, very cool!",
    ...GUILD_ONLY,
  })
  @Guard(Cooldown(5))
  async kanye(interaction: CommandInteraction): Promise<void> {
    await interaction.deferReply();
    const response = await fetch("https://api.kanye.rest/", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await interaction.editReply(`API returned a \`${response.status} status.\` Try again.`);
      return;
    }
    const { quote } = (await response.json()) as { quote: string };
    const embed = baseEmbed(interaction)
      .setTitle("Kanye West once said...")
      .setURL("https://kanye.rest/")
      .setDescription(`"${quote}"`)
      .setImage(pick(KANYE_IMAGES))
      .setFooter({ text: "Thank you Kanye, very cool!" });
    await interaction.editReply({ embeds: [embed] });
  }
}
