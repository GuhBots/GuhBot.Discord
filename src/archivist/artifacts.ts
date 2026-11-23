import type Database from "better-sqlite3";
import type { Actor, ArchivistContext } from "./context.js";
import { calendarDay, type DateValue, parseDateInput } from "./dates.js";
import { insertDate, pruneDates, readDate, type StoredDate } from "./date-store.js";
import type { FieldChange } from "./edit-log.js";
import { ArchivistError } from "./errors.js";
import { discordId, newId, requiredText, TEXT_LIMITS, timestamp } from "./fields.js";
import { mediaPaths, placeStagedMedia, type StagedMedia } from "./media.js";
import { commitMutation, type Expectation } from "./mutations.js";
import { resolveShortId } from "./people.js";
import { inputTimeZone } from "./preferences.js";
import {
  type ArchiveSession,
  diffFields,
  idList,
  logEntry,
  notFoundRecord,
  openForActor,
  requireRecords,
} from "./records.js";
import { expectedVersionValue, staleVersion } from "./versions.js";

/**
 * Artifacts: one original file each, with a description, dates, and links to
 * people, accounts, servers, channels, and events in the same archive.
 *
 * Dates are kept separately and never overwrite each other. The selected
 * date is the exact occurrence if known, then the estimate, then the date
 * embedded in the file. Clearing an override falls back to the next one.
 */

export type SourceProvider = "drive" | "discord_attachment" | "web_upload";

export interface SourceInput {
  provider: SourceProvider;
  key: string;
  url?: string | null;
  resourceKey?: string | null;
}

export interface LinkInput {
  people?: unknown;
  accounts?: unknown;
  servers?: unknown;
  channels?: unknown;
  events?: unknown;
}

const LINKS = {
  people: { table: "artifact_people", column: "character_id", target: "characters" },
  accounts: { table: "artifact_accounts", column: "account_id", target: "accounts" },
  servers: { table: "artifact_servers", column: "server_id", target: "servers" },
  channels: { table: "artifact_channels", column: "channel_id", target: "channels" },
  events: { table: "artifact_events", column: "event_id", target: "events" },
} as const;

type LinkKind = keyof typeof LINKS;
const LINK_KINDS = Object.keys(LINKS) as LinkKind[];

type Links = Record<LinkKind, string[]>;

export type DateBasis = "exact" | "estimated" | "file";

export interface ArtifactDetails {
  id: string;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  description: string;
  source: { provider: SourceProvider; key: string; url: string | null; resourceKey: string | null };
  submission: { guildId: string | null; channelId: string | null; messageId: string | null };
  media: {
    id: string;
    originalFilename: string;
    mimeType: string;
    byteLength: number;
    sha256: string;
    hasPreview: boolean;
    readable: boolean;
    fileDateStatus: string;
  };
  dates: {
    /** `basis` holds a reason given before exact dates stopped needing one. */
    exact: { date: StoredDate; basis: string | null } | null;
    estimated: { date: StoredDate; reason: string } | null;
    file: StoredDate | null;
    selected: { basis: DateBasis; date: StoredDate } | null;
  };
  /** Someone in it has not been identified yet, which puts it on the research board. */
  unidentifiedPeople: boolean;
  links: Links;
}

interface ArtifactRow {
  id: string;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  media_id: string;
  description: string;
  source_provider: SourceProvider;
  source_key: string;
  source_url: string | null;
  source_resource_key: string | null;
  submission_guild_id: string | null;
  submission_channel_id: string | null;
  submission_message_id: string | null;
  exact_date_id: string | null;
  exact_basis: string | null;
  estimated_date_id: string | null;
  estimate_reason: string | null;
  file_date_id: string | null;
  selected_date_id: string | null;
  unidentified_people: 0 | 1;
  original_filename: string;
  mime_type: string;
  byte_length: number;
  sha256: string;
  preview_path: string | null;
  metadata_json: string;
}

