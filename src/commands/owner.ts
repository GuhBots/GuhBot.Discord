import { ApplicationCommandOptionType, type CommandInteraction, MessageFlags } from "discord.js";
import { Discord, Guard, Guild, Slash, SlashOption } from "discordx";
import { config } from "../config.js";
import { GUILD_ONLY } from "../lib/categories.js";
import { replyError } from "../lib/embeds.js";
import { announce, shutdown } from "../lib/lifecycle.js";
import { IsOwner } from "../lib/owner.js";
import {
  ACTIVITY_WORDS,
  DEFAULT_STATUS,
  isValidStatus,
  setStatusTemplate,
} from "../lib/presence.js";

/**
 * Commands for the bot's owners. The entry point imports this module only
 * when OWNER_GUILD_ID is set, and the commands are registered only in that guild.
 */
@Discord()
@Guild(config.ownerGuildId!)
@Guard(IsOwner)
export class Owner {
  @Slash({ name: "setstatus", description: "Change bot status", ...GUILD_ONLY })
  async setStatus(
    @SlashOption({
      name: "status",
      description:
        "Starts with playing, watching, listening-to, or competing. Supports {guilds} {users} {version}",
      type: ApplicationCommandOptionType.String,
      required: false,
      maxLength: 128,
    })
    status: string | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    const template = status ?? DEFAULT_STATUS;
    if (!isValidStatus(template)) {
      await replyError(
        interaction,
        "Invalid activity",
        `Start the status with one of: ${ACTIVITY_WORDS.map((word) => `\`${word}\``).join(", ")}.`,
      );
      return;
    }
    setStatusTemplate(interaction.client, template);
    await interaction.reply({
      content: `Set status to \`${template}\``,
      flags: MessageFlags.Ephemeral,
    });
  }

  @Slash({ name: "logout", description: "Disconnects the bot. Docker restarts it.", ...GUILD_ONLY })
  async logout(
    @SlashOption({
      name: "reason",
      description: "Why the bot is going offline",
      type: ApplicationCommandOptionType.String,
      required: false,
    })
    reason: string | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    await interaction.reply(`:wave: Goodbye ${interaction.user}! I'm shutting dow...`);
    await announce(
      interaction.client,
      `${interaction.user} is logging me out for: **${reason ?? "No Reason"}**\n:wave: Goodbye everyone! I'm shutting dow...`,
    );
    await shutdown(interaction.client);
  }
}
