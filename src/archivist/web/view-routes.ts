import type { FastifyInstance } from "fastify";
import type { ArchivistContext } from "../context.js";
import { readEventFilters, readFilters } from "../queries.js";
import { dayCounts, graphView, periodDays, timelineView } from "../views.js";
import type { Auth } from "./auth.js";

/**
 * View data under `/api/archives/:archiveId`. Each takes the shared filters.
 * For the timeline, calendar, and heatmap, the requested window or period
 * sets the days, so the shared date range is not applied on top of it.
 */

type Request = { Params: { archiveId: string }; Querystring: Record<string, unknown> };

function windowless(query: Record<string, unknown>) {
  return {
    filters: { ...readFilters(query), fromDay: null, toDay: null },
    eventFilters: { ...readEventFilters(query), fromDay: null, toDay: null },
  };
}

export function registerViewRoutes(
  scope: FastifyInstance,
  context: ArchivistContext,
  auth: Auth,
): void {
  const base = "/api/archives/:archiveId";

  scope.get<Request>(`${base}/timeline`, async (request) => {
    const { actor } = await auth.requireActor(request);
    return timelineView(context, actor, {
      archiveId: request.params.archiveId,
      fromDay: request.query.fromDay,
      toDay: request.query.toDay,
      bucket: request.query.bucket,
      ...windowless(request.query),
    });
  });

  scope.get<Request>(`${base}/calendar`, async (request) => {
    const { actor } = await auth.requireActor(request);
    return dayCounts(context, actor, {
      archiveId: request.params.archiveId,
      ...periodDays(request.query.month, "month"),
      ...windowless(request.query),
    });
  });

  scope.get<Request>(`${base}/heatmap`, async (request) => {
    const { actor } = await auth.requireActor(request);
    return dayCounts(context, actor, {
      archiveId: request.params.archiveId,
      ...periodDays(request.query.year, "year"),
      ...windowless(request.query),
    });
  });

  scope.get<Request>(`${base}/graph`, async (request) => {
    const { actor } = await auth.requireActor(request);
    return graphView(context, actor, {
      archiveId: request.params.archiveId,
      ...readFiltersBoth(request.query),
    });
  });
}

function readFiltersBoth(query: Record<string, unknown>) {
  return { filters: readFilters(query), eventFilters: readEventFilters(query) };
}