function readLinks(db: Database.Database, artifactId: string): Links {
  const links = {} as Links;
  for (const kind of LINK_KINDS) {
    const { table, column } = LINKS[kind];
    links[kind] = (
      db
        .prepare(`SELECT ${column} AS id FROM ${table} WHERE artifact_id = ? ORDER BY ${column}`)
        .all(artifactId) as { id: string }[]
    ).map((row) => row.id);
  }
  return links;
}

/** Reads an artifact with its media, dates, and links. */
export function readArtifact(db: Database.Database, id: string): ArtifactDetails | undefined {
  const row = db
    .prepare(
      `SELECT a.*, m.original_filename, m.mime_type, m.byte_length, m.sha256, m.preview_path, m.metadata_json
       FROM artifacts a JOIN media m ON m.id = a.media_id WHERE a.id = ?`,
    )
    .get(id) as ArtifactRow | undefined;
  if (!row) return undefined;
  const metadata = JSON.parse(row.metadata_json) as {
    readable?: boolean;
    fileDate?: { status?: string };
  };
  const exact = readDate(db, row.exact_date_id);
  const estimated = readDate(db, row.estimated_date_id);
  const file = readDate(db, row.file_date_id);
  const selectedDate = readDate(db, row.selected_date_id);
  const basis: DateBasis | null =
    row.selected_date_id === null
      ? null
      : row.selected_date_id === row.exact_date_id
        ? "exact"
        : row.selected_date_id === row.estimated_date_id
          ? "estimated"
          : "file";
  return {
    id: row.id,
    version: row.version,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    description: row.description,
    source: {
      provider: row.source_provider,
      key: row.source_key,
      url: row.source_url,
      resourceKey: row.source_resource_key,
    },
    submission: {
      guildId: row.submission_guild_id,
      channelId: row.submission_channel_id,
      messageId: row.submission_message_id,
    },
    media: {
      id: row.media_id,
      originalFilename: row.original_filename,
      mimeType: row.mime_type,
      byteLength: row.byte_length,
      sha256: row.sha256,
      hasPreview: row.preview_path !== null,
      readable: metadata.readable ?? true,
      fileDateStatus: metadata.fileDate?.status ?? "absent",
    },
    dates: {
      exact: exact ? { date: exact, basis: row.exact_basis } : null,
      estimated: estimated ? { date: estimated, reason: row.estimate_reason! } : null,
      file,
      selected: basis && selectedDate ? { basis, date: selectedDate } : null,
    },
    unidentifiedPeople: row.unidentified_people === 1,
    links: readLinks(db, row.id),
  };
}

/** Finds the active artifact for a source, if one exists. */
export function findArtifactBySource(
  db: Database.Database,
  provider: SourceProvider,
  key: string,
): ArtifactDetails | undefined {
  const row = db
    .prepare("SELECT id FROM artifacts WHERE source_provider = ? AND source_key = ?")
    .get(provider, key) as { id: string } | undefined;
  return row ? readArtifact(db, row.id) : undefined;
}

const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const RESOURCE_KEY = /^[A-Za-z0-9_-]{1,200}$/;
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_URL_LENGTH = 2000;

function sourceValue(input: SourceInput): Required<SourceInput> {
  const invalid = (message: string) =>
    new ArchivistError("invalid_input", message, { field: "source" });
  const url = input.url ?? null;
  if (url !== null && (typeof url !== "string" || url.length > MAX_URL_LENGTH)) {
    throw invalid("The source link is too long.");
  }
  switch (input.provider) {
    case "drive":
      if (!DRIVE_ID.test(input.key)) throw invalid("That is not a Google Drive file ID.");
      if (input.resourceKey && !RESOURCE_KEY.test(input.resourceKey)) {
        throw invalid("That is not a Google Drive resource key.");
      }
      return { provider: "drive", key: input.key, url, resourceKey: input.resourceKey ?? null };
    case "discord_attachment":
      return {
        provider: "discord_attachment",
        key: discordId("source", input.key),
        url,
        resourceKey: null,
      };
    case "web_upload":
      if (!UPLOAD_ID.test(input.key)) throw invalid("Web uploads need a generated upload ID.");
      return { provider: "web_upload", key: input.key, url: null, resourceKey: null };
    default:
      throw invalid("Unknown source provider.");
  }
}

