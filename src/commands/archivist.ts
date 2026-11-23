import {
  ApplicationCommandOptionType,
  type Attachment,
  type AutocompleteInteraction,
  type ButtonInteraction,
  ChannelType,
  type CommandInteraction,
  type GuildBasedChannel,
  MessageFlags,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  ButtonComponent,
  Discord,
  Guard,
  Guild,
  ModalComponent,
  SelectMenuComponent,
  Slash,
  SlashChoice,
  SlashGroup,
  SlashOption,
} from "discordx";
import { Category } from "@discordx/utilities";
import { requireArchiveAccess } from "../archivist/access.js";
import { removeAnnouncementChannel, setAnnouncementChannel } from "../archivist/announcements.js";
import { listArchives } from "../archivist/archives.js";
import { openStore } from "../archivist/context.js";
import { ArchivistError } from "../archivist/errors.js";
import { suggestPeople } from "../archivist/people.js";
import {
  getTimeZone,
  resetTimeZone,
  resolveArchiveSelection,
  setTimeZone,
} from "../archivist/preferences.js";
import { config } from "../config.js";
import {
  actorOf,
  archivist,
  MAX_SUGGESTIONS,
  runArchivist,
  suggestArchives,
} from "../lib/archivist.js";
import {
  applyReview,
  askDelete,
  cancelReview,
  cancelZone,
  confirmDelete,
  confirmZone,
  openAddPeople,
  openEdit,
  selectDifferences,
  startIntake,
  submitAddPeople,
  submitEdit,
} from "../lib/archivist-intake.js";
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

const archiveOption = {
  name: "archive",
  description: "Leave empty to use the archive you used last",
  type: ApplicationCommandOptionType.String,
  required: false,
  autocomplete: suggestArchives,
} as const;

/**
 * The archive an autocomplete request is about: the one typed in the
 * command's archive field, or the person's remembered one. Suggestions never
 * change the remembered archive.
 */
async function suggestionArchive(interaction: AutocompleteInteraction): Promise<string | null> {
  const actor = await actorOf(interaction);
  const typed = interaction.options.getString("archive");
  try {
    return typed
      ? requireArchiveAccess(archivist(), actor, typed).archiveId
      : resolveArchiveSelection(archivist(), actor, undefined).archiveId;
  } catch {
    return null;
  }
}

async function suggestPeopleNames(interaction: AutocompleteInteraction): Promise<void> {
  const archiveId = await suggestionArchive(interaction);
  if (!archiveId) {
    await interaction.respond([]);
    return;
  }
  const db = openStore(archivist(), archiveId).db;
  await interaction.respond(suggestPeople(db, interaction.options.getFocused()));
}

/** Requires a server text channel the bot can post embeds and files in and the person can see. */
function checkLogsChannel(interaction: CommandInteraction, channel: GuildBasedChannel | null) {
  if (!channel || !channel.isTextBased() || channel.isThread() || channel.isVoiceBased()) {
    throw new ArchivistError("invalid_input", "Choose a server text channel.", {
      field: "channel",
    });
  }
  const me = channel.guild.members.me;
  const needed = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
  ];
  if (!me || !channel.permissionsFor(me).has(needed)) {
    throw new ArchivistError(
      "invalid_input",
      "The bot needs permission to view that channel and send messages, embeds, and files in it.",
      { field: "channel" },
    );
  }
  if (!channel.permissionsFor(interaction.user)?.has(PermissionFlagsBits.ViewChannel)) {
    throw new ArchivistError("invalid_input", "You can only choose a channel you can see.", {
      field: "channel",
    });
  }
  return channel;
}

