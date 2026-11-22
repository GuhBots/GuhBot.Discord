import type { CommandInteraction } from "discord.js";
import { Discord, Guard, Guild, Slash } from "discordx";
import { Category } from "@discordx/utilities";
import { config } from "../config.js";
import { GUILD_ONLY } from "../lib/categories.js";
import { Cooldown } from "../lib/cooldown.js";

/**
 * Archiving tools for specific servers. The module loads only when
 * ARCHIVIST_GUILD_IDS lists a server, and its commands register only there.
 */
@Discord()
@Category("Archivist")
@Guild(...config.archivistGuildIds)
export class Archivist {
  @Slash({ name: "archivist", description: "Archiving tools for this server", ...GUILD_ONLY })
  @Guard(Cooldown(3))
  async archivist(interaction: CommandInteraction): Promise<void> {
    await interaction.reply("WIP");
  }
}