function flagValue(field: string, value: unknown): boolean {
  if (typeof value === "boolean") return value;
  throw new ArchivistError("invalid_input", `${field} must be true or false.`, { field });
}

/** An exact date needs no written basis. Only estimates need a reason. */
interface ExactInput {
  value: DateValue;
}

interface EstimateInput {
  value: DateValue;
  reason: string;
}

function exactValue(
  session: ArchiveSession,
  context: ArchivistContext,
  actor: Actor,
  value: unknown,
): ExactInput {
  const zone = inputTimeZone(context, actor, session.details.timezone);
  return { value: parseDateInput("exactDate", value, zone) };
}

function estimateValue(input: { day: unknown; reason: unknown }): EstimateInput {
  const day = calendarDay("estimatedDate", input.day);
  return {
    value: { kind: "day", originalText: day, calendarDay: day },
    reason: requiredText("estimateReason", input.reason, TEXT_LIMITS.reason),
  };
}

function linksValue(input: LinkInput | undefined, db: Database.Database): Links {
  const links = {} as Links;
  for (const kind of LINK_KINDS) {
    links[kind] = idList(kind, input?.[kind]);
    requireRecords(db, LINKS[kind].target, kind, links[kind]);
  }
  return links;
}

function insertLinks(db: Database.Database, artifactId: string, links: Partial<Links>): void {
  for (const kind of LINK_KINDS) {
    const { table, column } = LINKS[kind];
    const insert = db.prepare(
      `INSERT OR IGNORE INTO ${table} (artifact_id, ${column}) VALUES (?, ?)`,
    );
    for (const id of links[kind] ?? []) insert.run(artifactId, id);
  }
}

function dateText(date: { value: DateValue } | null): string | null {
  return date ? date.value.originalText : null;
}

export interface CreateArtifactInput {
  archiveId: unknown;
  description: unknown;
  media: StagedMedia;
  source: SourceInput;
  submission?: { guildId?: unknown; channelId?: unknown; messageId?: unknown };
  /** The exact date as typed. */
  exactDate?: unknown;
  estimatedDate?: { day: unknown; reason: unknown } | null;
  links?: LinkInput;
}

export type CreateArtifactResult =
  | { status: "created"; artifact: ArtifactDetails }
  | { status: "duplicate"; artifact: ArtifactDetails };

/**
 * Archives a staged file as a new artifact. If the same source is already in
 * the archive, nothing changes and the existing artifact is returned for
 * duplicate review. The caller discards the staging folder afterward.
 */
/** Everything an intake supplies except the file, as the contributor typed it. */
export type IntakeInput = Omit<CreateArtifactInput, "media">;

/** An intake after validation. */
export interface CheckedIntake {
  session: ArchiveSession;
  source: Required<SourceInput>;
  description: string;
  exact: ExactInput | null;
  estimate: EstimateInput | null;
  links: Links;
  submission: { guildId: string | null; channelId: string | null; messageId: string | null };
}

/**
 * Validates an intake without its file, so an adapter can refuse bad input
 * before downloading anything. Creating the artifact repeats these checks.
 */
