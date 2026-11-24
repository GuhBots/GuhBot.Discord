import type { FastifyInstance } from "fastify";
import { getArchive, listArchives } from "../archives.js";
import { getArtifact } from "../artifacts.js";
import { type GapStatus, listGapCards } from "../board.js";
import type { ArchivistContext } from "../context.js";
import { calendarDay } from "../dates.js";
import type { EntityKind } from "../entities.js";
import { entityView, listCharacters, listPlaces } from "../entity-views.js";
import { ArchivistError } from "../errors.js";
import { getEvent } from "../events.js";
import {
  listArtifacts,
  listEvents,
  readEventFilters,
  readFilters,
  readLimit,
  readSort,
} from "../queries.js";
import { openForActor } from "../records.js";
import { getRequest, listRequests, type RequestStatus } from "../requests.js";
import { searchArtifacts, searchEntities, searchEvents } from "../search.js";
import type { Auth } from "./auth.js";

/**
 * Read routes under `/api/archives`. Each one checks the signed-in
 * contributor's current access through the shared operations, so removing
 * someone from a whitelist takes effect on their next request.
 */

type Query = Record<string, unknown>;
type ArchiveParams = { archiveId: string };

const STATUSES = ["needed", "resolved", "unrecoverable"] as const;
const ENTITY_KINDS: EntityKind[] = ["character", "account", "server", "channel"];

function status(value: unknown): (typeof STATUSES)[number] | undefined {
  if (value === undefined || value === "") return undefined;
  if (!STATUSES.includes(value as (typeof STATUSES)[number])) {
    throw new ArchivistError(
      "invalid_input",
      "Status must be needed, resolved, or unrecoverable.",
      {
        field: "status",
      },
    );
  }
  return value as (typeof STATUSES)[number];
}

function entityKind(value: string): EntityKind {
  if (!ENTITY_KINDS.includes(value as EntityKind)) {
    throw new ArchivistError("not_found", "There is nothing at that address.");
  }
  return value as EntityKind;
}

/** The day whose names and pictures to show, such as the timeline position. Latest when empty. */
function day(value: unknown): string | undefined {
  return value === undefined || value === "" ? undefined : calendarDay("day", value);
}

export function registerReadRoutes(
  scope: FastifyInstance,
  context: ArchivistContext,
  auth: Auth,
): void {
  const actorOf = async (request: Parameters<Auth["requireActor"]>[0]) =>
    (await auth.requireActor(request)).actor;

  scope.get("/api/archives", async (request) => ({
    archives: listArchives(context, await actorOf(request)),
  }));

  scope.get<{ Params: ArchiveParams }>("/api/archives/:archiveId", async (request) =>
    getArchive(context, await actorOf(request), request.params.archiveId),
  );

  scope.get<{ Params: ArchiveParams; Querystring: Query }>(
    "/api/archives/:archiveId/places",
    async (request) => ({
      places: listPlaces(context, await actorOf(request), {
        archiveId: request.params.archiveId,
        day: day(request.query.day),
      }),
    }),
  );

  scope.get<{ Params: ArchiveParams; Querystring: Query }>(
    "/api/archives/:archiveId/artifacts",
    async (request) =>
      listArtifacts(context, await actorOf(request), {
        archiveId: request.params.archiveId,
        filters: readFilters(request.query),
        sort: readSort(request.query.sort),
        limit: readLimit(request.query.limit),
        cursor: request.query.cursor,
      }),
  );

  scope.get<{ Params: ArchiveParams & { id: string } }>(
    "/api/archives/:archiveId/artifacts/:id",
    async (request) => getArtifact(context, await actorOf(request), request.params),
  );

  scope.get<{ Params: ArchiveParams; Querystring: Query }>(
    "/api/archives/:archiveId/events",
    async (request) =>
      listEvents(context, await actorOf(request), {
        archiveId: request.params.archiveId,
        filters: readEventFilters(request.query),
        limit: readLimit(request.query.limit),
        cursor: request.query.cursor,
      }),
  );

  scope.get<{ Params: ArchiveParams & { id: string } }>(
    "/api/archives/:archiveId/events/:id",
    async (request) => getEvent(context, await actorOf(request), request.params),
  );

  scope.get<{ Params: ArchiveParams & { kind: string }; Querystring: Query }>(
    "/api/archives/:archiveId/entities/:kind",
    async (request) => {
      const actor = await actorOf(request);
      const kind = entityKind(request.params.kind);
      const typed = request.query.q === undefined ? "" : String(request.query.q);
      if (kind === "character" && !typed) {
        return listCharacters(context, actor, {
          archiveId: request.params.archiveId,
          day: day(request.query.day),
          limit: request.query.limit,
          cursor: request.query.cursor,
        });
      }
      // Pickers search by name. They show the first matches, not every record.
      const { store } = openForActor(context, actor, request.params.archiveId);
      return {
        items: searchEntities(store.db, kind, typed, readLimit(request.query.limit)),
        next: null,
      };
    },
  );

  scope.get<{ Params: ArchiveParams & { kind: string; id: string } }>(
    "/api/archives/:archiveId/entities/:kind/:id",
    async (request) =>
      entityView(context, await actorOf(request), {
        archiveId: request.params.archiveId,
        kind: entityKind(request.params.kind),
        id: request.params.id,
      }),
  );

  scope.get<{ Params: ArchiveParams; Querystring: Query }>(
    "/api/archives/:archiveId/requests",
    async (request) => ({
      items: listRequests(context, await actorOf(request), {
        archiveId: request.params.archiveId,
        status: status(request.query.status) as RequestStatus | undefined,
      }),
    }),
  );

  scope.get<{ Params: ArchiveParams & { id: string } }>(
    "/api/archives/:archiveId/requests/:id",
    async (request) => getRequest(context, await actorOf(request), request.params),
  );

  scope.get<{ Params: ArchiveParams; Querystring: Query }>(
    "/api/archives/:archiveId/backlog",
    async (request) => ({
      items: listGapCards(context, await actorOf(request), {
        archiveId: request.params.archiveId,
        status: status(request.query.status) as GapStatus | undefined,
      }),
    }),
  );

  /** The top bar's search: a few matches of each kind. */
  scope.get<{ Params: ArchiveParams; Querystring: Query }>(
    "/api/archives/:archiveId/search",
    async (request) => {
      const { store } = openForActor(context, await actorOf(request), request.params.archiveId);
      const typed = request.query.q === undefined ? "" : String(request.query.q).trim();
      if (!typed) return { characters: [], accounts: [], places: [], artifacts: [], events: [] };
      if (typed.length > 200) {
        throw new ArchivistError("invalid_input", "Search for at most 200 characters.", {
          field: "q",
        });
      }
      const limit = 8;
      return {
        characters: searchEntities(store.db, "character", typed, limit),
        accounts: searchEntities(store.db, "account", typed, limit),
        places: [
          ...searchEntities(store.db, "server", typed, limit),
          ...searchEntities(store.db, "channel", typed, limit),
        ],
        artifacts: searchArtifacts(store.db, typed, limit),
        events: searchEvents(store.db, typed, limit),
      };
    },
  );
}
