import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type {} from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import {
  getAnnouncementChannel,
  removeAnnouncementChannel,
  setAnnouncementChannel,
} from "../announcements.js";
import {
  applyDuplicateReview,
  type ArtifactDetails,
  checkIntake,
  createArtifact,
  duplicateDifferences,
  findArtifactBySource,
  type IntakeInput,
} from "../artifacts.js";
import type { Actor, ArchivistContext } from "../context.js";
import { needsZoneConfirmation } from "../dates.js";
import { DriveClient, parseDriveLink } from "../drive.js";
import { ArchivistError } from "../errors.js";
import { entityView } from "../entity-views.js";
import { addHistory, setPicture } from "../history.js";
import {
  createStagingFolder,
  discardStaging,
  MAX_MEDIA_BYTES,
  type StagedMedia,
  stageMedia,
} from "../media.js";
import { getDateOrder } from "../preferences.js";
import { openForActor } from "../records.js";
import type { Auth } from "./auth.js";
import type { Fetch } from "./discord-oauth.js";
import { ReviewStore } from "./reviews.js";

/**
 * Adding artifacts from the website, with the same steps as Discord: the
 * fields are checked before any file is kept, a source already in the
 * archive opens a duplicate review instead of a copy, and a new artifact is
 * announced in the archive's logs channel. Uploads send their fields before
 * the file. A Drive link needs no file.
 */

export type AnnouncementResult = { status: string; reason?: string };

export interface IntakeOptions {
  context: ArchivistContext;
  auth: Auth;
  /** Posts a new artifact to its logs channel. The bot provides it; without it nothing is posted. */
  announce?(archiveId: string, artifact: ArtifactDetails): Promise<AnnouncementResult>;
  /**
   * Checks a Discord channel for announcements: the bot can post there and the
   * contributor can see it. Returns its server. The bot provides it.
   */
  checkAnnouncementChannel?(userId: string, channelId: string): Promise<{ guildId: string }>;
  driveApiKey?: string;
  fetch: Fetch;
  logError(message: string, error: unknown): void;
}

type Fields = Record<string, unknown>;
const LINK_FIELDS = ["characters", "accounts", "servers", "channels", "events"] as const;

function text(fields: Fields, name: string): string | undefined {
  const value = fields[name];
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === "string" && single.trim() ? single : undefined;
}