export function checkIntake(
  context: ArchivistContext,
  actor: Actor,
  input: IntakeInput,
): CheckedIntake {
  const session = openForActor(context, actor, input.archiveId);
  const source = sourceValue(input.source);
  const description = requiredText("description", input.description, TEXT_LIMITS.description);
  const exact =
    input.exactDate !== undefined && input.exactDate !== null
      ? exactValue(session, context, actor, input.exactDate)
      : null;
  const estimate = input.estimatedDate ? estimateValue(input.estimatedDate) : null;
  const links = linksValue(input.links, session.store.db);
  const submission = {
    guildId: input.submission?.guildId ? discordId("guildId", input.submission.guildId) : null,
    channelId: input.submission?.channelId
      ? discordId("channelId", input.submission.channelId)
      : null,
    messageId: input.submission?.messageId
      ? discordId("messageId", input.submission.messageId)
      : null,
  };
  return {
    session,
    source,
    description,
    exact,
    estimate,
    links,
    submission,
  };
}

export function createArtifact(
  context: ArchivistContext,
  actor: Actor,
  input: CreateArtifactInput,
): CreateArtifactResult {
  const session = openForActor(context, actor, input.archiveId);
  const { store } = session;
  const existing = findArtifactBySource(store.db, input.source.provider, input.source.key);
  if (existing) return { status: "duplicate", artifact: existing };
  const { source, description, exact, estimate, links, submission } = checkIntake(
    context,
    actor,
    input,
  );

  const media = input.media;
  const artifactId = newId();
  const mediaId = newId();
  const paths = mediaPaths(mediaId, media.extension, media.previewFile !== null);
  const now = timestamp(context.now());
  const timezone = session.details.timezone;

  const changes: Record<string, FieldChange> = {
    description: { old: null, new: description },
    source: { old: null, new: { provider: source.provider, key: source.key, url: source.url } },
    media: { old: null, new: { id: mediaId, filename: media.originalFilename } },
  };
  if (exact) {
    changes.exactDate = {
      old: null,
      new: { date: dateText(exact), as: interpreted(exact.value) },
    };
  }
  if (estimate) {
    changes.estimatedDate = {
      old: null,
      new: { date: dateText(estimate), reason: estimate.reason },
    };
  }
  if (media.fileDate.value) {
    changes.fileDate = { old: null, new: media.fileDate.value.originalText };
  }
  for (const kind of LINK_KINDS) {
    if (links[kind].length > 0) changes[kind] = { old: null, new: links[kind] };
  }

  commitMutation(store, {
    expectations: [{ table: "artifacts", id: artifactId, state: "present" }],
    newFiles: [paths.original, ...(paths.preview ? [paths.preview] : [])],
    placeFiles: () => placeStagedMedia(store.folder, media, paths),
    apply(db) {
      db.prepare(
        `INSERT INTO media (id, original_path, preview_path, original_filename, mime_type, byte_length, sha256, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        mediaId,
        paths.original,
        paths.preview,
        media.originalFilename,
        media.mimeType,
        media.byteLength,
        media.sha256,
        JSON.stringify({ tags: media.tags, fileDate: media.fileDate, readable: media.readable }),
        now,
      );
      const exactId = exact ? insertDate(db, exact.value, timezone) : null;
      const estimateId = estimate ? insertDate(db, estimate.value, timezone) : null;
      const fileId = media.fileDate.value ? insertDate(db, media.fileDate.value, timezone) : null;
      db.prepare(
        `INSERT INTO artifacts (id, created_at, created_by, updated_at, media_id, description,
           source_provider, source_key, source_url, source_resource_key,
           submission_guild_id, submission_channel_id, submission_message_id,
           exact_date_id, estimated_date_id, estimate_reason, file_date_id, selected_date_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        artifactId,
        now,
        actor.userId,
        now,
        mediaId,
        description,
        source.provider,
        source.key,
        source.url,
        source.resourceKey,
        submission.guildId,
        submission.channelId,
        submission.messageId,
        exactId,
        estimateId,
        estimate?.reason ?? null,
        fileId,
        exactId ?? estimateId ?? fileId,
      );
      insertLinks(db, artifactId, links);
    },
    append: [logEntry(context, actor, "artifact", artifactId, changes)],
  });
  return { status: "created", artifact: readArtifact(store.db, artifactId)! };
}

export function getArtifact(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; id: unknown },
): ArtifactDetails {
  const { store } = openForActor(context, actor, input.archiveId);
  const artifact = readArtifact(
    store.db,
    resolveShortId(store.db, "artifacts", input.id, "artifact"),
  );
  if (!artifact) throw notFoundRecord("artifact");
  return artifact;
}

