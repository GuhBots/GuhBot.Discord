import { requireArchiveOwner } from "./access.js";
import type { Actor, ArchivistContext } from "./context.js";
import { discordId, timestamp } from "./fields.js";

/**
 * The owner's per-archive whitelist, kept in `guhbot.db`. Adding and removing
 * are idempotent. Removal takes effect on the member's next request because
 * every request reads the whitelist.
 */

export interface Member {
  userId: string;
  grantedAt: string;
  grantedBy: string;
}

export function addMember(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; userId: unknown },
): { added: boolean } {
  const archive = requireArchiveOwner(context, actor, input.archiveId, "manage archive members");
  const userId = discordId("userId", input.userId);
  const result = context.botDb
    .prepare(
      `INSERT OR IGNORE INTO archivist_whitelist (archive_id, discord_user_id, granted_at, granted_by)
       VALUES (?, ?, ?, ?)`,
    )
    .run(archive.archiveId, userId, timestamp(context.now()), actor.userId);
  return { added: result.changes > 0 };
}

export function removeMember(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; userId: unknown },
): { removed: boolean } {
  const archive = requireArchiveOwner(context, actor, input.archiveId, "manage archive members");
  const userId = discordId("userId", input.userId);
  const result = context.botDb
    .prepare("DELETE FROM archivist_whitelist WHERE archive_id = ? AND discord_user_id = ?")
    .run(archive.archiveId, userId);
  return { removed: result.changes > 0 };
}

/** Every member of an archive, oldest grant first. Adapters paginate the list. */
export function listMembers(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown },
): Member[] {
  const archive = requireArchiveOwner(context, actor, input.archiveId, "view archive members");
  return context.botDb
    .prepare(
      `SELECT discord_user_id AS userId, granted_at AS grantedAt, granted_by AS grantedBy
       FROM archivist_whitelist WHERE archive_id = ? ORDER BY granted_at, discord_user_id`,
    )
    .all(archive.archiveId) as Member[];
}