@Discord()
@Category("Archivist")
@Guild(...config.archivistGuildIds)
@SlashGroup({ name: "archivist", description: "Archive this community's history" })
@SlashGroup({ name: "archive", description: "Archives you can use", root: "archivist" })
@SlashGroup({ name: "timezone", description: "Your timezone for typed dates", root: "archivist" })
@SlashGroup({ name: "artifact", description: "Add and manage artifacts", root: "archivist" })
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

  @Slash({ name: "add", description: "Archive one file or Google Drive link", ...GUILD_ONLY })
  @SlashGroup("artifact", "archivist")
  @Guard(Cooldown(3))
  async artifactAdd(
    @SlashOption({
      name: "description",
      description: "What it shows and why it matters",
      type: ApplicationCommandOptionType.String,
      required: true,
      maxLength: 6000,
    })
    description: string,
    @SlashOption(archiveOption) archive: string | undefined,
    @SlashOption({
      name: "file",
      description: "A JPEG, PNG, WebP, GIF, or MP4 up to 100 MiB",
      type: ApplicationCommandOptionType.Attachment,
      required: false,
    })
    file: Attachment | undefined,
    @SlashOption({
      name: "drive_link",
      description: "Instead of a file, a link to one public Google Drive file",
      type: ApplicationCommandOptionType.String,
      required: false,
      maxLength: 2000,
    })
    driveLink: string | undefined,
    @SlashOption({
      name: "people",
      description: "Names separated by commas, such as Sam, Lee",
      type: ApplicationCommandOptionType.String,
      required: false,
      autocomplete: suggestPeopleNames,
    })
    people: string | undefined,
    @SlashOption({
      name: "exact_date",
      description: "When it happened, such as 2019-07-15 or 2019-07-15 18:30",
      type: ApplicationCommandOptionType.String,
      required: false,
      maxLength: 100,
    })
    exactDate: string | undefined,
    @SlashOption({
      name: "exact_basis",
      description: "How you know the exact date, such as a message timestamp",
      type: ApplicationCommandOptionType.String,
      required: false,
      maxLength: 1000,
    })
    exactBasis: string | undefined,
    @SlashOption({
      name: "estimated_day",
      description: "Your best guess at the day, such as 2019-07-01",
      type: ApplicationCommandOptionType.String,
      required: false,
      maxLength: 10,
    })
    estimatedDay: string | undefined,
    @SlashOption({
      name: "estimate_reason",
      description: "Why you think it was that day",
      type: ApplicationCommandOptionType.String,
      required: false,
      maxLength: 1000,
    })
    estimateReason: string | undefined,
    @SlashChoice(
      { name: "Not reviewed", value: "unreviewed" },
      { name: "Some people unidentified", value: "incomplete" },
      { name: "Everyone identified", value: "complete" },
    )
    @SlashOption({
      name: "identification",
      description: "Whether everyone in it has been identified",
      type: ApplicationCommandOptionType.String,
      required: false,
    })
    identification: string | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    await runArchivist(interaction, () =>
      startIntake(interaction, {
        archive,
        description,
        file,
        driveLink,
        people,
        exactDate,
        exactBasis,
        estimatedDay,
        estimateReason,
        identification,
      }),
    );
  }

  @ButtonComponent({ id: /^ax:zsave:/ })
  async zoneSave(interaction: ButtonInteraction): Promise<void> {
    await runArchivist(interaction, () => confirmZone(interaction));
  }

  @ButtonComponent({ id: /^ax:zcancel:/ })
  async zoneCancel(interaction: ButtonInteraction): Promise<void> {
    await runArchivist(interaction, () => cancelZone(interaction));
  }

  @SelectMenuComponent({ id: /^ax:dsel:/ })
  async reviewSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    await runArchivist(interaction, () => selectDifferences(interaction));
  }

  @ButtonComponent({ id: /^ax:dapply:/ })
  async reviewApply(interaction: ButtonInteraction): Promise<void> {
    await runArchivist(interaction, () => applyReview(interaction));
  }

  @ButtonComponent({ id: /^ax:dcancel:/ })
  async reviewCancel(interaction: ButtonInteraction): Promise<void> {
    await runArchivist(interaction, () => cancelReview(interaction));
  }

  @ButtonComponent({ id: /^ax:edit:/ })
  async editOpen(interaction: ButtonInteraction): Promise<void> {
    await runArchivist(interaction, () => openEdit(interaction));
  }

  @ModalComponent({ id: /^ax:editm:/ })
  async editSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    await runArchivist(interaction, () => submitEdit(interaction));
  }

  @ButtonComponent({ id: /^ax:people:/ })
  async peopleOpen(interaction: ButtonInteraction): Promise<void> {
    await runArchivist(interaction, () => openAddPeople(interaction));
  }

  @ModalComponent({ id: /^ax:peoplem:/ })
  async peopleSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    await runArchivist(interaction, () => submitAddPeople(interaction));
  }

  @ButtonComponent({ id: /^ax:delete:/ })
  async deleteAsk(interaction: ButtonInteraction): Promise<void> {
    await runArchivist(interaction, () => askDelete(interaction));
  }

  @ButtonComponent({ id: /^ax:deletec:/ })
  async deleteConfirm(interaction: ButtonInteraction): Promise<void> {
    await runArchivist(interaction, () => confirmDelete(interaction));
  }

  @Slash({
    name: "set-artifact-logs-channel",
    description: "Announce every new artifact in an archive in a channel",
    ...GUILD_ONLY,
  })
  @Guard(Cooldown(3))
  async setLogsChannel(
    @SlashOption(archiveOption) archive: string | undefined,
    @SlashOption({
      name: "channel",
      description: "Leave empty to use this channel",
      type: ApplicationCommandOptionType.Channel,
      channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
      required: false,
    })
    channel: GuildBasedChannel | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    await runArchivist(interaction, async () => {
      const actor = await actorOf(interaction);
      const selected = resolveArchiveSelection(archivist(), actor, archive);
      const target = checkLogsChannel(
        interaction,
        channel ??
          (interaction.channel?.isDMBased()
            ? null
            : (interaction.channel as GuildBasedChannel | null)),
      );
      setAnnouncementChannel(archivist(), actor, {
        archiveId: selected.archiveId,
        guildId: target.guild.id,
        channelId: target.id,
      });
      await interaction.reply({
        ...ephemeral,
        content: `New artifacts in **${selected.name}** will be announced in ${target}, for everyone's uploads. Earlier posts are unchanged.`,
      });
    });
  }

  @Slash({
    name: "remove-artifact-logs-channel",
    description: "Stop announcing new artifacts in an archive",
    ...GUILD_ONLY,
  })
  @Guard(Cooldown(3))
  async removeLogsChannel(
    @SlashOption(archiveOption) archive: string | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    await runArchivist(interaction, async () => {
      const actor = await actorOf(interaction);
      const selected = resolveArchiveSelection(archivist(), actor, archive);
      const { removed } = removeAnnouncementChannel(archivist(), actor, {
        archiveId: selected.archiveId,
      });
      await interaction.reply({
        ...ephemeral,
        content: removed
          ? `New artifacts in **${selected.name}** will no longer be announced. Earlier posts stay where they are.`
          : `**${selected.name}** had no announcement channel.`,
      });
    });
  }
}