export interface UpdateArtifactInput {
  archiveId: unknown;
  id: unknown;
  expectedVersion: unknown;
  description?: unknown;
  /** The exact date as typed. Null clears it, falling back to the estimate or file date. */
  exactDate?: unknown;
  estimatedDate?: { day: unknown; reason: unknown } | null;
  unidentifiedPeople?: unknown;
  addLinks?: LinkInput;
  removeLinks?: LinkInput;
}

/** A date's text with how it was read, so the same text read in another zone counts as a change. */
function interpreted(value: DateValue): string {
  if (value.kind === "instant")
    return `${new Date(value.instantMs).toISOString()} (${value.timezone})`;
  return value.kind === "day" ? value.calendarDay : `${value.localDateTime} (zone unknown)`;
}

interface EditableState {
  description: string;
  exactDate: { date: string; as: string } | null;
  estimatedDate: { date: string; reason: string } | null;
  unidentifiedPeople: boolean;
  people: string[];
  accounts: string[];
  servers: string[];
  channels: string[];
  events: string[];
  [key: string]: unknown;
}

function editableState(artifact: ArtifactDetails): EditableState {
  return {
    description: artifact.description,
    exactDate: artifact.dates.exact
      ? {
          date: artifact.dates.exact.date.originalText,
          as: interpreted(artifact.dates.exact.date),
        }
      : null,
    estimatedDate: artifact.dates.estimated
      ? {
          date: artifact.dates.estimated.date.originalText,
          reason: artifact.dates.estimated.reason,
        }
      : null,
    unidentifiedPeople: artifact.unidentifiedPeople,
    ...artifact.links,
  };
}

const EDITABLE_FIELDS = [
  "description",
  "exactDate",
  "estimatedDate",
  "unidentifiedPeople",
  ...LINK_KINDS,
] as const;

/**
 * Edits an artifact the contributor saw at `expectedVersion`. If someone
 * else changed it since, nothing is saved and the current values are
 * returned in the error. Saving identical values changes nothing.
 */
