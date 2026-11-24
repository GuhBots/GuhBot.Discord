import type { FastifyInstance, FastifyRequest } from "fastify";
import { deleteArtifact, updateArtifact } from "../artifacts.js";
import { flagForResearch, updateGapCard } from "../board.js";
import type { Actor, ArchivistContext } from "../context.js";
import { archiveDay, needsZoneConfirmation, parseDateInput } from "../dates.js";
import {
  createAccount,
  createCharacter,
  createChannel,
  createServer,
  deleteEntity,
  type EntityKind,
  updateEntity,
} from "../entities.js";
import { entityView } from "../entity-views.js";
import { ArchivistError } from "../errors.js";
import { createEvent, deleteEvent, updateEvent } from "../events.js";
import { addHistory, removeHistory } from "../history.js";
import { mergeCharacters, previewMerge } from "../merge.js";
import { getDateOrder, inputTimeZone } from "../preferences.js";
import { openForActor } from "../records.js";
import { createRequest, deleteRequest, updateRequest } from "../requests.js";
import type { Auth } from "./auth.js";

/**
 * Routes that change an archive, under `/api/archives/:archiveId`. Bodies
 * are JSON objects whose fields match the shared operations' inputs, and
 * each change carries the `expectedVersion` the contributor last saw. The
 * archive and record come from the address, never from the body. Creating
 * answers 201 with the record, editing 200 with the record, and deleting 204.
 */

type Params = { archiveId: string; id: string; kind: string };
type Body = Record<string, unknown>;

const ENTITY_KINDS: EntityKind[] = ["character", "account", "server", "channel"];

function bodyOf(request: FastifyRequest): Body {
  const body = request.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ArchivistError("invalid_input", "Send the fields as a JSON object.");
  }
  return body as Body;
}

/** The version a deletion expects, from the body or the query. */
function expectedVersionOf(request: FastifyRequest): unknown {
  return bodyOf(request).expectedVersion ?? (request.query as Body).expectedVersion;
}

function entityKind(value: string): EntityKind {
  if (!ENTITY_KINDS.includes(value as EntityKind)) {
    throw new ArchivistError("not_found", "There is nothing at that address.");
  }
  return value as EntityKind;
}

/** Fields a request edit may not carry, because moving between buckets has its own route. */
const STATUS_FIELDS = ["status", "foundArtifacts", "unrecoverableReason"];

