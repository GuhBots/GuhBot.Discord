import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  type AutocompleteInteraction,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type CommandInteraction,
  MessageFlags,
  type User,
} from "discord.js";
import { ButtonComponent, Discord, Guard, Guild, Slash, SlashGroup, SlashOption } from "discordx";
import {
  type ArchiveDetails,
  createArchive,
  getArchive,
  listArchives,
  registerArchive,
  renameArchive,
  unregisterArchive,
  updateArchiveSettings,
} from "../archivist/archives.js";
import { addMember, listMembers, removeMember } from "../archivist/members.js";
import { config } from "../config.js";
import {
  actorOf,
  archivist,
  MAX_SUGGESTIONS,
  runArchivist,
  suggestArchives,
} from "../lib/archivist.js";
import { recall, remember } from "../lib/archivist-pending.js";
import { GUILD_ONLY } from "../lib/categories.js";
import { baseEmbed } from "../lib/embeds.js";
import { IsOwner } from "../lib/owner.js";

/**
 * Owner-only Archivist administration: archives, whitelists, and settings.
 * Registered only in OWNER_GUILD_ID, like the other owner commands.
 */

const MEMBERS_PER_PAGE = 40;
const ephemeral = { flags: MessageFlags.Ephemeral } as const;

const archiveOption = {
  name: "archive",
  description: "The archive",
  type: ApplicationCommandOptionType.String,
  required: true,
  autocomplete: suggestArchives,
} as const;

const versionOption = {
  name: "version",
  description: "The archive version you last saw. Leave empty to change the current version.",
  type: ApplicationCommandOptionType.Integer,
  required: false,
  minValue: 1,
} as const;

/** Timezone names matching what the owner typed. */
async function suggestTimeZones(interaction: AutocompleteInteraction): Promise<void> {
  const typed = interaction.options.getFocused().toLowerCase();
  const zones = Intl.supportedValuesOf("timeZone")
    .filter((zone) => zone.toLowerCase().includes(typed))
    .slice(0, MAX_SUGGESTIONS);
  await interaction.respond(zones.map((zone) => ({ name: zone, value: zone })));
}

function describeArchive(interaction: CommandInteraction, archive: ArchiveDetails) {
  return baseEmbed(interaction)
    .setTitle(`🗄️ ${archive.name}`)
    .addFields(
      { name: "ID", value: `\`${archive.archiveId}\`` },
      { name: "Version", value: String(archive.version), inline: true },
      { name: "Timezone", value: archive.timezone, inline: true },
      { name: "Lane gap", value: `${archive.laneGapDays} days`, inline: true },
    );
}

/** Resolves an omitted version to the archive's current one. */
function versionOrCurrent(interaction: CommandInteraction, archiveId: string, version?: number) {
  return (
    version ??
    getArchive(archivist(), { userId: interaction.user.id, isOwner: true }, archiveId).version
  );
}

@Discord()
@Guild(config.ownerGuildId!)
@Guard(IsOwner)
@SlashGroup({ name: "archivist-admin", description: "Archivist administration for the bot owner" })
@SlashGroup({ name: "archive", description: "Create and manage archives", root: "archivist-admin" })
@SlashGroup({
  name: "whitelist",
  description: "Manage who can use an archive",
  root: "archivist-admin",
})
export class ArchivistAdmin {
  @Slash({ name: "create", description: "Create an archive", ...GUILD_ONLY })
  @SlashGroup("archive", "archivist-admin")
  async create(
    @SlashOption({
      name: "name",
      description: "Archive name, 1 to 100 characters",
      type: ApplicationCommandOptionType.String,
      required: true,
      maxLength: 100,
    })
    name: string,
    interaction: CommandInteraction,
  ): Promise<void> {
    await runArchivist(interaction, async () => {
      await interaction.deferReply(ephemeral);
      const archive = createArchive(archivist(), await actorOf(interaction), { name });
      await interaction.editReply({
        content: "Archive created. Add members with `/archivist-admin whitelist add`.",
        embeds: [describeArchive(interaction, archive)],
      });
    });
  }

