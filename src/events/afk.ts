import { EmbedBuilder, type Message } from "discord.js";
import { type ArgsOf, Discord, On } from "discordx";
import { afkStore } from "../lib/database.js";
import { Colours, userAuthor } from "../lib/embeds.js";

/** How long AFK notices stay in the channel before the bot deletes them. */
const NOTICE_LIFETIME_MS = 15_000;

async function sendTemporary(message: Message, embed: EmbedBuilder): Promise<void> {
  if (!message.channel.isSendable()) return;
  const notice = await message.channel.send({ embeds: [embed] });
  setTimeout(() => notice.delete().catch(() => {}), NOTICE_LIFETIME_MS);
}

/**
 * Clears a user's AFK status when they talk, and tells others when they
 * mention someone who is AFK. This needs only the Guild Messages intent,
 * because mentions arrive without the privileged Message Content intent.
 */
@Discord()
export class AfkListener {
  @On({ event: "messageCreate" })
  async onMessage([message]: ArgsOf<"messageCreate">): Promise<void> {
    if (message.author.bot || !message.inGuild()) return;

    const ownStatus = afkStore.get(message.author.id);
    if (ownStatus) {
      afkStore.clear(message.author.id);
      const embed = new EmbedBuilder()
        .setTitle("🟢 Cleared AFK Status")
        .setDescription(
          `You have **automatically** been marked as **no longer AFK**, you had **${ownStatus.mentions} mention(s)** while you were **AFK** for: **${ownStatus.reason}**`,
        )
        .setColor(Colours.green)
        .setAuthor(userAuthor(message.author))
        .setTimestamp(message.createdAt);
      await sendTemporary(message, embed);
    }

    for (const user of message.mentions.users.values()) {
      if (user.bot || user.id === message.author.id) continue;
      const status = afkStore.get(user.id);
      if (!status) continue;
      afkStore.addMention(user.id);
      const embed = new EmbedBuilder()
        .setTitle("🔴 AFK")
        .setDescription(`${user} is currently set as **AFK** for: **${status.reason}**`)
        .setColor(Colours.red)
        .setAuthor(userAuthor(user))
        .setTimestamp(message.createdAt);
      await sendTemporary(message, embed);
    }
  }
}
