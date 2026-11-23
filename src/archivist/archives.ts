import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openArchiveDatabase } from "./archive-database.js";
import {
  registeredArchive,
  requireArchiveAccess,
  requireArchiveOwner,
  requireOwner,
  type RegisteredArchive,
} from "./access.js";
import {
  type Actor,
  type ArchivistContext,
  closeStore,
  journalFile,
  mutationHooks,
  openStore,
} from "./context.js";
import { archiveDay, type DateValue, timeZoneName } from "./dates.js";
import type { FieldChange, LogEntry } from "./edit-log.js";
import { ArchivistError } from "./errors.js";
import { colorValue, nameKey, newId, requiredText, TEXT_LIMITS, timestamp } from "./fields.js";
import { ARCHIVE_SCHEMA_VERSION } from "./migrations/archive-schema.js";
import { readArchiveSchemaVersion } from "./migrations/runner.js";
import { type ArchiveStore, commitMutation, recoverPendingMutation } from "./mutations.js";
import { archiveFolder, archiveIdValue, archiveRelativePath, insideArchive } from "./paths.js";
import { expectedVersionValue, staleVersion } from "./versions.js";

/** The default timezone for a new archive, chosen by the owner. */
export const DEFAULT_ARCHIVE_TIME_ZONE = "America/Toronto";

const MAX_LANE_GAP_DAYS = 3650;
const MAX_COLORS = 32;
const COLOR_ROLE = /^[a-z][a-z0-9_]{0,39}$/;

export interface ArchiveDetails {
  archiveId: string;
  name: string;
  version: number;
  schemaVersion: number;
  timezone: string;
  mainServerId: string | null;
  laneGapDays: number;
  colors: Record<string, string>;
  createdAt: string;
}

interface MetaRow {
  archive_id: string;
  name: string;
  version: number;
  schema_version: number;
  timezone: string;
  main_server_id: string | null;
  lane_gap_days: number;
  colors_json: string;
  created_at: string;
}

function readMetaRow(store: ArchiveStore): MetaRow | undefined {
  return store.db.prepare("SELECT * FROM archive_meta WHERE singleton = 1").get() as
    MetaRow | undefined;
}

function toDetails(row: MetaRow): ArchiveDetails {
  return {
    archiveId: row.archive_id,
    name: row.name,
    version: row.version,
    schemaVersion: row.schema_version,
    timezone: row.timezone,
    mainServerId: row.main_server_id,
    laneGapDays: row.lane_gap_days,
    colors: JSON.parse(row.colors_json) as Record<string, string>,
    createdAt: row.created_at,
  };
}

/** Reads an open archive's metadata. */
export function archiveDetails(store: ArchiveStore): ArchiveDetails {
  const row = readMetaRow(store);
  if (!row) {
    throw new ArchivistError("dependency_unavailable", "This archive has no metadata row.", {
      archiveId: store.archiveId,
    });
  }
  return toDetails(row);
}

function archiveName(value: unknown): string {
  return requiredText("name", value, TEXT_LIMITS.name);
}

function assertNameAvailable(
  context: ArchivistContext,
  name: string,
  exceptArchiveId?: string,
): void {
  const taken = context.botDb
    .prepare("SELECT archive_id AS archiveId, name FROM archivist_archives WHERE name_key = ?")
    .get(nameKey(name)) as RegisteredArchive | undefined;
  if (taken && taken.archiveId !== exceptArchiveId) {
    throw new ArchivistError(
      "name_taken",
      `An archive named "${taken.name}" already exists. Choose a different name.`,
      { field: "name" },
    );
  }
}

function logEntry(
  context: ArchivistContext,
  actor: Actor,
  archiveId: string,
  changes: Record<string, FieldChange>,
): LogEntry {
  return {
    at: timestamp(context.now()),
    editor: actor.userId,
    record: "archive",
    id: archiveId,
    changes,
  };
}

