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
import { ButtonComponent, Discord, Guild, Slash, SlashGroup, SlashOption } from "discordx";
import { config } from "../config.js";
import { actorOf, MAX_SUGGESTIONS, runArchivist, suggestArchives } from "../lib/archivist.js";
import { archivePath, archivistApi } from "../lib/archivist-api.js";
import { dayText } from "../lib/archivist-dates.js";
import { ArchivistError } from "../lib/archivist-errors.js";
import { recall, remember } from "../lib/archivist-pending.js";
import type {
  ArchiveDetails,
  ArchiveSummary,
  ExportJob,
  Me,
  Member,
} from "../lib/archivist-types.js";
import { GUILD_ONLY } from "../lib/categories.js";
import { baseEmbed } from "../lib/embeds.js";

/**
 * Archivist administration: archives, whitelists, and exports, as a client of
 * the Archivist service. Registered only in OWNER_GUILD_ID, like the other
 * owner commands. The service decides who is an owner from its own
 * ARCHIVIST_OWNER_IDS, so these commands have no guard of their own: the
 * service refuses anyone else, and the reply says so.
 */

const MEMBERS_PER_PAGE = 40;
/** How often an export's progress is checked, and for how long the reply can still be edited. */
const EXPORT_POLL_MS = 5_000;
const EXPORT_WATCH_MS = 14 * 60_000;
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

function archivePathOf(archiveId: string): string {
  return archivePath(archiveId);
}

function getArchive(userId: string, archiveId: string): Promise<ArchiveDetails> {
  return archivistApi().get<ArchiveDetails>(userId, archivePathOf(archiveId));
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** One line about an export for the owner. */
function exportLine(job: ExportJob): string {
  const started = `<t:${Math.floor(job.createdMs / 1000)}:f>`;
  const where = job.path ? `\`${job.path}\`` : "";
  switch (job.state) {
    case "ready":
      return job.onDisk
        ? `**${job.archiveName}**, ${started}: ready, ${megabytes(job.byteLength ?? 0)}, ${where}`
        : `**${job.archiveName}**, ${started}: deleted from the host`;
    case "failed":
      return `**${job.archiveName}**, ${started}: failed (${job.errorCode ?? "unknown"})`;
    default:
      return `**${job.archiveName}**, ${started}: still writing ${where}`;
  }
}

/** Resolves an omitted version to the archive's current one. Only owners run these commands. */
async function versionOrCurrent(userId: string, archiveId: string, version?: number) {
  return version ?? (await getArchive(userId, archiveId)).version;
}

/** Waits for an export to finish writing, up to `until`. */
async function waitForExport(userId: string, job: ExportJob, until: number): Promise<ExportJob> {
  let current = job;
  while (current.state !== "ready" && current.state !== "failed" && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, EXPORT_POLL_MS));
    current = await archivistApi().get<ExportJob>(
      userId,
      `/api/exports/${encodeURIComponent(job.id)}`,
    );
  }
  return current;
}

