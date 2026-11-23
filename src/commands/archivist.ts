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
import { getArtifact } from "../archivist/artifacts.js";
import { getEntity } from "../archivist/entities.js";
import { getEvent } from "../archivist/events.js";
import { getRequest } from "../archivist/requests.js";
import { openStore } from "../archivist/context.js";
import { ArchivistError } from "../archivist/errors.js";
import { suggestCharacters } from "../archivist/lookup.js";
import {
  getDateOrder,
  getTimeZone,
  resetPreferences,
  resolveArchiveSelection,
  setDateOrder,
  setTimeZone,
} from "../archivist/preferences.js";
import type { DateOrder } from "../archivist/dates.js";
import { config } from "../config.js";
import {
  actorOf,
  archivist,
  MAX_SUGGESTIONS,
  runArchivist,
  suggestArchives,
} from "../lib/archivist.js";
import {
  askDeleteEntity,
  confirmDeleteEntity,
  createEntityFromCommand,
  showEntity,
  suggestArtifactIds,
  suggestEntityIds,
  openEntityEdit,
  showEntityForm,
  submitEntityForm,
} from "../lib/archivist-entities.js";
import {
  askDeleteEvent,
  askDeleteEventButton,
  confirmDeleteEvent,
  createEventFromCommand,
  createRequestFromCommand,
  openEventEdit,
  openRequestEdit,
  showEventCommand,
  showEventForm,
  showRequestCommand,
  showRequestForm,
  submitEventForm,
  submitRequestForm,
  suggestEventIds,
  suggestRequestIds,
} from "../lib/archivist-research.js";
import {
  applyReview,
  artifactReply,
  askDelete,
  askDeleteFor,
  cancelReview,
  cancelZone,
  confirmDelete,
  confirmZone,
  openAddLinks,
  openEdit,
  selectDifferences,
  showEditForm,
  startIntake,
  submitAddLinks,
  submitEdit,
  toggleUnidentified,
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

const DATE_ORDER_NAMES: Record<DateOrder, string> = {
  ymd: "year, month, day",
  mdy: "month, day, year",
  dmy: "day, month, year",
};

const archiveOption = {
  name: "archive",
  description: "Leave empty to use the archive you used last",
  type: ApplicationCommandOptionType.String,
  required: false,
  autocomplete: suggestArchives,
} as const;

/**
 * The archive an autocomplete request is about: the one typed in the
 * command's archive field, or the contributor's remembered one. Suggestions never
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

async function suggestCharacterNames(interaction: AutocompleteInteraction): Promise<void> {
  const archiveId = await suggestionArchive(interaction);
  if (!archiveId) {
    await interaction.respond([]);
    return;
  }
  const db = openStore(archivist(), archiveId).db;
  await interaction.respond(suggestCharacters(db, interaction.options.getFocused()));
}

const KIND_CHOICES = [
  { name: "Character", value: "character" },
  { name: "Account", value: "account" },
  { name: "Server", value: "server" },
  { name: "Channel or group chat", value: "channel" },
];

const kindOption = {
  name: "kind",
  description: "What kind of record",
  type: ApplicationCommandOptionType.String,
  required: true,
} as const;

const entityIdOption = {
  name: "id",
  description: "Start typing a name, or give its ID",
  type: ApplicationCommandOptionType.String,
  required: true,
  autocomplete: suggestEntityIds,
} as const;

const artifactIdOption = {
  name: "id",
  description: "Start typing its description, or give its ID",
  type: ApplicationCommandOptionType.String,
  required: true,
  autocomplete: suggestArtifactIds,
} as const;

const eventIdOption = {
  name: "id",
  description: "Start typing its title, or give its ID",
  type: ApplicationCommandOptionType.String,
  required: true,
  autocomplete: suggestEventIds,
} as const;

const requestIdOption = {
  name: "id",
  description: "Start typing what is missing, or give its ID",
  type: ApplicationCommandOptionType.String,
  required: true,
  autocomplete: suggestRequestIds,
} as const;

const EVENT_KIND_CHOICES = [
  { name: "One day", value: "single" },
  { name: "Lasted across a range", value: "duration" },
  { name: "Happened sometime within a range", value: "occurrence_window" },
];

const CERTAINTY_CHOICES = [
  { name: "Exact", value: "exact" },
  { name: "Estimated", value: "estimated" },
];

const WHEN_CHOICES = [
  { name: "Around a day", value: "approximate_day" },
  { name: "Between two days", value: "date_range" },
  { name: "Before a day", value: "before_date" },
  { name: "Before an event", value: "before_event" },
  { name: "After an event", value: "after_event" },
];

/** Finds an artifact for a command, by full or short ID, in the chosen or remembered archive. */
async function commandArtifact(
  interaction: CommandInteraction,
  archive: string | undefined,
  id: string,
) {
  const actor = await actorOf(interaction);
  const selected = resolveArchiveSelection(archivist(), actor, archive);
  return {
    archiveId: selected.archiveId,
    artifact: getArtifact(archivist(), actor, { archiveId: selected.archiveId, id }),
  };
}

/** Requires a server text channel the bot can post embeds and files in and the contributor can see. */
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

/**
 * Builds the contributor commands under a root name. The owner asked on
 * 2026-11-23 for `/a` as a short alias of `/archivist`, so the same commands
 * are registered under both. Only `/archivist` has a /help category, so /help
 * lists each command once. Buttons, forms, and the logs-channel commands are
 * registered once, in `ArchivistComponents`.
 */
function contributorCommands(
  root: Lowercase<string>,
  description: string,
  category: ReturnType<typeof Category>,
) {
  @Discord()
  @category
  @Guild(...config.archivistGuildIds)
  @SlashGroup({ name: root, description })
  @SlashGroup({ name: "archive", description: "Archives you can use", root })
  @SlashGroup({
    name: "preferences",
    description: "How your typed dates and times are read",
    root,
  })
  @SlashGroup({ name: "artifact", description: "Add and manage artifacts", root })
  @SlashGroup({ name: "entity", description: "Characters, accounts, servers, and channels", root })
  @SlashGroup({ name: "event", description: "Things that happened", root })
  @SlashGroup({ name: "request", description: "Media the archive is missing", root })
  class ArchivistCommands {
    @Slash({ name: "list", description: "List the archives you can use", ...GUILD_ONLY })
    @SlashGroup("archive", root)
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
      name: "show",
      description: "Show how your typed dates are read",
      ...GUILD_ONLY,
    })
    @SlashGroup("preferences", root)
    @Guard(Cooldown(3))
    async preferencesShow(interaction: CommandInteraction): Promise<void> {
      await runArchivist(interaction, async () => {
        const actor = await actorOf(interaction);
        const timezone = getTimeZone(archivist(), actor);
        const order = getDateOrder(archivist(), actor);
        await interaction.reply({
          ...ephemeral,
          content: [
            timezone
              ? `Times you type without a zone are read in **${timezone}**.`
              : "You have no timezone set, so times you type without a zone are read in each archive's timezone.",
            `All-number dates are read as **${DATE_ORDER_NAMES[order]}**. Dates with a month name, such as Jul 15 2019, always work.`,
          ].join("\n"),
        });
      });
    }

    @Slash({
      name: "timezone",
      description: "Set the timezone your typed times are read in",
      ...GUILD_ONLY,
    })
    @SlashGroup("preferences", root)
    @Guard(Cooldown(3))
    async preferencesTimezone(
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
          content: `Times you type without a zone are now read in **${saved}**. Dates you already saved keep their meaning.`,
        });
      });
    }

    @Slash({
      name: "date-order",
      description: "Set how your all-number dates, such as 03/04/2019, are read",
      ...GUILD_ONLY,
    })
    @SlashGroup("preferences", root)
    @Guard(Cooldown(3))
    async preferencesDateOrder(
      @SlashChoice(
        { name: "Year, month, day (2019-07-15)", value: "ymd" },
        { name: "Month, day, year (07/15/2019)", value: "mdy" },
        { name: "Day, month, year (15/07/2019)", value: "dmy" },
      )
      @SlashOption({
        name: "order",
        description: "The order you write numbers in a date",
        type: ApplicationCommandOptionType.String,
        required: true,
      })
      order: string,
      interaction: CommandInteraction,
    ): Promise<void> {
      await runArchivist(interaction, async () => {
        const saved = setDateOrder(archivist(), await actorOf(interaction), order);
        await interaction.reply({
          ...ephemeral,
          content: `All-number dates you type are now read as **${DATE_ORDER_NAMES[saved]}**. Dates you already saved keep their meaning.`,
        });
      });
    }

    @Slash({
      name: "reset",
      description: "Go back to each archive's timezone and year-month-day dates",
      ...GUILD_ONLY,
    })
    @SlashGroup("preferences", root)
    @Guard(Cooldown(3))
    async preferencesReset(interaction: CommandInteraction): Promise<void> {
      await runArchivist(interaction, async () => {
        resetPreferences(archivist(), await actorOf(interaction));
        await interaction.reply({
          ...ephemeral,
          content:
            "Your preferences are cleared. Times are read in each archive's timezone, and all-number dates as year, month, day.",
        });
      });
    }

    @Slash({ name: "add", description: "Archive one file or Google Drive link", ...GUILD_ONLY })
    @SlashGroup("artifact", root)
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
      @SlashOption({
        name: "file",
        description: "An image, video, or audio file up to 100 MiB",
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
        name: "characters",
        description: "Names separated by commas, such as Sam, Lee",
        type: ApplicationCommandOptionType.String,
        required: false,
        autocomplete: suggestCharacterNames,
      })
      characters: string | undefined,
      @SlashOption({
        name: "exact_date",
        description: "When it happened, such as 2019-07-15 or Jul 15 2019 6:30pm",
        type: ApplicationCommandOptionType.String,
        required: false,
        maxLength: 100,
      })
      exactDate: string | undefined,
      @SlashOption({
        name: "estimated_day",
        description: "Your best guess at the day, such as Jul 1 2019",
        type: ApplicationCommandOptionType.String,
        required: false,
        maxLength: 100,
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
      @SlashOption({
        name: "event",
        description: "An event this shows. Add more from the reply",
        type: ApplicationCommandOptionType.String,
        required: false,
        autocomplete: suggestEventIds,
      })
      event: string | undefined,
      @SlashOption(archiveOption) archive: string | undefined,
      interaction: CommandInteraction,
    ): Promise<void> {
      await runArchivist(interaction, () =>
        startIntake(interaction, {
          event,
          archive,
          description,
          file,
          driveLink,
          characters,
          exactDate,
          estimatedDay,
          estimateReason,
        }),
      );
    }

    @Slash({ name: "show", description: "Show an artifact", ...GUILD_ONLY })
    @SlashGroup("artifact", root)
    @Guard(Cooldown(3))
    async artifactShow(
      @SlashOption(artifactIdOption) id: string,
      @SlashOption(archiveOption) archive: string | undefined,
      interaction: CommandInteraction,
    ): Promise<void> {
      await runArchivist(interaction, async () => {
        await interaction.deferReply(ephemeral);
        const { archiveId, artifact } = await commandArtifact(interaction, archive, id);
        await interaction.editReply(
          artifactReply(
            archivist(),
            archiveId,
            artifact,
            `Artifact \`${artifact.id.slice(0, 8)}\``,
          ),
        );
      });
    }

    @Slash({ name: "edit", description: "Edit an artifact's description and dates", ...GUILD_ONLY })
    @SlashGroup("artifact", root)
    @Guard(Cooldown(3))
    async artifactEdit(
      @SlashOption(artifactIdOption) id: string,
      @SlashOption(archiveOption) archive: string | undefined,
      interaction: CommandInteraction,
    ): Promise<void> {
      await runArchivist(interaction, async () => {
        const { archiveId, artifact } = await commandArtifact(interaction, archive, id);
        await showEditForm(interaction, archiveId, artifact.id, artifact.version);
      });
    }

    @Slash({ name: "delete", description: "Permanently delete an artifact", ...GUILD_ONLY })
    @SlashGroup("artifact", root)
    @Guard(Cooldown(3))
    async artifactDelete(
      @SlashOption(artifactIdOption) id: string,
      @SlashOption(archiveOption) archive: string | undefined,
      interaction: CommandInteraction,
    ): Promise<void> {
      await runArchivist(interaction, async () => {
        const { archiveId, artifact } = await commandArtifact(interaction, archive, id);
        await askDeleteFor(interaction, archiveId, artifact.id, artifact.version);
      });
    }

    @Slash({
      name: "create",
      description: "Add a character, account, server, or channel",
      ...GUILD_ONLY,
    })
    @SlashGroup("entity", root)
    @Guard(Cooldown(3))
    async entityCreate(
      @SlashChoice(...KIND_CHOICES)
      @SlashOption(kindOption)
      kind: string,
      @SlashOption({
        name: "name",
        description: "Known name for a character, or the name of an account, server, or channel",
        type: ApplicationCommandOptionType.String,
        required: true,
        maxLength: 100,
      })
      name: string,
      @SlashOption({
        name: "discord_id",
        description: "Discord ID of the account, server, or channel, if known",
        type: ApplicationCommandOptionType.String,
        required: false,
        maxLength: 20,
      })
      discordId: string | undefined,
      @SlashOption({
        name: "real_name",
        description: "Character only: their real name",
        type: ApplicationCommandOptionType.String,
        required: false,
        maxLength: 100,
      })
      realName: string | undefined,
      @SlashOption({
        name: "birth_day",
        description: "Character only: birth date, such as Nov 24 2000",
        type: ApplicationCommandOptionType.String,
        required: false,
        maxLength: 100,
      })
      birthDay: string | undefined,
      @SlashChoice(
        { name: "Unknown", value: "unknown" },
        { name: "Yes", value: "yes" },
        { name: "No", value: "no" },
      )
      @SlashOption({
        name: "met_in_person",
        description: "Character only: whether you know them in person",
        type: ApplicationCommandOptionType.String,
        required: false,
      })
      metInPerson: string | undefined,
      @SlashChoice(
        { name: "Server channel", value: "guild_channel" },
        { name: "Thread", value: "thread" },
        { name: "Group chat", value: "group_chat" },
        { name: "Direct messages", value: "direct_message" },
      )
      @SlashOption({
        name: "channel_kind",
        description: "Channel only: what kind of channel",
        type: ApplicationCommandOptionType.String,
        required: false,
      })
      channelKind: string | undefined,
      @SlashOption({
        name: "server",
        description: "Channel only: the server it belongs to",
        type: ApplicationCommandOptionType.String,
        required: false,
        autocomplete: suggestEntityIds,
      })
      server: string | undefined,
      @SlashOption({
        name: "parent_channel",
        description: "Thread only: the channel it belongs to",
        type: ApplicationCommandOptionType.String,
        required: false,
        autocomplete: suggestEntityIds,
      })
      parentChannel: string | undefined,
      @SlashChoice({ name: "Human", value: "human" }, { name: "Bot", value: "bot" })
      @SlashOption({
        name: "account_kind",
        description: "Account only: a human's account or a bot",
        type: ApplicationCommandOptionType.String,
        required: false,
      })
      accountKind: string | undefined,
      @SlashOption({
        name: "character",
        description: "Account only: whose account it is",
        type: ApplicationCommandOptionType.String,
        required: false,
        autocomplete: suggestEntityIds,
      })
      character: string | undefined,
      @SlashOption(archiveOption) archive: string | undefined,
      interaction: CommandInteraction,
    ): Promise<void> {
      await runArchivist(interaction, () =>
        createEntityFromCommand(interaction, {
          archive,
          kind,
          name,
          discordId,
          realName,
          birthDay,
          metInPerson,
          server,
          channelKind,
          parentChannel,
          character,
          accountKind,
        }),
      );
    }

    @Slash({
      name: "show",
      description: "Show a character, account, server, or channel",
      ...GUILD_ONLY,
    })
    @SlashGroup("entity", root)
    @Guard(Cooldown(3))
    async entityShow(
      @SlashChoice(...KIND_CHOICES)
      @SlashOption(kindOption)
      kind: string,
      @SlashOption(entityIdOption) id: string,
      @SlashOption(archiveOption) archive: string | undefined,
      interaction: CommandInteraction,
    ): Promise<void> {
      await runArchivist(interaction, () => showEntity(interaction, { archive, kind, id }));
    }

    @Slash({
      name: "delete",
      description: "Permanently delete a character, account, server, or channel",
      ...GUILD_ONLY,
    })
    @SlashGroup("entity", root)
    @Guard(Cooldown(3))
    async entityDelete(
      @SlashChoice(...KIND_CHOICES)
      @SlashOption(kindOption)
      kind: string,
      @SlashOption(entityIdOption) id: string,
      @SlashOption(archiveOption) archive: string | undefined,
      interaction: CommandInteraction,
    ): Promise<void> {
      await runArchivist(interaction, () => askDeleteEntity(interaction, { archive, kind, id }));
    }

    @Slash({
      name: "edit",
      description: "Edit a character, account, server, or channel",
      ...GUILD_ONLY,
    })
    @SlashGroup("entity", root)
    @Guard(Cooldown(3))
    async entityEdit(
      @SlashChoice(...KIND_CHOICES)
      @SlashOption(kindOption)
      kind: string,
      @SlashOption(entityIdOption) id: string,
      @SlashOption(archiveOption) archive: string | undefined,
      interaction: CommandInteraction,
    ): Promise<void> {
      await runArchivist(interaction, async () => {
        const actor = await actorOf(interaction);
        const selected = resolveArchiveSelection(archivist(), actor, archive);
        const entity = getEntity(archivist(), actor, { archiveId: selected.archiveId, kind, id });
        await showEntityForm(
          interaction,
          selected.archiveId,
          entity.kind,
          entity.id,
          entity.version,
        );
      });
    }

    @Slash({ name: "create", description: "Record something that happened", ...GUILD_ONLY })
    @SlashGroup("event", root)
    @Guard(Cooldown(3))
    async eventCreate(
      @SlashOption({
        name: "title",
        description: "A short name, such as Summer season",
        type: ApplicationCommandOptionType.String,
        required: true,
        maxLength: 200,
      })
      title: string,
      @SlashOption({
        name: "description",
        description: "What happened",
        type: ApplicationCommandOptionType.String,
        required: true,
        maxLength: 6000,
      })
      description: string,
      @SlashChoice(...EVENT_KIND_CHOICES)
      @SlashOption({
        name: "kind",
        description: "One day, a range it lasted, or a range it happened sometime in",
        type: ApplicationCommandOptionType.String,
        required: true,
      })
      kind: string,
      @SlashOption({
        name: "start",
        description: "The day, or the start of the range, such as Jun 1 2020",
        type: ApplicationCommandOptionType.String,
        required: true,
        maxLength: 100,
      })
      start: string,
      @SlashOption({
        name: "end",
        description: "The end of the range, for ranges only",
        type: ApplicationCommandOptionType.String,
        required: false,
        maxLength: 100,
      })
      end: string | undefined,
      @SlashChoice(...CERTAINTY_CHOICES)
      @SlashOption({
        name: "certainty",
        description: "Exact unless you are estimating. No explanation is needed",
        type: ApplicationCommandOptionType.String,
        required: false,
      })
      certainty: string | undefined,
      @SlashOption({
        name: "characters",
        description: "Names separated by commas",
        type: ApplicationCommandOptionType.String,
        required: false,
        autocomplete: suggestCharacterNames,
      })
      characters: string | undefined,
      @SlashOption({
        name: "server",
        description: "The server it happened in",
        type: ApplicationCommandOptionType.String,
        required: false,
        autocomplete: suggestEntityIds,
      })
      server: string | undefined,
      @SlashOption({
        name: "channel",
        description: "The channel or group chat it happened in",
        type: ApplicationCommandOptionType.String,
        required: false,
        autocomplete: suggestEntityIds,
      })
      channel: string | undefined,
      @SlashOption({
        name: "color",
        description: "Strip color such as #eb459e. Picked for you if empty",
        type: ApplicationCommandOptionType.String,
        required: false,
        maxLength: 7,
      })
      color: string | undefined,
      @SlashOption(archiveOption) archive: string | undefined,
      interaction: CommandInteraction,
    ): Promise<void> {
      await runArchivist(interaction, () =>
        createEventFromCommand(interaction, {
          archive,
          title,
          description,
          kind,
          certainty,
          start,
          end,
          characters,
          server,
          channel,
          color,
        }),
      );
    }

    @Slash({ name: "show", description: "Show an event", ...GUILD_ONLY })
    @SlashGroup("event", root)
    @Guard(Cooldown(3))
    async eventShow(
      @SlashOption(eventIdOption) id: string,
      @SlashOption(archiveOption) archive: string | undefined,
      interaction: CommandInteraction,
    ): Promise<void> {
      await runArchivist(interaction, () => showEventCommand(interaction, { archive, id }));
    }

    @Slash({
      name: "edit",
      description: "Edit an event's title, description, and dates",
      ...GUILD_ONLY,
    })
    @SlashGroup("event", root)
    @Guard(Cooldown(3))
    async eventEdit(
      @SlashOption(eventIdOption) id: string,
      @SlashChoice(...EVENT_KIND_CHOICES)
      @SlashOption({
        name: "kind",
        description: "Change the kind of date. Leave empty to keep it",
        type: ApplicationCommandOptionType.String,
        required: false,
      })
      kind: string | undefined,
      @SlashChoice(...CERTAINTY_CHOICES)
      @SlashOption({
        name: "certainty",
        description: "Change between exact and estimated. Leave empty to keep it",
        type: ApplicationCommandOptionType.String,
        required: false,
      })
      certainty: string | undefined,
      @SlashOption(archiveOption) archive: string | undefined,
      interaction: CommandInteraction,
    ): Promise<void> {
      await runArchivist(interaction, async () => {
        const actor = await actorOf(interaction);
        const selected = resolveArchiveSelection(archivist(), actor, archive);
        const event = getEvent(archivist(), actor, { archiveId: selected.archiveId, id });
        await showEventForm(
          interaction,
          selected.archiveId,
          event.id,
          event.version,
          kind,
          certainty,
        );
      });
    }

    @Slash({ name: "delete", description: "Permanently delete an event", ...GUILD_ONLY })
    @SlashGroup("event", root)
    @Guard(Cooldown(3))
    async eventDelete(
      @SlashOption(eventIdOption) id: string,
      @SlashOption(archiveOption) archive: string | undefined,
      interaction: CommandInteraction,
    ): Promise<void> {
      await runArchivist(interaction, async () => {
        const actor = await actorOf(interaction);
        const selected = resolveArchiveSelection(archivist(), actor, archive);
        const event = getEvent(archivist(), actor, { archiveId: selected.archiveId, id });
        await askDeleteEvent(interaction, selected.archiveId, event.id, event.version);
      });
    }

    @Slash({
      name: "create",
      description: "Add media the archive is missing to the board",
      ...GUILD_ONLY,
    })
    @SlashGroup("request", root)
    @Guard(Cooldown(3))
    async requestCreate(
      @SlashOption({
        name: "description",
        description: "What is missing, such as Photos from the first meetup",
        type: ApplicationCommandOptionType.String,
        required: true,
        maxLength: 6000,
      })
      description: string,
      @SlashOption({
        name: "characters",
        description: "Who it involves, separated by commas",
        type: ApplicationCommandOptionType.String,
        required: true,
        autocomplete: suggestCharacterNames,
      })
      characters: string,
      @SlashChoice(...WHEN_CHOICES)
      @SlashOption({
        name: "when",
        description: "When it is from",
        type: ApplicationCommandOptionType.String,
        required: true,
      })
      when: string,
      @SlashOption({
        name: "day",
        description: "For around a day or before a day",
        type: ApplicationCommandOptionType.String,
        required: false,
        maxLength: 100,
      })
      day: string | undefined,
      @SlashOption({
        name: "start",
        description: "For between two days: the first day",
        type: ApplicationCommandOptionType.String,
        required: false,
        maxLength: 100,
      })
      start: string | undefined,
      @SlashOption({
        name: "end",
        description: "For between two days: the last day",
        type: ApplicationCommandOptionType.String,
        required: false,
        maxLength: 100,
      })
      end: string | undefined,
      @SlashOption({
        name: "event",
        description: "For before or after an event",
        type: ApplicationCommandOptionType.String,
        required: false,
        autocomplete: suggestEventIds,
      })
      event: string | undefined,
      @SlashOption({
        name: "notes",
        description: "Research notes, such as who might have it",
        type: ApplicationCommandOptionType.String,
        required: false,
        maxLength: 4000,
      })
      notes: string | undefined,
      @SlashOption(archiveOption) archive: string | undefined,
      interaction: CommandInteraction,
    ): Promise<void> {
      await runArchivist(interaction, () =>
        createRequestFromCommand(interaction, {
          archive,
          description,
          characters,
          when,
          day,
          start,
          end,
          event,
          notes,
        }),
      );
    }

    @Slash({ name: "show", description: "Show a missing-media request", ...GUILD_ONLY })
    @SlashGroup("request", root)
    @Guard(Cooldown(3))
    async requestShow(
      @SlashOption(requestIdOption) id: string,
      @SlashOption(archiveOption) archive: string | undefined,
      interaction: CommandInteraction,
    ): Promise<void> {
      await runArchivist(interaction, () => showRequestCommand(interaction, { archive, id }));
    }

    @Slash({ name: "edit", description: "Edit a request's description and notes", ...GUILD_ONLY })
    @SlashGroup("request", root)
    @Guard(Cooldown(3))
    async requestEdit(
      @SlashOption(requestIdOption) id: string,
      @SlashOption(archiveOption) archive: string | undefined,
      interaction: CommandInteraction,
    ): Promise<void> {
      await runArchivist(interaction, async () => {
        const actor = await actorOf(interaction);
        const selected = resolveArchiveSelection(archivist(), actor, archive);
        const request = getRequest(archivist(), actor, { archiveId: selected.archiveId, id });
        await showRequestForm(interaction, selected.archiveId, request.id, request.version);
      });
    }
  }
  return ArchivistCommands;
}