function list(fields: Fields, name: string): string[] {
  const value = fields[name];
  if (value === undefined || value === null || value === "") return [];
  return (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
}

function intakeFrom(archiveId: string, fields: Fields, source: IntakeInput["source"]): IntakeInput {
  const estimatedDay = text(fields, "estimatedDay");
  return {
    archiveId,
    description: fields.description,
    source,
    exactDate: text(fields, "exactDate"),
    estimatedDate: estimatedDay ? { day: estimatedDay, reason: fields.estimateReason } : null,
    links: Object.fromEntries(LINK_FIELDS.map((name) => [name, list(fields, name)])),
  };
}

/** A time typed without a zone is saved only once the contributor has seen how it reads. */
function checkZone(
  context: ArchivistContext,
  actor: Actor,
  intake: IntakeInput,
  fields: Fields,
): void {
  const typed = intake.exactDate;
  const confirmed = fields.zoneConfirmed === true || text(fields, "zoneConfirmed") === "true";
  if (
    typeof typed === "string" &&
    !confirmed &&
    needsZoneConfirmation(typed, getDateOrder(context, actor))
  ) {
    throw new ArchivistError(
      "invalid_input",
      "That time has no timezone. Check how it will be read, then confirm it, or add a zone after the time.",
      { field: "exactDate", reason: "zone_unconfirmed" },
    );
  }
}

export function registerIntakeRoutes(scope: FastifyInstance, options: IntakeOptions): void {
  const { context, auth } = options;
  const reviews = new ReviewStore(() => context.now().getTime());
  const base = "/api/archives/:archiveId";
  type Params = { archiveId: string };

  async function duplicateReply(
    actor: Actor,
    archiveId: string,
    intake: IntakeInput,
    existing: ArtifactDetails,
  ) {
    const differences = duplicateDifferences(existing, checkIntake(context, actor, intake));
    const reviewToken = differences.length
      ? reviews.create({
          userId: actor.userId,
          archiveId,
          intake,
          artifactId: existing.id,
          version: existing.version,
        })
      : null;
    return { status: "duplicate" as const, artifact: existing, differences, reviewToken };
  }

  async function announce(
    archiveId: string,
    artifact: ArtifactDetails,
  ): Promise<AnnouncementResult> {
    if (!options.announce) return { status: "not_configured" };
    try {
      return await options.announce(archiveId, artifact);
    } catch (error) {
      // The artifact is saved either way; the contributor is told it was not posted.
      options.logError("Could not announce a web upload", error);
      return { status: "failed", reason: "The logs channel could not be reached." };
    }
  }

  scope.post<{ Params: Params }>(`${base}/artifacts/intake`, async (request, reply) => {
    const { actor } = await auth.requireActor(request);
    const { archiveId } = request.params;
    // Access is checked before anything is read from the upload.
    openForActor(context, actor, archiveId);
    const fields: Fields = {};
    let staging: string | null = null;
    let upload: { path: string; filename: string; key: string } | null = null;
    try {
      if (request.isMultipart()) {
        const parts = request.parts({
          limits: { fileSize: MAX_MEDIA_BYTES, files: 1, fields: 40, fieldSize: 64 * 1024 },
        });
        for await (const part of parts) {
          if (part.type !== "file") {
            const previous = fields[part.fieldname];
            fields[part.fieldname] =
              previous === undefined
                ? part.value
                : [...(Array.isArray(previous) ? previous : [previous]), part.value];
            continue;
          }
          // Everything typed so far is checked before the file is kept.
          const key = randomUUID();
          try {
            const intake = intakeFrom(archiveId, fields, { provider: "web_upload", key });
            checkIntake(context, actor, intake);
            checkZone(context, actor, intake, fields);
          } catch (error) {
            part.file.resume();
            throw error;
          }
          staging = createStagingFolder(context);
          const path = join(staging, "original");
          await pipeline(part.file, createWriteStream(path));
          if (part.file.truncated) {
            throw new ArchivistError("media_too_large", "Files can be at most 100 MiB.", {
              field: "file",
            });
          }
          upload = { path, filename: part.filename, key };
        }
      } else {
        Object.assign(fields, (request.body as Fields | null) ?? {});
      }

      const driveLink = text(fields, "driveLink");
      if (Boolean(upload) === Boolean(driveLink)) {
        throw new ArchivistError(
          "invalid_input",
          "Upload one file or give one Google Drive link, not both or neither.",
          {
            field: "file",
          },
        );
      }
      const link = driveLink ? parseDriveLink(driveLink) : null;
      const intake = intakeFrom(
        archiveId,
        fields,
        link
          ? { provider: "drive", key: link.fileId, url: link.url, resourceKey: link.resourceKey }
          : { provider: "web_upload", key: upload!.key },
      );
      checkIntake(context, actor, intake);
      checkZone(context, actor, intake, fields);

      let file: string;
      let filename: string;
      if (link) {
        const { store } = openForActor(context, actor, archiveId);
        const existing = findArtifactBySource(store.db, "drive", link.fileId);
        if (existing) return reply.send(await duplicateReply(actor, archiveId, intake, existing));
        staging = createStagingFolder(context);
        file = join(staging, "original");
        const drive = new DriveClient({ apiKey: options.driveApiKey, fetch: options.fetch });
        filename = (await drive.metadata(link)).name;
        await drive.download(link, file);
      } else {
        file = upload!.path;
        filename = upload!.filename;
      }
      const media = await stageMedia(context, { file, originalFilename: filename });
      const result = createArtifact(context, actor, { ...intake, media });
      if (result.status === "duplicate") {
        return reply.send(await duplicateReply(actor, archiveId, intake, result.artifact));
      }
      return reply.status(201).send({
        status: "created",
        artifact: result.artifact,
        announcement: await announce(archiveId, result.artifact),
      });
    } finally {
      if (staging) discardStaging(context, staging);
    }
  });

  // Applies the ticked differences. Links are only added, and the original file is never replaced.
  scope.post<{ Params: Params & { token: string } }>(
    `${base}/artifacts/reviews/:token/apply`,
    async (request) => {
      const { actor } = await auth.requireActor(request);
      openForActor(context, actor, request.params.archiveId);
      const body = (request.body ?? {}) as Fields;
      const selected = body.selected;
      if (!Array.isArray(selected) || !selected.every((item) => typeof item === "string")) {
        throw new ArchivistError("invalid_input", "Choose the differences to apply as a list.", {
          field: "selected",
        });
      }
      const review = reviews.take(request.params.token, actor.userId, request.params.archiveId);
      return applyDuplicateReview(context, actor, {
        intake: review.intake,
        artifactId: review.artifactId,
        expectedVersion: review.version,
        selected,
      });
    },
  );

  /*
   * Pictures for records: an account avatar or a server icon, dated when it
   * was seen, or a current fallback picture for a character or icon for a
   * group chat. The fields come before the file, like an artifact upload.
   */
  scope.post<{ Params: Params & { kind: string; id: string } }>(
    `${base}/entities/:kind/:id/picture`,
    async (request, reply) => {
      const { actor } = await auth.requireActor(request);
      const { archiveId, kind, id } = request.params;
      openForActor(context, actor, archiveId);
      if (!request.isMultipart()) {
        throw new ArchivistError("invalid_input", "Send the picture as a form upload.", {
          field: "file",
        });
      }
      const fields: Fields = {};
      let staging: string | null = null;
      try {
        let staged: StagedMedia | null = null;
        for await (const part of request.parts({
          limits: { fileSize: MAX_MEDIA_BYTES, files: 1, fields: 10, fieldSize: 4096 },
        })) {
          if (part.type !== "file") {
            if (staged) {
              throw new ArchivistError("invalid_input", "Send picture fields before the file.", {
                field: part.fieldname,
              });
            }
            fields[part.fieldname] = part.value;
            continue;
          }
          const purpose = text(fields, "purpose");
          const allowed: Record<string, string> = {
            avatar: "account",
            server_icon: "server",
            fallback: "character",
            icon: "channel",
          };
          if (!purpose || allowed[purpose] !== kind) {
            part.file.resume();
            throw new ArchivistError(
              "invalid_input",
              "Choose what the picture is for: an avatar, a server icon, a fallback picture, or a group chat icon.",
              { field: "purpose" },
            );
          }
          staging = createStagingFolder(context);
          const path = join(staging, "original");
          await pipeline(part.file, createWriteStream(path));
          if (part.file.truncated) {
            throw new ArchivistError("media_too_large", "Pictures can be at most 100 MiB.", {
              field: "file",
            });
          }
          staged = await stageMedia(context, { file: path, originalFilename: part.filename });
          if (!staged.mimeType.startsWith("image/")) {
            throw new ArchivistError(
              "unsupported_media_type",
              "Pictures must be images, such as PNG, JPEG, WebP, or GIF.",
              { field: "file" },
            );
          }
        }
        if (!staged)
          throw new ArchivistError("invalid_input", "Choose a picture to upload.", {
            field: "file",
          });
        const purpose = text(fields, "purpose")!;
        if (purpose === "avatar" || purpose === "server_icon") {
          addHistory(context, actor, {
            archiveId,
            kind: purpose,
            parentId: id,
            expectedVersion: fields.expectedVersion,
            date: text(fields, "date"),
            media: staged,
          });
        } else {
          setPicture(context, actor, {
            archiveId,
            kind: purpose === "fallback" ? "character" : "channel",
            id,
            expectedVersion: fields.expectedVersion,
            media: staged,
          });
        }
        return reply.status(201).send(entityView(context, actor, { archiveId, kind, id }));
      } finally {
        if (staging) discardStaging(context, staging);
      }
    },
  );

  /* The archive's logs channel */

  scope.get<{ Params: Params }>(`${base}/artifact-logs-channel`, async (request) => {
    const { actor } = await auth.requireActor(request);
    openForActor(context, actor, request.params.archiveId);
    return { channel: getAnnouncementChannel(context, request.params.archiveId) };
  });

  scope.put<{ Params: Params }>(`${base}/artifact-logs-channel`, async (request) => {
    const { actor } = await auth.requireActor(request);
    openForActor(context, actor, request.params.archiveId);
    const channelId = ((request.body ?? {}) as Fields).channelId;
    if (!options.checkAnnouncementChannel) {
      throw new ArchivistError(
        "dependency_unavailable",
        "The bot is not connected, so the channel cannot be checked. Use /set-artifact-logs-channel in Discord.",
      );
    }
    if (typeof channelId !== "string" || !/^\d{17,20}$/.test(channelId)) {
      throw new ArchivistError("invalid_input", "Give the channel's Discord ID.", {
        field: "channelId",
      });
    }
    const { guildId } = await options.checkAnnouncementChannel(actor.userId, channelId);
    return {
      channel: setAnnouncementChannel(context, actor, {
        archiveId: request.params.archiveId,
        guildId,
        channelId,
      }),
    };
  });

  scope.delete<{ Params: Params }>(`${base}/artifact-logs-channel`, async (request) => {
    const { actor } = await auth.requireActor(request);
    return removeAnnouncementChannel(context, actor, { archiveId: request.params.archiveId });
  });
}
