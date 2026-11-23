import {
  type AutocompleteInteraction,
  type ButtonInteraction,
  type CommandInteraction,
  MessageFlags,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { settleInterruptedAnnouncements } from "../archivist/announcements.js";
import { listArchives } from "../archivist/archives.js";
import {
  type Actor,
  type ArchivistContext,
  closeArchivistContext,
  createArchivistContext,
} from "../archivist/context.js";
import { ArchivistError, type ErrorCode } from "../archivist/errors.js";
import { cleanStaging } from "../archivist/media.js";
import { closeMetadataReader } from "../archivist/metadata.js";
import { config } from "../config.js";
import { getDatabase } from "./database.js";
import { replyError } from "./embeds.js";
import { onShutdown } from "./lifecycle.js";
import { isApplicationOwner } from "./owner.js";

/**
 * The Discord side of Archivist: one shared context for every command, the
 * acting person, and error replies. The archive rules live in `src/archivist/`.
 */

/** Discord shows at most this many autocomplete suggestions. */
export const MAX_SUGGESTIONS = 25;

const SWEEP_INTERVAL_MS = 5 * 60_000;

let context: ArchivistContext | undefined;

/** The shared Archivist context, created on first use. */
export function archivist(): ArchivistContext {
  if (!context) {
    context = createArchivistContext({ dataDir: config.dataDir, botDb: getDatabase() });
    cleanStaging(context);
    const unknown = settleInterruptedAnnouncements(context);
    if (unknown > 0) {
      console.warn(
        `Archivist: ${unknown} announcement(s) were interrupted and will not be resent.`,
      );
    }
    const sweeper = setInterval(() => {
      if (context) cleanStaging(context);
    }, SWEEP_INTERVAL_MS);
    sweeper.unref();
    onShutdown(async () => {
      clearInterval(sweeper);
      if (context) closeArchivistContext(context);
      context = undefined;
      await closeMetadataReader();
    });
  }
  return context;
}

type AnyInteraction =
  | CommandInteraction
  | AutocompleteInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;

/** The person behind an interaction. Owner status is re-checked at most every five minutes. */
export async function actorOf(interaction: AnyInteraction): Promise<Actor> {
  return {
    userId: interaction.user.id,
    isOwner: await isApplicationOwner(interaction.client, interaction.user.id),
  };
}

const ERROR_TITLES: Record<ErrorCode, string> = {
  invalid_input: "Check your input",
  no_session: "Sign in first",
  forbidden: "Not allowed",
  archive_not_found: "Archive not found",
  not_found: "Not found",
  stale_version: "Changed by someone else",
  reference_blocked: "Still linked",
  name_taken: "Name already used",
  unsupported_schema: "Unsupported archive",
  media_too_large: "File too large",
  unsupported_media_type: "Unsupported file",
  upstream_rate_limited: "Try again shortly",
  dependency_unavailable: "Archive unavailable",
};

/**
 * Runs an Archivist command, replying privately with a readable message when
 * it fails. Unexpected errors are logged and reported without their details,
 * which can include file paths.
 */
export async function runArchivist(
  interaction:
    CommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof ArchivistError)) {
      console.error(`Archivist interaction ${interaction.id} failed:`, error);
    }
    const title =
      error instanceof ArchivistError ? ERROR_TITLES[error.code] : "Something went wrong";
    const message =
      error instanceof ArchivistError
        ? error.message
        : "Archivist could not finish that. Nothing was half-saved. Try again, and tell the bot owner if it keeps happening.";
    if (interaction.isCommand()) {
      await replyError(interaction, title, message);
    } else if (interaction.deferred || interaction.replied) {
      await interaction.followUp({
        content: `**${title}.** ${message}`,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.reply({
        content: `**${title}.** ${message}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}

/** Suggests the archives the person can open, matching what they typed. */
export async function suggestArchives(interaction: AutocompleteInteraction): Promise<void> {
  const typed = interaction.options.getFocused().toLowerCase();
  const archives = listArchives(archivist(), await actorOf(interaction))
    .filter((archive) => archive.name.toLowerCase().includes(typed))
    .slice(0, MAX_SUGGESTIONS);
  await interaction.respond(
    archives.map((archive) => ({ name: archive.name.slice(0, 100), value: archive.archiveId })),
  );
}

/** The first eight characters of a record ID, as replies show it. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