@Discord()
@Guild(config.ownerGuildId!)
@SlashGroup({ name: "archivist-admin", description: "Archivist administration for its owners" })
@SlashGroup({ name: "archive", description: "Create and manage archives", root: "archivist-admin" })
@SlashGroup({
  name: "whitelist",
  description: "Manage who can use an archive",
  root: "archivist-admin",
})
@SlashGroup({
  name: "export",
  description: "Zip a whole archive on the Archivist service's host",
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
      const archive = await archivistApi().post<ArchiveDetails>(
        (await actorOf(interaction)).userId,
        "/api/archives",
        { name },
      );
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
      await interaction.deferReply(ephemeral);
      const { archives } = await archivistApi().get<{ archives: ArchiveSummary[] }>(
        interaction.user.id,
        "/api/archives",
      );
      const lines = archives.map((archive) => `**${archive.name}**  \`${archive.archiveId}\``);
      await interaction.editReply({
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
      const userId = interaction.user.id;
      const archive = await archivistApi().put<ArchiveDetails>(
        userId,
        archivePath(archiveId, "name"),
        { name, expectedVersion: await versionOrCurrent(userId, archiveId, version) },
      );
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
      const userId = interaction.user.id;
      const archive = await archivistApi().patch<ArchiveDetails>(
        userId,
        archivePath(archiveId, "settings"),
        {
          expectedVersion: await versionOrCurrent(userId, archiveId, version),
          timezone,
          laneGapDays,
        },
      );
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
      const result = await archivistApi().post<{ archive: ArchiveDetails; warnings: string[] }>(
        interaction.user.id,
        "/api/archives/register",
        { archiveId, name },
      );
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
      await interaction.deferReply(ephemeral);
      const archive = await getArchive(interaction.user.id, archiveId);
      const token = remember(interaction.user.id, { archiveId: archive.archiveId });
      const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`archivist-admin:unregister:${token}`)
          .setLabel(`Unregister ${archive.name}`.slice(0, 80))
          .setStyle(ButtonStyle.Danger),
      );
      await interaction.editReply({
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
      await interaction.deferUpdate();
      await archivistApi().delete(interaction.user.id, archivePath(archiveId));
      await interaction.editReply({
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
      await interaction.deferReply(ephemeral);
      const { added } = await archivistApi().put<{ added: boolean }>(
        interaction.user.id,
        archivePath(archiveId, "members", user.id),
      );
      await interaction.editReply({
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
      await interaction.deferReply(ephemeral);
      const { removed } = await archivistApi().delete<{ removed: boolean }>(
        interaction.user.id,
        archivePath(archiveId, "members", user.id),
      );
      await interaction.editReply({
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
      await interaction.deferReply(ephemeral);
      const userId = interaction.user.id;
      const [archive, { members }] = await Promise.all([
        getArchive(userId, archiveId),
        archivistApi().get<{ members: Member[] }>(userId, archivePath(archiveId, "members")),
      ]);
      const pages = Math.max(1, Math.ceil(members.length / MEMBERS_PER_PAGE));
      const current = Math.min(page ?? 1, pages);
      const shown = members.slice((current - 1) * MEMBERS_PER_PAGE, current * MEMBERS_PER_PAGE);
      const lines = shown.map(
        (member) => `<@${member.userId}>  added ${dayText(member.grantedAt.slice(0, 10))}`,
      );
      await interaction.editReply({
        allowedMentions: { parse: [] },
        embeds: [
          baseEmbed(interaction)
            .setTitle(`👥 ${archive.name} members`)
            .setDescription(lines.join("\n") || "Nobody yet. Only owners can use this archive.")
            .setFooter({ text: `Page ${current} of ${pages}, ${members.length} members` }),
        ],
      });
    });
  }

  @Slash({
    name: "create",
    description: "Zip a whole archive on the Archivist service's host",
    ...GUILD_ONLY,
  })
  @SlashGroup("export", "archivist-admin")
  async exportCreate(
    @SlashOption(archiveOption) archiveId: string,
    interaction: CommandInteraction,
  ): Promise<void> {
    await runArchivist(interaction, async () => {
      await interaction.deferReply(ephemeral);
      const userId = interaction.user.id;
      const started = Date.now();
      const job = await archivistApi().post<ExportJob>(userId, archivePath(archiveId, "exports"));
      await interaction.editReply({
        content:
          `Writing the export of **${job.archiveName}** on the Archivist service's host, at \`${job.path}\`. ` +
          "The snapshot is taken, so later changes are not in it. This reply updates when the zip is done. " +
          "Large archives can take a while, so check `/archivist-admin export list` if it does not.",
      });
      // The reply can be edited for 15 minutes. A longer export still finishes, and
      // the list shows it.
      const finished = await waitForExport(userId, job, started + EXPORT_WATCH_MS).catch(() => job);
      if (finished.state === "ready") {
        await interaction.editReply({
          content:
            `The export of **${finished.archiveName}** is ready on the Archivist service's host: ` +
            `\`${finished.path}\` (${megabytes(finished.byteLength ?? 0)}). It stays there until you delete it.`,
        });
      } else if (finished.state === "failed") {
        await interaction.editReply({
          content: `The export of **${job.archiveName}** failed (${finished.errorCode ?? "unknown"}).`,
        });
      }
    });
  }

  @Slash({ name: "list", description: "List recent exports and where they are", ...GUILD_ONLY })
  @SlashGroup("export", "archivist-admin")
  async exportList(interaction: CommandInteraction): Promise<void> {
    await runArchivist(interaction, async () => {
      await interaction.deferReply(ephemeral);
      const { exports } = await archivistApi().get<{ exports: ExportJob[] }>(
        interaction.user.id,
        "/api/exports",
      );
      await interaction.editReply({
        embeds: [
          baseEmbed(interaction)
            .setTitle("🗜️ Recent exports")
            .setDescription(
              exports.map(exportLine).join("\n") ||
                "No exports yet. Make one with `/archivist-admin export create`.",
            ),
        ],
      });
    });
  }

  @Slash({
    name: "status",
    description: "Check that the bot reaches Archivist, and whether you are one of its owners",
    ...GUILD_ONLY,
  })
  @SlashGroup("archivist-admin")
  async status(interaction: CommandInteraction): Promise<void> {
    await runArchivist(interaction, async () => {
      await interaction.deferReply(ephemeral);
      const address = config.archivistApi.url ?? "not set";
      let me: Me;
      try {
        me = await archivistApi().get<Me>(interaction.user.id, "/api/me");
      } catch (error) {
        const reason = error instanceof ArchivistError ? error.message : String(error);
        await interaction.editReply({
          content: `The bot could not use Archivist at ${address}. ${reason}`,
        });
        return;
      }
      await interaction.editReply({
        content:
          `The bot reaches Archivist at ${address}. ` +
          (me.isOwner
            ? "You are one of its owners."
            : "You are not one of its owners, so it refuses these commands for you. Owners are set by ARCHIVIST_OWNER_IDS on the Archivist service."),
      });
    });
  }
}
