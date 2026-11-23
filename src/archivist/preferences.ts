import {
  isMember,
  registeredArchive,
  requireArchiveAccess,
  type RegisteredArchive,
} from "./access.js";
import type { Actor, ArchivistContext } from "./context.js";
import { timeZoneName } from "./dates.js";
import { ArchivistError } from "./errors.js";
import { timestamp } from "./fields.js";

/**
 * Per-person settings kept in `guhbot.db`, outside every archive: a personal
 * timezone for reading typed dates, and the archive last chosen in Discord.
 */

export function getTimeZone(context: ArchivistContext, actor: Actor): string | null {
  const row = context.botDb
    .prepare("SELECT timezone FROM archivist_timezones WHERE discord_user_id = ?")
    .get(actor.userId) as { timezone: string } | undefined;
  return row?.timezone ?? null;
}

/** Sets the actor's timezone. Existing historical values are never rewritten. */
export function setTimeZone(context: ArchivistContext, actor: Actor, value: unknown): string {
  const timezone = timeZoneName("timezone", value);
  context.botDb
    .prepare(
      `INSERT INTO archivist_timezones (discord_user_id, timezone, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (discord_user_id) DO UPDATE SET timezone = excluded.timezone, updated_at = excluded.updated_at`,
    )
    .run(actor.userId, timezone, timestamp(context.now()));
  return timezone;
}

/** Clears the actor's timezone, so typed dates fall back to each archive's timezone. */
export function resetTimeZone(context: ArchivistContext, actor: Actor): void {
  context.botDb
    .prepare("DELETE FROM archivist_timezones WHERE discord_user_id = ?")
    .run(actor.userId);
}

/** The zone a typed date without its own zone is read in: the person's, then the archive's. */
export function inputTimeZone(
  context: ArchivistContext,
  actor: Actor,
  archiveTimeZone: string,
): string {
  return getTimeZone(context, actor) ?? archiveTimeZone;
}

/**
 * Picks the archive for a Discord command. An explicit choice is checked and
 * remembered. Without one, the last explicit choice is used if the actor can
 * still open it. Otherwise the actor must choose.
 */
export function resolveArchiveSelection(
  context: ArchivistContext,
  actor: Actor,
  archiveId: unknown,
): RegisteredArchive {
  if (archiveId !== undefined && archiveId !== null && archiveId !== "") {
    const archive = requireArchiveAccess(context, actor, archiveId);
    context.botDb
      .prepare(
        `INSERT INTO archivist_last_archives (discord_user_id, archive_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (discord_user_id) DO UPDATE SET archive_id = excluded.archive_id, updated_at = excluded.updated_at`,
      )
      .run(actor.userId, archive.archiveId, timestamp(context.now()));
    return archive;
  }

  const remembered = context.botDb
    .prepare(
      "SELECT archive_id AS archiveId FROM archivist_last_archives WHERE discord_user_id = ?",
    )
    .get(actor.userId) as { archiveId: string } | undefined;
  const archive = remembered && registeredArchive(context, remembered.archiveId);
  if (archive && (actor.isOwner || isMember(context, archive.archiveId, actor.userId))) {
    return archive;
  }
  if (remembered) {
    context.botDb
      .prepare("DELETE FROM archivist_last_archives WHERE discord_user_id = ?")
      .run(actor.userId);
  }
  throw new ArchivistError("invalid_input", "Choose an archive for this command.", {
    field: "archive",
    reason: "archive_required",
  });
}