function insertRegistryRow(
  context: ArchivistContext,
  actor: Actor,
  archiveId: string,
  name: string,
): void {
  context.botDb
    .prepare(
      `INSERT INTO archivist_archives (archive_id, name, name_key, relative_path, registered_at, registered_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      archiveId,
      name,
      nameKey(name),
      archiveRelativePath(archiveId),
      timestamp(context.now()),
      actor.userId,
    );
}

/** Lists the archives the actor can open. The owner sees every registered archive. */
export function listArchives(context: ArchivistContext, actor: Actor): RegisteredArchive[] {
  const sql = actor.isOwner
    ? "SELECT archive_id AS archiveId, name FROM archivist_archives ORDER BY name_key, archive_id"
    : `SELECT a.archive_id AS archiveId, a.name FROM archivist_archives a
       JOIN archivist_whitelist w ON w.archive_id = a.archive_id
       WHERE w.discord_user_id = ? ORDER BY a.name_key, a.archive_id`;
  const statement = context.botDb.prepare(sql);
  return (actor.isOwner ? statement.all() : statement.all(actor.userId)) as RegisteredArchive[];
}

export function getArchive(
  context: ArchivistContext,
  actor: Actor,
  archiveId: unknown,
): ArchiveDetails {
  const archive = requireArchiveAccess(context, actor, archiveId);
  return archiveDetails(openStore(context, archive.archiveId));
}

/**
 * Creates an archive folder with its database and an empty edit log, then
 * registers it. If any step fails, the half-created folder is removed. It
 * was created by this call, so nothing else can be in it.
 */
export function createArchive(
  context: ArchivistContext,
  actor: Actor,
  input: { name: unknown },
): ArchiveDetails {
  requireOwner(actor, "create archives");
  const name = archiveName(input.name);
  assertNameAvailable(context, name);

  const archiveId = newId();
  const folder = archiveFolder(context.paths, archiveId);
  mkdirSync(folder);
  let store: ArchiveStore | undefined;
  try {
    mkdirSync(join(folder, "media", "originals"), { recursive: true });
    mkdirSync(join(folder, "media", "previews"), { recursive: true });
    writeFileSync(join(folder, "edits.log"), "");
    store = {
      archiveId,
      folder,
      db: openArchiveDatabase(join(folder, "archive.db"), { create: true }),
      journalFile: journalFile(context, archiveId),
    };
    const createdAt = timestamp(context.now());
    commitMutation(store, {
      expectations: [{ table: "archive_meta", id: archiveId, state: "present" }],
      apply(db) {
        db.prepare(
          `INSERT INTO archive_meta (singleton, archive_id, schema_version, name, timezone, created_at)
           VALUES (1, ?, ?, ?, ?, ?)`,
        ).run(archiveId, ARCHIVE_SCHEMA_VERSION, name, DEFAULT_ARCHIVE_TIME_ZONE, createdAt);
      },
      append: [
        logEntry(context, actor, archiveId, {
          name: { old: null, new: name },
          timezone: { old: null, new: DEFAULT_ARCHIVE_TIME_ZONE },
        }),
      ],
    });
    insertRegistryRow(context, actor, archiveId, name);
    context.stores.set(archiveId, store);
    return archiveDetails(store);
  } catch (error) {
    store?.db.close();
    rmSync(folder, { recursive: true, force: true });
    rmSync(journalFile(context, archiveId), { force: true });
    throw error;
  }
}

/** Renames an archive. The folder never moves. */
export function renameArchive(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; name: unknown; expectedVersion: unknown },
): ArchiveDetails {
  const archive = requireArchiveOwner(context, actor, input.archiveId, "rename archives");
  const name = archiveName(input.name);
  const expectedVersion = expectedVersionValue(input.expectedVersion);
  const store = openStore(context, archive.archiveId);
  const current = archiveDetails(store);
  if (current.version !== expectedVersion) {
    throw staleVersion("archive", archive.archiveId, current.version, { name: current.name });
  }
  if (name === current.name) return current;
  assertNameAvailable(context, name, archive.archiveId);

  commitMutation(
    store,
    {
      expectations: [
        { table: "archive_meta", id: archive.archiveId, version: current.version + 1 },
      ],
      apply(db) {
        db.prepare("UPDATE archive_meta SET name = ?, version = version + 1").run(name);
      },
      append: [
        logEntry(context, actor, archive.archiveId, { name: { old: current.name, new: name } }),
      ],
      followUps: [{ kind: "archive_name", archiveId: archive.archiveId, name }],
    },
    mutationHooks(context),
  );
  return archiveDetails(store);
}

export interface RegisterResult {
  archive: ArchiveDetails;
  /** Problems that do not block hosting, such as missing previews. */
  warnings: string[];
}

/**
 * Checks an archive folder already under the archive root and hosts it. The
 * archive keeps its ID. No old whitelist is imported, so only the owner can
 * open it until members are added. If its name is taken, the owner registers
 * it under a new name, which is recorded as a rename in its log.
 */
export function registerArchive(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; name?: unknown },
): RegisterResult {
  requireOwner(actor, "register archives");
  const archiveId = archiveIdValue("archiveId", input.archiveId);
  if (registeredArchive(context, archiveId)) {
    throw new ArchivistError("invalid_input", "That archive is already registered.", {
      field: "archiveId",
    });
  }
  const folder = archiveFolder(context.paths, archiveId);
  if (!existsSync(join(folder, "archive.db"))) {
    throw new ArchivistError(
      "invalid_input",
      "No archive with that ID exists in the archive folder. Copy its folder there first.",
      { field: "archiveId" },
    );
  }

  const store: ArchiveStore = {
    archiveId,
    folder,
    db: openArchiveDatabase(join(folder, "archive.db")),
    journalFile: journalFile(context, archiveId),
  };
  try {
    recoverPendingMutation(store, mutationHooks(context));
    const warnings = validateArchiveFolder(store);
    const current = archiveDetails(store);
    const name =
      input.name === undefined || input.name === null || input.name === ""
        ? current.name
        : archiveName(input.name);
    assertNameAvailable(context, name);
    if (name !== current.name) {
      commitMutation(store, {
        expectations: [{ table: "archive_meta", id: archiveId, version: current.version + 1 }],
        apply(db) {
          db.prepare("UPDATE archive_meta SET name = ?, version = version + 1").run(name);
        },
        append: [logEntry(context, actor, archiveId, { name: { old: current.name, new: name } })],
      });
    }
    insertRegistryRow(context, actor, archiveId, name);
    context.stores.set(archiveId, store);
    return { archive: archiveDetails(store), warnings };
  } catch (error) {
    store.db.close();
    throw error;
  }
}

function invalidArchive(reason: string, details: Record<string, unknown> = {}): ArchivistError {
  return new ArchivistError(
    "invalid_input",
    `This archive cannot be registered because ${reason}`,
    {
      field: "archiveId",
      ...details,
    },
  );
}

/** Checks the archive's identity, schema, integrity, and media files. */
function validateArchiveFolder(store: ArchiveStore): string[] {
  const meta = readMetaRow(store);
  if (!meta) throw invalidArchive("it has no metadata.");
  if (meta.archive_id !== store.archiveId) {
    throw invalidArchive("its folder name does not match the archive ID inside it.");
  }
  if (meta.schema_version !== readArchiveSchemaVersion(store.db)) {
    throw invalidArchive("its two schema version records disagree.");
  }
  if (store.db.pragma("integrity_check", { simple: true }) !== "ok") {
    throw invalidArchive("its database failed SQLite's integrity check.");
  }
  if ((store.db.pragma("foreign_key_check") as unknown[]).length > 0) {
    throw invalidArchive("some of its records point at records that do not exist.");
  }
  const warnings: string[] = [];
  const media = store.db.prepare("SELECT id, original_path, preview_path FROM media").all() as {
    id: string;
    original_path: string;
    preview_path: string | null;
  }[];
  for (const row of media) {
    if (!existsSync(insideArchive(store.folder, row.original_path))) {
      throw invalidArchive("an original media file is missing.", { mediaId: row.id });
    }
    if (row.preview_path && !existsSync(insideArchive(store.folder, row.preview_path))) {
      warnings.push(`Preview missing for media ${row.id}. A placeholder is shown instead.`);
    }
  }
  return warnings;
}

/**
 * Stops hosting an archive. Its whitelist, announcement setting, and
 * remembered selections are removed. Its folder and files are kept.
 */
export function unregisterArchive(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown },
): void {
  const archive = requireArchiveOwner(context, actor, input.archiveId, "unregister archives");
  closeStore(context, archive.archiveId);
  context.botDb
    .prepare("DELETE FROM archivist_archives WHERE archive_id = ?")
    .run(archive.archiveId);
}

export interface SettingsInput {
  archiveId: unknown;
  expectedVersion: unknown;
  timezone?: unknown;
  mainServerId?: unknown;
  laneGapDays?: unknown;
  colors?: unknown;
}

function laneGapDaysValue(value: unknown): number {
  const days = typeof value === "string" ? Number(value) : value;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_LANE_GAP_DAYS) {
    throw new ArchivistError(
      "invalid_input",
      `Lane gap must be a whole number of days from 1 to ${MAX_LANE_GAP_DAYS}.`,
      {
        field: "laneGapDays",
      },
    );
  }
  return days;
}

function colorsValue(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArchivistError("invalid_input", "Colors must map display roles to colors.", {
      field: "colors",
    });
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_COLORS || entries.some(([role]) => !COLOR_ROLE.test(role))) {
    throw new ArchivistError("invalid_input", "Colors must use short lowercase role names.", {
      field: "colors",
    });
  }
  return Object.fromEntries(
    entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([role, color]) => [role, colorValue(`colors.${role}`, color)]),
  );
}

/**
 * Changes the archive's display settings. A timezone change recomputes the
 * archive-day cache of every instant, which is cache maintenance rather than
 * an edit of historical data, so only the setting itself is logged.
 */
export function updateArchiveSettings(
  context: ArchivistContext,
  actor: Actor,
  input: SettingsInput,
): ArchiveDetails {
  const archive = requireArchiveOwner(context, actor, input.archiveId, "change archive settings");
  const expectedVersion = expectedVersionValue(input.expectedVersion);
  const store = openStore(context, archive.archiveId);
  const current = archiveDetails(store);

  const next = { ...current };
  if (input.timezone !== undefined) next.timezone = timeZoneName("timezone", input.timezone);
  if (input.laneGapDays !== undefined) next.laneGapDays = laneGapDaysValue(input.laneGapDays);
  if (input.colors !== undefined) next.colors = colorsValue(input.colors);
  if (input.mainServerId !== undefined) {
    const id =
      input.mainServerId === null || input.mainServerId === "" ? null : String(input.mainServerId);
    if (id !== null && !store.db.prepare("SELECT 1 FROM servers WHERE id = ?").get(id)) {
      throw new ArchivistError(
        "invalid_input",
        "The main server must be a server in this archive.",
        {
          field: "mainServerId",
        },
      );
    }
    next.mainServerId = id;
  }

  const changes: Record<string, FieldChange> = {};
  for (const field of ["timezone", "laneGapDays", "colors", "mainServerId"] as const) {
    if (JSON.stringify(current[field]) !== JSON.stringify(next[field])) {
      changes[field] = { old: current[field], new: next[field] };
    }
  }
  if (current.version !== expectedVersion) {
    const currentValues = Object.fromEntries(
      Object.keys(changes).map((field) => [field, current[field as keyof ArchiveDetails]]),
    );
    throw staleVersion("archive", archive.archiveId, current.version, currentValues);
  }
  if (Object.keys(changes).length === 0) return current;

  commitMutation(store, {
    expectations: [{ table: "archive_meta", id: archive.archiveId, version: current.version + 1 }],
    apply(db) {
      db.prepare(
        `UPDATE archive_meta SET timezone = ?, lane_gap_days = ?, colors_json = ?, main_server_id = ?,
           version = version + 1`,
      ).run(next.timezone, next.laneGapDays, JSON.stringify(next.colors), next.mainServerId);
      if (changes.timezone) recomputeArchiveDays(db, next.timezone);
    },
    append: [logEntry(context, actor, archive.archiveId, changes)],
  });
  return archiveDetails(store);
}

function recomputeArchiveDays(db: ArchiveStore["db"], timeZone: string): void {
  const instants = db
    .prepare(
      "SELECT id, original_text, instant_ms, timezone FROM date_values WHERE kind = 'instant'",
    )
    .all() as { id: string; original_text: string; instant_ms: number; timezone: string }[];
  const update = db.prepare("UPDATE date_values SET archive_day = ? WHERE id = ?");
  for (const row of instants) {
    const value: DateValue = {
      kind: "instant",
      originalText: row.original_text,
      instantMs: row.instant_ms,
      timezone: row.timezone,
    };
    update.run(archiveDay(value, timeZone), row.id);
  }
}
