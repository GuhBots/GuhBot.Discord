import {
  ApplicationCommandOptionType,
  type AutocompleteInteraction,
  type CommandInteraction,
  MessageFlags,
} from "discord.js";
import { Discord, Guard, Guild, Slash, SlashGroup, SlashOption } from "discordx";
import { Category } from "@discordx/utilities";
import { listArchives } from "../archivist/archives.js";
import { getTimeZone, resetTimeZone, setTimeZone } from "../archivist/preferences.js";
import { config } from "../config.js";
import { actorOf, archivist, MAX_SUGGESTIONS, runArchivist } from "../lib/archivist.js";
import { GUILD_ONLY } from "../lib/categories.js";
import { Cooldown } from "../lib/cooldown.js";
import { baseEmbed } from "../lib/embeds.js";

/**
 * Contributor commands for the archives a member is whitelisted for. The
 * module loads only when ARCHIVIST_GUILD_IDS lists a server, and its commands
 * register only there.
 */

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

async function suggestTimeZones(interaction: AutocompleteInteraction): Promise<void> {
  const typed = interaction.options.getFocused().toLowerCase();
  const zones = Intl.supportedValuesOf("timeZone")
    .filter((zone) => zone.toLowerCase().includes(typed))
    .slice(0, MAX_SUGGESTIONS);
  await interaction.respond(zones.map((zone) => ({ name: zone, value: zone })));
}

@Discord()
@Category("Archivist")
@Guild(...config.archivistGuildIds)
@SlashGroup({ name: "archivist", description: "Archive this community's history" })
@SlashGroup({ name: "archive", description: "Archives you can use", root: "archivist" })
@SlashGroup({ name: "timezone", description: "Your timezone for typed dates", root: "archivist" })
export class Archivist {
  @Slash({ name: "list", description: "List the archives you can use", ...GUILD_ONLY })
  @SlashGroup("archive", "archivist")
  @Guard(Cooldown(3))
  async archiveList(interaction: CommandInteraction): Promise<void> {
    await runArchivist(interaction, async () => {
      const archives = listArchives(archivist(), await actorOf(interaction));
      await interaction.reply({
        ...ephemeral,
        embeds: [
          baseEmbed(interaction)
            .setTitle("🗄️ Your archives")
            .setDescription(
              archives.map((archive) => `**${archive.name}**`).join("\n") ||
                "You are not on any archive's whitelist yet. Ask the bot owner to add you.",
            ),
        ],
      });
    });
  }

  @Slash({
    name: "set",
    description: "Set the timezone your typed dates are read in",
    ...GUILD_ONLY,
  })
  @SlashGroup("timezone", "archivist")
  @Guard(Cooldown(3))
  async timezoneSet(
    @SlashOption({
      name: "timezone",
      description: "Such as America/Toronto or Europe/London",
      type: ApplicationCommandOptionType.String,
      required: true,
      autocomplete: suggestTimeZones,
    })
    timezone: string,
    interaction: CommandInteraction,
  ): Promise<void> {
    await runArchivist(interaction, async () => {
      const saved = setTimeZone(archivist(), await actorOf(interaction), timezone);
      await interaction.reply({
        ...ephemeral,
        content: `Dates and times you type without a zone are now read in **${saved}**. Dates you already saved keep their meaning.`,
      });
    });
  }

  @Slash({
    name: "show",
    description: "Show the timezone your typed dates are read in",
    ...GUILD_ONLY,
  })
  @SlashGroup("timezone", "archivist")
  @Guard(Cooldown(3))
  async timezoneShow(interaction: CommandInteraction): Promise<void> {
    await runArchivist(interaction, async () => {
      const timezone = getTimeZone(archivist(), await actorOf(interaction));
      await interaction.reply({
        ...ephemeral,
        content: timezone
          ? `Your typed dates are read in **${timezone}**.`
          : "You have no timezone set, so typed dates are read in each archive's timezone.",
      });
    });
  }

  @Slash({
    name: "reset",
    description: "Use each archive's timezone for your typed dates",
    ...GUILD_ONLY,
  })
  @SlashGroup("timezone", "archivist")
  @Guard(Cooldown(3))
  async timezoneReset(interaction: CommandInteraction): Promise<void> {
    await runArchivist(interaction, async () => {
      resetTimeZone(archivist(), await actorOf(interaction));
      await interaction.reply({
        ...ephemeral,
        content: "Your timezone is cleared. Typed dates are now read in each archive's timezone.",
      });
    });
  }
}
