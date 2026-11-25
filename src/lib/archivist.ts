import {
  type AutocompleteInteraction,
  type ButtonInteraction,
  type CommandInteraction,
  MessageFlags,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { archivePath, archivistApi } from "./archivist-api.js";
import { ArchivistError, type ErrorCode } from "./archivist-errors.js";
import type { ArchiveDetails, ArchiveSummary } from "./archivist-types.js";
import { replyError } from "./embeds.js";

/**
 * The Discord side of Archivist. The Archivist service holds the archives
 * and applies every rule. These commands send what the contributor typed to
 * its API, as that contributor, and turn the answers into replies. The
 * service decides who may do what, so the bot never checks owner status or
 * whitelists itself.
 */

/** Discord shows at most this many autocomplete suggestions. */
export const MAX_SUGGESTIONS = 25;

type AnyInteraction =
  | CommandInteraction
  | AutocompleteInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;

/** The contributor a request acts for: the Discord user behind the interaction. */
export interface Actor {
  userId: string;
}

export async function actorOf(interaction: AnyInteraction): Promise<Actor> {
  return { userId: interaction.user.id };
}

/**
 * The archive a contributor command uses. An archive given in the command is
 * checked and remembered by the service. Without one, the service returns the
 * contributor's remembered archive, or asks them to choose.
 */
export function selectArchive(actor: Actor, archive?: string | null): Promise<ArchiveSummary> {
  return archivistApi().post<ArchiveSummary>(actor.userId, "/api/me/archive-selection", {
    archiveId: archive || undefined,
  });
}

/** An archive's name, timezone, and display settings. */
export function getArchiveDetails(actor: Actor, archiveId: string): Promise<ArchiveDetails> {
  return archivistApi().get<ArchiveDetails>(actor.userId, archivePath(archiveId));
}

/**
 * The archive an autocomplete request is about: the one typed in the
 * command's archive option, or the contributor's remembered one. Asking for
 * the remembered archive never changes it. Null when there is none, so the
 * suggestion list is empty rather than an error.
 */
export async function autocompleteArchive(
  interaction: AutocompleteInteraction,
): Promise<string | null> {
  const typed = interaction.options.getString("archive");
  if (typed) return typed;
  try {
    return (await selectArchive(await actorOf(interaction))).archiveId;
  } catch {
    return null;
  }
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
  dependency_unavailable: "Archivist unavailable",
  internal_error: "Something went wrong",
};

/**
 * Runs an Archivist command, replying privately with a readable message when
 * it fails. Unexpected errors are logged and reported without their details.
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

/** Suggests the archives the contributor can open, matching what they typed. */
export async function suggestArchives(interaction: AutocompleteInteraction): Promise<void> {
  const typed = interaction.options.getFocused().toLowerCase();
  let archives: ArchiveSummary[] = [];
  try {
    archives = (
      await archivistApi().get<{ archives: ArchiveSummary[] }>(interaction.user.id, "/api/archives")
    ).archives;
  } catch {
    // An unreachable service shows no suggestions rather than an error.
  }
  await interaction.respond(
    archives
      .filter((archive) => archive.name.toLowerCase().includes(typed))
      .slice(0, MAX_SUGGESTIONS)
      .map((archive) => ({ name: archive.name.slice(0, 100), value: archive.archiveId })),
  );
}

/** The first eight characters of a record ID, as replies show it. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