  @Slash({ name: "list", description: "List every registered archive", ...GUILD_ONLY })
  @SlashGroup("archive", "archivist-admin")
  async list(interaction: CommandInteraction): Promise<void> {
    await runArchivist(interaction, async () => {
      const archives = listArchives(archivist(), await actorOf(interaction));
      const lines = archives.map((archive) => `**${archive.name}**  \`${archive.archiveId}\``);
      await interaction.reply({
        ...ephemeral,
        embeds: [
          baseEmbed(interaction)
            .setTitle("🗄️ Archives")
            .setDescription(
              lines.join("\n").slice(0, 4000) ||
                "No archives yet. Create one with `/archivist-admin archive create`.",
            ),
        ],
      });
    });
  }

  @Slash({
    name: "rename",
    description: "Rename an archive without moving its files",
    ...GUILD_ONLY,
  })
  @SlashGroup("archive", "archivist-admin")
  async rename(
    @SlashOption(archiveOption) archiveId: string,
    @SlashOption({
      name: "name",
      description: "New name, 1 to 100 characters",
      type: ApplicationCommandOptionType.String,
      required: true,
      maxLength: 100,
    })
    name: string,
    @SlashOption(versionOption) version: number | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    await runArchivist(interaction, async () => {
      await interaction.deferReply(ephemeral);
      const archive = renameArchive(archivist(), await actorOf(interaction), {
        archiveId,
        name,
        expectedVersion: versionOrCurrent(interaction, archiveId, version),
      });
      await interaction.editReply({
        content: "Archive renamed.",
        embeds: [describeArchive(interaction, archive)],
      });
    });
  }

  @Slash({
    name: "settings",
    description: "Change an archive's timezone or timeline lane gap",
    ...GUILD_ONLY,
  })
  @SlashGroup("archive", "archivist-admin")
  async settings(
    @SlashOption(archiveOption) archiveId: string,
    @SlashOption({
      name: "timezone",
      description: "Timezone for timeline days, such as America/Toronto",
      type: ApplicationCommandOptionType.String,
      required: false,
      autocomplete: suggestTimeZones,
    })
    timezone: string | undefined,
    @SlashOption({
      name: "lane_gap_days",
      description: "Days without activity before a secondary server lane ends",
      type: ApplicationCommandOptionType.Integer,
      required: false,
      minValue: 1,
      maxValue: 3650,
    })
    laneGapDays: number | undefined,
    @SlashOption(versionOption) version: number | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    await runArchivist(interaction, async () => {
      await interaction.deferReply(ephemeral);
      const archive = updateArchiveSettings(archivist(), await actorOf(interaction), {
        archiveId,
        expectedVersion: versionOrCurrent(interaction, archiveId, version),
        timezone,
        laneGapDays,
      });
      await interaction.editReply({
        content: "Settings saved.",
        embeds: [describeArchive(interaction, archive)],
      });
    });
  }

  @Slash({
    name: "register",
    description: "Host an archive folder already in the archive directory",
    ...GUILD_ONLY,
  })
  @SlashGroup("archive", "archivist-admin")
  async register(
    @SlashOption({
      name: "archive_id",
      description: "The archive's ID, which is also its folder name",
      type: ApplicationCommandOptionType.String,
      required: true,
      maxLength: 36,
    })
    archiveId: string,
    @SlashOption({
      name: "name",
      description: "A new name, if its own name is already used here",
      type: ApplicationCommandOptionType.String,
      required: false,
      maxLength: 100,
    })
    name: string | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    await runArchivist(interaction, async () => {
      await interaction.deferReply(ephemeral);
      const result = registerArchive(archivist(), await actorOf(interaction), { archiveId, name });
      const notes = result.warnings.length ? `\n${result.warnings.slice(0, 10).join("\n")}` : "";
      await interaction.editReply({
        content: `Archive registered. Nobody else can open it until you add members.${notes}`,
        embeds: [describeArchive(interaction, result.archive)],
      });
    });
  }

