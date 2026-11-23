import type { Actor, ArchivistContext } from "./context.js";
import { ArchivistError } from "./errors.js";
import { archiveIdValue } from "./paths.js";

/**
 * Permission checks. Every archive request checks current registration and
 * whitelist rows, so removing someone takes effect on their next request.
 * An archive the actor cannot see is reported as not found, so its
 * existence is not revealed. An owner-only action on an archive the actor
 * can see is reported as forbidden.
 */

export interface RegisteredArchive {
  archiveId: string;
  name: string;
}

export function registeredArchive(
  context: ArchivistContext,
  archiveId: string,
): RegisteredArchive | undefined {
  return context.botDb
    .prepare("SELECT archive_id AS archiveId, name FROM archivist_archives WHERE archive_id = ?")
    .get(archiveId) as RegisteredArchive | undefined;
}

export function isMember(context: ArchivistContext, archiveId: string, userId: string): boolean {
  return (
    context.botDb
      .prepare("SELECT 1 FROM archivist_whitelist WHERE archive_id = ? AND discord_user_id = ?")
      .get(archiveId, userId) !== undefined
  );
}

function notFound(): ArchivistError {
  return new ArchivistError(
    "archive_not_found",
    "That archive does not exist or you cannot access it.",
  );
}

/** Allows the owner and current members. Everyone else sees no archive. */
export function requireArchiveAccess(
  context: ArchivistContext,
  actor: Actor,
  archiveIdInput: unknown,
): RegisteredArchive {
  let archiveId: string;
  try {
    archiveId = archiveIdValue("archive", archiveIdInput);
  } catch {
    throw notFound();
  }
  const archive = registeredArchive(context, archiveId);
  if (!archive || !(actor.isOwner || isMember(context, archiveId, actor.userId))) throw notFound();
  return archive;
}

/** Owner-only actions that do not concern one archive, such as creating one. */
export function requireOwner(actor: Actor, action: string): void {
  if (!actor.isOwner) {
    throw new ArchivistError("forbidden", `Only the bot owner can ${action}.`);
  }
}

/** Owner-only actions on an archive. Members see the archive but are refused. */
export function requireArchiveOwner(
  context: ArchivistContext,
  actor: Actor,
  archiveIdInput: unknown,
  action: string,
): RegisteredArchive {
  const archive = requireArchiveAccess(context, actor, archiveIdInput);
  requireOwner(actor, action);
  return archive;
}