export function registerChangeRoutes(
  scope: FastifyInstance,
  context: ArchivistContext,
  auth: Auth,
): void {
  const actorOf = async (request: FastifyRequest): Promise<Actor> =>
    (await auth.requireActor(request)).actor;
  const base = "/api/archives/:archiveId";

  /* Entities */

  scope.post<{ Params: Params }>(`${base}/entities/:kind`, async (request, reply) => {
    const actor = await actorOf(request);
    const kind = entityKind(request.params.kind);
    const input = { ...bodyOf(request), archiveId: request.params.archiveId };
    const created =
      kind === "character"
        ? createCharacter(context, actor, input as Parameters<typeof createCharacter>[2])
        : kind === "account"
          ? createAccount(context, actor, input as Parameters<typeof createAccount>[2])
          : kind === "server"
            ? createServer(context, actor, input as Parameters<typeof createServer>[2])
            : createChannel(context, actor, input as Parameters<typeof createChannel>[2]);
    return reply
      .status(201)
      .send(
        entityView(context, actor, { archiveId: request.params.archiveId, kind, id: created.id }),
      );
  });

  scope.patch<{ Params: Params }>(`${base}/entities/:kind/:id`, async (request) => {
    const actor = await actorOf(request);
    const kind = entityKind(request.params.kind);
    const { archiveId, id } = request.params;
    const updated = updateEntity(context, actor, {
      ...bodyOf(request),
      archiveId,
      kind,
      id,
    } as Parameters<typeof updateEntity>[2]);
    return entityView(context, actor, { archiveId, kind, id: updated.id });
  });

  scope.delete<{ Params: Params }>(`${base}/entities/:kind/:id`, async (request, reply) => {
    deleteEntity(context, await actorOf(request), {
      archiveId: request.params.archiveId,
      kind: entityKind(request.params.kind),
      id: request.params.id,
      expectedVersion: expectedVersionOf(request),
    });
    return reply.status(204).send();
  });

  // Dated history is edited through its parent, with the parent's version.
  scope.post<{ Params: Params }>(`${base}/entities/:kind/:id/history`, async (request, reply) => {
    const actor = await actorOf(request);
    const kind = entityKind(request.params.kind);
    const { archiveId, id } = request.params;
    const entry = addHistory(context, actor, {
      ...bodyOf(request),
      archiveId,
      parentId: id,
    } as Parameters<typeof addHistory>[2]);
    return reply
      .status(201)
      .send({ entry, record: entityView(context, actor, { archiveId, kind, id }) });
  });

  scope.delete<{ Params: Params & { entryId: string } }>(
    `${base}/entities/:kind/:id/history/:entryId`,
    async (request) => {
      const actor = await actorOf(request);
      const kind = entityKind(request.params.kind);
      const { archiveId, id, entryId } = request.params;
      const query = request.query as Body;
      removeHistory(context, actor, {
        archiveId,
        kind: bodyOf(request).historyKind ?? query.historyKind,
        parentId: id,
        entryId,
        expectedVersion: expectedVersionOf(request),
      } as Parameters<typeof removeHistory>[2]);
      return entityView(context, actor, { archiveId, kind, id });
    },
  );

  scope.post<{ Params: Params }>(`${base}/entities/character/merge/preview`, async (request) => {
    const body = bodyOf(request);
    return previewMerge(context, await actorOf(request), {
      archiveId: request.params.archiveId,
      survivorId: body.survivorId,
      mergedId: body.mergedId,
    });
  });

  scope.post<{ Params: Params }>(`${base}/entities/character/merge`, async (request) => {
    const actor = await actorOf(request);
    const merged = mergeCharacters(context, actor, {
      ...bodyOf(request),
      archiveId: request.params.archiveId,
    } as Parameters<typeof mergeCharacters>[2]);
    return entityView(context, actor, {
      archiveId: request.params.archiveId,
      kind: "character",
      id: merged.id,
    });
  });

  /* Artifacts */

  scope.patch<{ Params: Params }>(`${base}/artifacts/:id`, async (request) => {
    return updateArtifact(context, await actorOf(request), {
      ...bodyOf(request),
      archiveId: request.params.archiveId,
      id: request.params.id,
    } as Parameters<typeof updateArtifact>[2]);
  });

  scope.delete<{ Params: Params }>(`${base}/artifacts/:id`, async (request, reply) => {
    deleteArtifact(context, await actorOf(request), {
      archiveId: request.params.archiveId,
      id: request.params.id,
      expectedVersion: expectedVersionOf(request),
    });
    return reply.status(204).send();
  });

  /* Events */

  scope.post<{ Params: Params }>(`${base}/events`, async (request, reply) => {
    const event = createEvent(context, await actorOf(request), {
      ...bodyOf(request),
      archiveId: request.params.archiveId,
    } as Parameters<typeof createEvent>[2]);
    return reply.status(201).send(event);
  });

  scope.patch<{ Params: Params }>(`${base}/events/:id`, async (request) =>
    updateEvent(context, await actorOf(request), {
      ...bodyOf(request),
      archiveId: request.params.archiveId,
      id: request.params.id,
    } as Parameters<typeof updateEvent>[2]),
  );

  scope.delete<{ Params: Params }>(`${base}/events/:id`, async (request, reply) => {
    deleteEvent(context, await actorOf(request), {
      archiveId: request.params.archiveId,
      id: request.params.id,
      expectedVersion: expectedVersionOf(request),
    });
    return reply.status(204).send();
  });

  /* Missing-media requests */

  scope.post<{ Params: Params }>(`${base}/requests`, async (request, reply) => {
    const created = createRequest(context, await actorOf(request), {
      ...bodyOf(request),
      archiveId: request.params.archiveId,
    } as Parameters<typeof createRequest>[2]);
    return reply.status(201).send(created);
  });

  scope.patch<{ Params: Params }>(`${base}/requests/:id`, async (request) => {
    const body = bodyOf(request);
    const moved = STATUS_FIELDS.filter((field) => field in body);
    if (moved.length) {
      throw new ArchivistError(
        "invalid_input",
        "Move a request between buckets with its status route.",
        {
          field: moved[0],
        },
      );
    }
    return updateRequest(context, await actorOf(request), {
      ...body,
      archiveId: request.params.archiveId,
      id: request.params.id,
    } as Parameters<typeof updateRequest>[2]);
  });

  // Needed, Resolved with the artifacts that have the media, or Unrecoverable with a reason.
  scope.post<{ Params: Params }>(`${base}/requests/:id/status`, async (request) => {
    const body = bodyOf(request);
    return updateRequest(context, await actorOf(request), {
      archiveId: request.params.archiveId,
      id: request.params.id,
      expectedVersion: body.expectedVersion,
      status: body.status,
      foundArtifacts: body.foundArtifacts,
      unrecoverableReason: body.unrecoverableReason,
    });
  });

  scope.delete<{ Params: Params }>(`${base}/requests/:id`, async (request, reply) => {
    deleteRequest(context, await actorOf(request), {
      archiveId: request.params.archiveId,
      id: request.params.id,
      expectedVersion: expectedVersionOf(request),
    });
    return reply.status(204).send();
  });

  /* The board */

  scope.post<{ Params: Params }>(`${base}/backlog/flags`, async (request, reply) => {
    const card = flagForResearch(context, await actorOf(request), {
      ...bodyOf(request),
      archiveId: request.params.archiveId,
    } as Parameters<typeof flagForResearch>[2]);
    return reply.status(201).send(card);
  });

  scope.patch<{ Params: Params }>(`${base}/backlog/:id`, async (request) =>
    updateGapCard(context, await actorOf(request), {
      ...bodyOf(request),
      archiveId: request.params.archiveId,
      id: request.params.id,
    } as Parameters<typeof updateGapCard>[2]),
  );

  /* Dates */

  /**
   * How a typed date will be read, with the contributor's own timezone and
   * date order, so a form can show it before saving. Discord confirms a
   * time typed without a zone; the website shows this instead.
   */
  scope.get<{ Params: Params; Querystring: Body }>(`${base}/date-preview`, async (request) => {
    const actor = await actorOf(request);
    const { details } = openForActor(context, actor, request.params.archiveId);
    const order = getDateOrder(context, actor);
    const text = request.query.text;
    const value = parseDateInput(
      "text",
      text,
      inputTimeZone(context, actor, details.timezone),
      order,
    );
    return {
      value,
      archiveDay: archiveDay(value, details.timezone),
      assumedZone: needsZoneConfirmation(text, order),
    };
  });
}
