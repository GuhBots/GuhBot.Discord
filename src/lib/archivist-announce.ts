import { existsSync } from "node:fs";
import { AttachmentBuilder, type Client, DiscordAPIError } from "discord.js";
import { registeredArchive } from "../archivist/access.js";
import {
  claimAnnouncement,
  finishAnnouncement,
  getAnnouncementChannel,
} from "../archivist/announcements.js";
import { archiveDetails } from "../archivist/archives.js";
import type { ArtifactDetails } from "../archivist/artifacts.js";
import { type ArchivistContext, openStore } from "../archivist/context.js";
import { mediaPaths } from "../archivist/media.js";
import { characterNames } from "../archivist/lookup.js";
import { insideArchive } from "../archivist/paths.js";
import { artifactEmbed, PREVIEW_ATTACHMENT } from "./archivist-format.js";

/** What happened to an artifact's announcement, for the contributor's reply. */
export type AnnouncementOutcome =
  | { status: "not_configured" | "sent" | "already_handled" }
  | { status: "failed" | "indeterminate"; reason: string };

/** The preview of an artifact as a message attachment, if it has one on disk. */
export function previewAttachment(
  context: ArchivistContext,
  archiveId: string,
  artifact: ArtifactDetails,
): AttachmentBuilder | null {
  if (!artifact.media.hasPreview) return null;
  const store = openStore(context, archiveId);
  const path = mediaPaths(artifact.media.id, "webp", true).preview!;
  const file = insideArchive(store.folder, path);
  return existsSync(file) ? new AttachmentBuilder(file, { name: PREVIEW_ATTACHMENT }) : null;
}

/**
 * Posts a new artifact to its archive's announcement channel, at most once.
 * The artifact is already saved, so failures are reported, not thrown.
 */
export async function announceArtifact(
  client: Client<true>,
  context: ArchivistContext,
  archiveId: string,
  artifact: ArtifactDetails,
): Promise<AnnouncementOutcome> {
  const channel = getAnnouncementChannel(context, archiveId);
  if (!channel) return { status: "not_configured" };
  if (!claimAnnouncement(context, { archiveId, artifactId: artifact.id, ...channel })) {
    return { status: "already_handled" };
  }
  const finish = (outcome: AnnouncementOutcome, messageId?: string): AnnouncementOutcome => {
    finishAnnouncement(context, {
      archiveId,
      artifactId: artifact.id,
      state:
        outcome.status === "sent"
          ? "sent"
          : outcome.status === "failed"
            ? "failed"
            : "indeterminate",
      messageId,
      errorCode: "reason" in outcome ? outcome.reason : undefined,
    });
    return outcome;
  };

  let target;
  try {
    target = await client.channels.fetch(channel.channelId);
  } catch {
    return finish({
      status: "failed",
      reason: "The announcement channel no longer exists or the bot cannot see it.",
    });
  }
  if (!target?.isSendable() || target.isDMBased()) {
    return finish({ status: "failed", reason: "The bot cannot post in the announcement channel." });
  }

  const store = openStore(context, archiveId);
  const details = archiveDetails(store);
  const preview = previewAttachment(context, archiveId, artifact);
  const embed = artifactEmbed(artifact, {
    archiveName: registeredArchive(context, archiveId)?.name ?? details.name,
    archiveTimeZone: details.timezone,
    characterNames: characterNames(store.db, artifact.links.characters),
    hasPreviewAttachment: preview !== null,
    addedBy: artifact.createdBy,
  });
  try {
    const message = await target.send({
      embeds: [embed],
      files: preview ? [preview] : [],
      allowedMentions: { parse: [] },
    });
    return finish({ status: "sent" }, message.id);
  } catch (error) {
    // Discord refused the request, so nothing was posted. Anything else, such
    // as a timeout, may have posted, so it is never retried automatically.
    if (error instanceof DiscordAPIError && error.status < 500) {
      return finish({ status: "failed", reason: `Discord refused the post (${error.code}).` });
    }
    return finish({
      status: "indeterminate",
      reason: "The post may or may not have gone through, so it was not repeated.",
    });
  }
}