/** Leaves a class out of /help. */
const noCategory: ReturnType<typeof Category> = () => undefined;

export const Archivist = contributorCommands(
  "archivist",
  "Archive this community's history",
  Category("Archivist"),
);
export const ArchivistShort = contributorCommands("a", "Short for /archivist", noCategory);

/** Buttons, forms, and the logs-channel commands, registered once for both command names. */
@Discord()
@Category("Archivist")
@Guild(...config.archivistGuildIds)
export class ArchivistComponents {
  @ButtonComponent({ id: /^ax:eedit:/ })
  async entityEditOpen(interaction: ButtonInteraction): Promise<void> {
    await runArchivist(interaction, () => openEntityEdit(interaction));
  }

  @ModalComponent({ id: /^ax:eform:/ })
  async entityEditSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    await runArchivist(interaction, () => submitEntityForm(interaction));
  }

  @ButtonComponent({ id: /^ax:evedit:/ })
  async eventEditOpen(interaction: ButtonInteraction): Promise<void> {
    await runArchivist(interaction, () => openEventEdit(interaction));
  }

  @ModalComponent({ id: /^ax:evform:/ })
  async eventEditSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    await runArchivist(interaction, () => submitEventForm(interaction));
  }

  @ButtonComponent({ id: /^ax:evdel:/ })
  async eventDeleteAsk(interaction: ButtonInteraction): Promise<void> {
    await runArchivist(interaction, () => askDeleteEventButton(interaction));
  }

  @ButtonComponent({ id: /^ax:evdelc:/ })
  async eventDeleteConfirm(interaction: ButtonInteraction): Promise<void> {
    await runArchivist(interaction, () => confirmDeleteEvent(interaction));
  }

  @ButtonComponent({ id: /^ax:rqedit:/ })
  async requestEditOpen(interaction: ButtonInteraction): Promise<void> {
    await runArchivist(interaction, () => openRequestEdit(interaction));
  }

  @ModalComponent({ id: /^ax:rqform:/ })
  async requestEditSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    await runArchivist(interaction, () => submitRequestForm(interaction));
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

  @ButtonComponent({ id: /^ax:links:/ })
  async linksOpen(interaction: ButtonInteraction): Promise<void> {
    await runArchivist(interaction, () => openAddLinks(interaction));
  }

  @ModalComponent({ id: /^ax:linksm:/ })
  async linksSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    await runArchivist(interaction, () => submitAddLinks(interaction));
  }

  @ButtonComponent({ id: /^ax:unid:/ })
  async unidentifiedToggle(interaction: ButtonInteraction): Promise<void> {
    await runArchivist(interaction, () => toggleUnidentified(interaction));
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
    @SlashOption({
      name: "channel",
      description: "Leave empty to use this channel",
      type: ApplicationCommandOptionType.Channel,
      channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
      required: false,
    })
    channel: GuildBasedChannel | undefined,
    @SlashOption(archiveOption) archive: string | undefined,
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

  @ButtonComponent({ id: /^ax:edel:/ })
  async entityDeleteConfirm(interaction: ButtonInteraction): Promise<void> {
    await runArchivist(interaction, () => confirmDeleteEntity(interaction));
  }
}