export function updateArtifact(
  context: ArchivistContext,
  actor: Actor,
  input: UpdateArtifactInput,
): ArtifactDetails {
  const session = openForActor(context, actor, input.archiveId);
  const { store } = session;
  const id = String(input.id ?? "");
  const expectedVersion = expectedVersionValue(input.expectedVersion);
  const current = readArtifact(store.db, id);
  if (!current) throw notFoundRecord("artifact");

  const before = editableState(current);
  const after: EditableState = { ...before };
  let exact: ExactInput | null | undefined;
  let estimate: EstimateInput | null | undefined;
  if (input.description !== undefined) {
    after.description = requiredText("description", input.description, TEXT_LIMITS.description);
  }
  if (input.exactDate !== undefined) {
    exact = input.exactDate === null ? null : exactValue(session, context, actor, input.exactDate);
    after.exactDate = exact
      ? { date: exact.value.originalText, as: interpreted(exact.value) }
      : null;
  }
  if (input.estimatedDate !== undefined) {
    estimate = input.estimatedDate === null ? null : estimateValue(input.estimatedDate);
    after.estimatedDate = estimate
      ? { date: estimate.value.originalText, reason: estimate.reason }
      : null;
  }
  if (input.unidentifiedPeople !== undefined) {
    after.unidentifiedPeople = flagValue("unidentifiedPeople", input.unidentifiedPeople);
  }
  const additions = linksValue(input.addLinks, store.db);
  const removals = {} as Links;
  for (const kind of LINK_KINDS) {
    removals[kind] = idList(kind, input.removeLinks?.[kind]);
    const next = new Set(before[kind]);
    for (const linkId of removals[kind]) next.delete(linkId);
    for (const linkId of additions[kind]) next.add(linkId);
    after[kind] = [...next].sort();
  }

  const changes = diffFields(before, after, EDITABLE_FIELDS);
  if (current.version !== expectedVersion) {
    const attempted = Object.fromEntries(
      Object.keys(changes).map((field) => [field, before[field]]),
    );
    throw staleVersion("artifact", id, current.version, attempted);
  }
  if (Object.keys(changes).length === 0) return current;

  const timezone = session.details.timezone;
  const now = timestamp(context.now());
  commitMutation(store, {
    expectations: [{ table: "artifacts", id, version: current.version + 1 }],
    apply(db) {
      const row = db
        .prepare(
          "SELECT exact_date_id, exact_basis, estimated_date_id, estimate_reason, file_date_id FROM artifacts WHERE id = ?",
        )
        .get(id) as {
        exact_date_id: string | null;
        exact_basis: string | null;
        estimated_date_id: string | null;
        estimate_reason: string | null;
        file_date_id: string | null;
      };
      let exactId = row.exact_date_id;
      let exactBasis = row.exact_basis;
      if (exact !== undefined && changes.exactDate) {
        exactId = exact ? insertDate(db, exact.value, timezone) : null;
        // A basis from before it was dropped belongs to the replaced date.
        exactBasis = null;
      }
      let estimateId = row.estimated_date_id;
      let estimateReason = row.estimate_reason;
      if (estimate !== undefined && changes.estimatedDate) {
        estimateId = estimate ? insertDate(db, estimate.value, timezone) : null;
        estimateReason = estimate?.reason ?? null;
      }
      db.prepare(
        `UPDATE artifacts SET description = ?, exact_date_id = ?, exact_basis = ?,
           estimated_date_id = ?, estimate_reason = ?, selected_date_id = ?,
           unidentified_people = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`,
      ).run(
        after.description,
        exactId,
        exactBasis,
        estimateId,
        estimateReason,
        exactId ?? estimateId ?? row.file_date_id,
        after.unidentifiedPeople ? 1 : 0,
        now,
        id,
        current.version,
      );
      for (const kind of LINK_KINDS) {
        const { table, column } = LINKS[kind];
        const remove = db.prepare(`DELETE FROM ${table} WHERE artifact_id = ? AND ${column} = ?`);
        for (const linkId of removals[kind]) remove.run(id, linkId);
      }
      insertLinks(db, id, additions);
      pruneDates(db);
    },
    append: [logEntry(context, actor, "artifact", id, changes)],
  });
  return readArtifact(store.db, id)!;
}

/**
 * Permanently deletes an artifact. Its links, derived research cards, and own
 * log lines are removed. Its original file and preview stay in the archive.
 * A resolved missing-media request that loses its last found artifact
 * returns to Needed.
 */
export function deleteArtifact(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; id: unknown; expectedVersion: unknown },
): void {
  const { store } = openForActor(context, actor, input.archiveId);
  const id = String(input.id ?? "");
  const expectedVersion = expectedVersionValue(input.expectedVersion);
  const current = store.db.prepare("SELECT version FROM artifacts WHERE id = ?").get(id) as
    { version: number } | undefined;
  if (!current) throw notFoundRecord("artifact");
  if (current.version !== expectedVersion) throw staleVersion("artifact", id, current.version, {});

  const reopened = store.db
    .prepare(
      `SELECT r.id, r.version FROM research_requests r
       JOIN request_artifacts ra ON ra.request_id = r.id
       WHERE ra.artifact_id = ? AND r.status = 'resolved'
         AND (SELECT count(*) FROM request_artifacts x WHERE x.request_id = r.id) = 1`,
    )
    .all(id) as { id: string; version: number }[];
  const now = timestamp(context.now());
  const expectations: Expectation[] = [
    { table: "artifacts", id, state: "absent" },
    ...reopened.map((request) => ({
      table: "research_requests" as const,
      id: request.id,
      version: request.version + 1,
    })),
  ];

  commitMutation(store, {
    expectations,
    apply(db) {
      db.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
      const reopen = db.prepare(
        "UPDATE research_requests SET status = 'needed', version = version + 1, updated_at = ? WHERE id = ?",
      );
      for (const request of reopened) reopen.run(now, request.id);
      pruneDates(db);
    },
    append: reopened.map((request) =>
      logEntry(context, actor, "request", request.id, {
        status: { old: "resolved", new: "needed" },
        foundArtifacts: { old: [id], new: [] },
      }),
    ),
    removeRecords: [{ record: "artifact", id }],
  });
}

