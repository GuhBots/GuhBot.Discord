import { requireArchiveAccess } from "./access.js";
import type { Actor, ArchivistContext } from "./context.js";
import { discordId, timestamp } from "./fields.js";

/**
 * Upload announcements. Each archive may have one destination channel, set
 * by any member and kept in `guhbot.db`. Every newly created artifact is
 * announced there once, from Discord or the web. Announcements are upload
 * history: edits and deletions never change or remove them, and saving an
 * artifact never depends on its announcement.
 *
 * Delivery state prevents a second post for the same artifact. A post that
 * definitely failed may be retried. A post whose outcome is unknown, such as
 * a timeout after sending, is never resent automatically, because it may
 * already be in the channel.
 */

export interface AnnouncementChannel {
  guildId: string;
  channelId: string;
}

export type DeliveryState = "pending" | "sent" | "failed" | "indeterminate";

export function getAnnouncementChannel(
  context: ArchivistContext,
  archiveId: string,
): AnnouncementChannel | null {
  return (
    (context.botDb
      .prepare(
        "SELECT guild_id AS guildId, channel_id AS channelId FROM archivist_announcement_channels WHERE archive_id = ?",
      )
      .get(archiveId) as AnnouncementChannel | undefined) ?? null
  );
}

/** Sets where new artifacts are announced. Adapters check channel permissions first. */
export function setAnnouncementChannel(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; guildId: unknown; channelId: unknown },
): AnnouncementChannel {
  const archive = requireArchiveAccess(context, actor, input.archiveId);
  const guildId = discordId("guildId", input.guildId);
  const channelId = discordId("channelId", input.channelId);
  context.botDb
    .prepare(
      `INSERT INTO archivist_announcement_channels (archive_id, guild_id, channel_id, configured_by, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (archive_id) DO UPDATE SET guild_id = excluded.guild_id, channel_id = excluded.channel_id,
         configured_by = excluded.configured_by, updated_at = excluded.updated_at`,
    )
    .run(archive.archiveId, guildId, channelId, actor.userId, timestamp(context.now()));
  return { guildId, channelId };
}

/** Stops future announcements. Earlier posts stay where they are. */
export function removeAnnouncementChannel(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown },
): { removed: boolean } {
  const archive = requireArchiveAccess(context, actor, input.archiveId);
  const result = context.botDb
    .prepare("DELETE FROM archivist_announcement_channels WHERE archive_id = ?")
    .run(archive.archiveId);
  return { removed: result.changes > 0 };
}

export function deliveryState(
  context: ArchivistContext,
  archiveId: string,
  artifactId: string,
): DeliveryState | null {
  const row = context.botDb
    .prepare("SELECT state FROM archivist_announcements WHERE archive_id = ? AND artifact_id = ?")
    .get(archiveId, artifactId) as { state: DeliveryState } | undefined;
  return row?.state ?? null;
}

/**
 * Claims the right to post an artifact's announcement. Returns false when it
 * was already posted, is being posted, or may have been posted. A definite
 * earlier failure can be claimed again.
 */
export function claimAnnouncement(
  context: ArchivistContext,
  input: { archiveId: string; artifactId: string } & AnnouncementChannel,
): boolean {
  const now = timestamp(context.now());
  return context.botDb.transaction(() => {
    const state = deliveryState(context, input.archiveId, input.artifactId);
    if (state !== null && state !== "failed") return false;
    context.botDb
      .prepare(
        `INSERT INTO archivist_announcements (archive_id, artifact_id, guild_id, channel_id, state, attempted_at)
         VALUES (?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (archive_id, artifact_id) DO UPDATE SET guild_id = excluded.guild_id,
           channel_id = excluded.channel_id, state = 'pending', attempted_at = excluded.attempted_at,
           message_id = NULL, error_code = NULL`,
      )
      .run(input.archiveId, input.artifactId, input.guildId, input.channelId, now);
    return true;
  })();
}

export function finishAnnouncement(
  context: ArchivistContext,
  input: {
    archiveId: string;
    artifactId: string;
    state: Exclude<DeliveryState, "pending">;
    messageId?: string;
    errorCode?: string;
  },
): void {
  context.botDb
    .prepare(
      `UPDATE archivist_announcements SET state = ?, message_id = ?, error_code = ?
       WHERE archive_id = ? AND artifact_id = ?`,
    )
    .run(
      input.state,
      input.messageId ?? null,
      input.errorCode ?? null,
      input.archiveId,
      input.artifactId,
    );
}

/**
 * Marks posts still pending as indeterminate. Run at startup: a pending post
 * means the bot stopped mid-send, so the message may or may not exist.
 */
export function settleInterruptedAnnouncements(context: ArchivistContext): number {
  return context.botDb
    .prepare("UPDATE archivist_announcements SET state = 'indeterminate' WHERE state = 'pending'")
    .run().changes;
}
