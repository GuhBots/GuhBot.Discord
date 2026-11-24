import { existsSync } from "node:fs";
import type {} from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ArchivistContext } from "../context.js";
import { ArchivistError } from "../errors.js";
import { insideArchive } from "../paths.js";
import { openForActor } from "../records.js";
import type { Auth } from "./auth.js";

/**
 * Media and the edit log for members. Every request checks current access
 * first, including media that no record uses any more, which archives keep.
 * Files are served by their stored path inside the archive folder, never a
 * path from the request, with byte ranges so videos can seek. Responses
 * are not cached by shared caches, and browsers revalidate, so access is
 * checked again.
 */

interface MediaRow {
  original_path: string;
  preview_path: string | null;
  original_filename: string;
  mime_type: string;
}

/** A Content-Disposition header that keeps any file name safe. */
function disposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function registerMediaRoutes(
  scope: FastifyInstance,
  context: ArchivistContext,
  auth: Auth,
): void {
  type MediaRequest = {
    Params: { archiveId: string; mediaId: string };
    Querystring: { download?: string };
  };

  async function sendMedia(
    request: FastifyRequest<MediaRequest>,
    reply: FastifyReply,
    preview: boolean,
  ) {
    const { actor } = await auth.requireActor(request);
    const { store } = openForActor(context, actor, request.params.archiveId);
    const row = store.db
      .prepare(
        "SELECT original_path, preview_path, original_filename, mime_type FROM media WHERE id = ?",
      )
      .get(request.params.mediaId) as MediaRow | undefined;
    const stored = preview ? row?.preview_path : row?.original_path;
    if (!row || !stored) throw new ArchivistError("not_found", "That file is not in this archive.");
    if (!existsSync(insideArchive(store.folder, stored))) {
      throw new ArchivistError(
        "dependency_unavailable",
        "That file is missing from the archive folder. Tell the bot owner.",
      );
    }
    reply.header("cache-control", "private, no-cache");
    reply.header("content-type", preview ? "image/webp" : row.mime_type);
    reply.header(
      "content-disposition",
      disposition(
        request.query.download ? "attachment" : "inline",
        preview ? `${row.original_filename}.preview.webp` : row.original_filename,
      ),
    );
    // The file server would mark it public; members' media must stay private.
    return reply.sendFile(stored, store.folder, { cacheControl: false });
  }

  scope.get<MediaRequest>("/api/archives/:archiveId/media/:mediaId", (request, reply) =>
    sendMedia(request, reply, false),
  );
  scope.get<MediaRequest>("/api/archives/:archiveId/media/:mediaId/preview", (request, reply) =>
    sendMedia(request, reply, true),
  );

  scope.get<{ Params: { archiveId: string } }>(
    "/api/archives/:archiveId/edit-log",
    async (request, reply) => {
      const { actor } = await auth.requireActor(request);
      const { store, details } = openForActor(context, actor, request.params.archiveId);
      reply.header("cache-control", "private, no-store");
      reply.header("content-type", "text/plain; charset=utf-8");
      reply.header("content-disposition", disposition("attachment", `${details.name} edits.log`));
      return reply.sendFile("edits.log", store.folder, { cacheControl: false });
    },
  );
}