/** One change a duplicate submission proposes to the existing artifact. */
export interface DuplicateDifference {
  key: "description" | "exactDate" | "estimatedDate" | LinkKind;
  current: string;
  proposed: string;
}

function describeExact(text: string | null): string {
  return text ? `${text} (exact)` : "none";
}

function describeEstimate(estimate: { text: string; reason: string } | null): string {
  return estimate ? `${estimate.text} (estimated, ${estimate.reason})` : "none";
}

/**
 * Lists what a resubmission of an existing source would change. Only values
 * the contributor supplied are compared. Links can only be added, so a link
 * difference lists the records not linked yet.
 */
export function duplicateDifferences(
  existing: ArtifactDetails,
  intake: CheckedIntake,
): DuplicateDifference[] {
  const differences: DuplicateDifference[] = [];
  if (intake.description !== existing.description) {
    differences.push({
      key: "description",
      current: existing.description,
      proposed: intake.description,
    });
  }
  if (intake.exact) {
    const current = existing.dates.exact;
    const same = current !== null && interpreted(current.date) === interpreted(intake.exact.value);
    if (!same) {
      differences.push({
        key: "exactDate",
        current: describeExact(current?.date.originalText ?? null),
        proposed: describeExact(intake.exact.value.originalText),
      });
    }
  }
  if (intake.estimate) {
    const current = existing.dates.estimated;
    const same =
      current !== null &&
      current.date.originalText === intake.estimate.value.originalText &&
      current.reason === intake.estimate.reason;
    if (!same) {
      differences.push({
        key: "estimatedDate",
        current: describeEstimate(
          current && { text: current.date.originalText, reason: current.reason },
        ),
        proposed: describeEstimate({
          text: intake.estimate.value.originalText,
          reason: intake.estimate.reason,
        }),
      });
    }
  }
  for (const kind of LINK_KINDS) {
    const added = intake.links[kind].filter((id) => !existing.links[kind].includes(id));
    if (added.length > 0) differences.push({ key: kind, current: "", proposed: added.join(",") });
  }
  return differences;
}

/**
 * Applies the differences a contributor ticked in a duplicate review. It
 * re-validates the intake, applies only ticked values, and only adds links.
 * If the artifact changed since the review was shown, it is refused as stale
 * so the contributor can review the latest differences.
 */
export function applyDuplicateReview(
  context: ArchivistContext,
  actor: Actor,
  input: {
    intake: IntakeInput;
    artifactId: string;
    expectedVersion: number;
    selected: readonly string[];
  },
): ArtifactDetails {
  const intake = checkIntake(context, actor, input.intake);
  const selected = new Set(input.selected);
  const addLinks: LinkInput = {};
  for (const kind of LINK_KINDS) {
    if (selected.has(kind)) addLinks[kind] = intake.links[kind];
  }
  return updateArtifact(context, actor, {
    archiveId: input.intake.archiveId,
    id: input.artifactId,
    expectedVersion: input.expectedVersion,
    description: selected.has("description") ? intake.description : undefined,
    exactDate: selected.has("exactDate") ? input.intake.exactDate : undefined,
    estimatedDate: selected.has("estimatedDate") ? input.intake.estimatedDate : undefined,
    addLinks,
  });
}