  @Slash({
    name: "unregister",
    description: "Stop hosting an archive. Its files are kept.",
    ...GUILD_ONLY,
  })
  @SlashGroup("archive", "archivist-admin")
  async unregister(
    @SlashOption(archiveOption) archiveId: string,
    interaction: CommandInteraction,
  ): Promise<void> {
    await runArchivist(interaction, async () => {
      const archive = getArchive(archivist(), await actorOf(interaction), archiveId);
      const token = remember(interaction.user.id, { archiveId: archive.archiveId });
      const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`archivist-admin:unregister:${token}`)
          .setLabel(`Unregister ${archive.name}`.slice(0, 80))
          .setStyle(ButtonStyle.Danger),
      );
      await interaction.reply({
        ...ephemeral,
        content:
          `Unregistering **${archive.name}** removes its whitelist, announcement channel, and remembered selections. ` +
          "Its folder and files stay where they are, and you can register it again later. This button expires in 15 minutes.",
        components: [buttons],
      });
    });
  }

  @ButtonComponent({ id: /^archivist-admin:unregister:/ })
  async confirmUnregister(interaction: ButtonInteraction): Promise<void> {
    await runArchivist(interaction, async () => {
      const token = interaction.customId.split(":")[2] ?? "";
      const { archiveId } = recall<{ archiveId: string }>(token, interaction.user.id);
      unregisterArchive(archivist(), await actorOf(interaction), { archiveId });
      await interaction.update({
        content: "Archive unregistered. Its files were kept.",
        components: [],
      });
    });
  }

  @Slash({ name: "add", description: "Let someone use an archive", ...GUILD_ONLY })
  @SlashGroup("whitelist", "archivist-admin")
  async whitelistAdd(
    @SlashOption(archiveOption) archiveId: string,
    @SlashOption({
      name: "user",
      description: "Who to add",
      type: ApplicationCommandOptionType.User,
      required: true,
    })
    user: User,
    interaction: CommandInteraction,
  ): Promise<void> {
    await runArchivist(interaction, async () => {
      const { added } = addMember(archivist(), await actorOf(interaction), {
        archiveId,
        userId: user.id,
      });
      await interaction.reply({
        ...ephemeral,
        content: added
          ? `${user} can now use this archive.`
          : `${user} could already use this archive.`,
      });
    });
  }

  @Slash({ name: "remove", description: "Stop someone using an archive", ...GUILD_ONLY })
  @SlashGroup("whitelist", "archivist-admin")
  async whitelistRemove(
    @SlashOption(archiveOption) archiveId: string,
    @SlashOption({
      name: "user",
      description: "Who to remove",
      type: ApplicationCommandOptionType.User,
      required: true,
    })
    user: User,
    interaction: CommandInteraction,
  ): Promise<void> {
    await runArchivist(interaction, async () => {
      const { removed } = removeMember(archivist(), await actorOf(interaction), {
        archiveId,
        userId: user.id,
      });
      await interaction.reply({
        ...ephemeral,
        content: removed
          ? `${user} can no longer use this archive, starting with their next request.`
          : `${user} was not on this archive's whitelist.`,
      });
    });
  }

  @Slash({ name: "list", description: "List who can use an archive", ...GUILD_ONLY })
  @SlashGroup("whitelist", "archivist-admin")
  async whitelistList(
    @SlashOption(archiveOption) archiveId: string,
    @SlashOption({
      name: "page",
      description: "Page number",
      type: ApplicationCommandOptionType.Integer,
      required: false,
      minValue: 1,
    })
    page: number | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    await runArchivist(interaction, async () => {
      const actor = await actorOf(interaction);
      const archive = getArchive(archivist(), actor, archiveId);
      const members = listMembers(archivist(), actor, { archiveId });
      const pages = Math.max(1, Math.ceil(members.length / MEMBERS_PER_PAGE));
      const current = Math.min(page ?? 1, pages);
      const shown = members.slice((current - 1) * MEMBERS_PER_PAGE, current * MEMBERS_PER_PAGE);
      const lines = shown.map(
        (member) => `<@${member.userId}>  added ${member.grantedAt.slice(0, 10)}`,
      );
      await interaction.reply({
        ...ephemeral,
        allowedMentions: { parse: [] },
        embeds: [
          baseEmbed(interaction)
            .setTitle(`👥 ${archive.name} members`)
            .setDescription(lines.join("\n") || "Nobody yet. Only you can use this archive.")
            .setFooter({ text: `Page ${current} of ${pages}, ${members.length} members` }),
        ],
      });
    });
  }
}
