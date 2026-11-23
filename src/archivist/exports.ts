import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { finished } from "node:stream/promises";
import { ZipArchive, type ZipEntryData } from "archiver";
import { requireArchiveAccess } from "./access.js";
import { type Actor, type ArchivistContext, mutationHooks, openStore } from "./context.js";
import { logFile, recoverPendingMutation } from "./mutations.js";
import { ArchivistError } from "./errors.js";
import { newId } from "./fields.js";

/**
 * Complete-folder zip exports. A consistent snapshot is taken first: any
 * unfinished change is completed, the database is copied with VACUUM INTO,
 * the edit log is copied, and the archive's files are listed. Archive
 * changes run synchronously, so nothing can change the archive while this
 * happens. Compression runs afterward, while new changes may continue.
 * Original and preview files never change once written, so the listed
 * files match the snapshot.
 *
 * The zip holds one folder named by the archive ID, with its database,
 * edit log, originals, previews, and media no longer referenced by any
 * record. Operational state, staging, journals, and other archives live
 * outside the archive folder and are never included. Exports are kept in
 * `archivist-exports/` for 24 hours.
 */

export const EXPORT_LIFETIME_MS = 24 * 60 * 60_000;

export type ExportState = "queued" | "running" | "ready" | "failed" | "expired";

export interface ExportJob {
  id: string;
  archiveId: string;
  requestedBy: string;
  state: ExportState;
  createdMs: number;
  expiresMs: number | null;
  /** The zip's size in bytes once ready. */
  byteLength: number | null;
  fileName: string | null;
  errorCode: string | null;
}

interface JobRow {
  id: string;
  archive_id: string;
  requested_by: string;
  state: ExportState;
  created_ms: number;
  expires_ms: number | null;
  relative_path: string | null;
  error_code: string | null;
}

/** Files in an archive folder that are transient and never exported. */
const TRANSIENT = [/^archive\.db-(journal|wal|shm)$/, /\.rewrite$/, /\.tmp$/];

function toJob(context: ArchivistContext, row: JobRow): ExportJob {
  const file = row.relative_path ? join(context.paths.exportsDir, row.relative_path) : null;
  return {
    id: row.id,
    archiveId: row.archive_id,
    requestedBy: row.requested_by,
    state: row.state,
    createdMs: row.created_ms,
    expiresMs: row.expires_ms,
    byteLength: file && row.state === "ready" && existsSync(file) ? statSync(file).size : null,
    fileName: row.relative_path ? row.relative_path.split("/").pop()! : null,
    errorCode: row.error_code,
  };
}

function readJob(context: ArchivistContext, archiveId: string, jobId: string): JobRow {
  const row = context.botDb
    .prepare("SELECT * FROM archivist_export_jobs WHERE id = ? AND archive_id = ?")
    .get(jobId, archiveId) as JobRow | undefined;
  if (!row)
    throw new ArchivistError("not_found", "There is no export with that ID for this archive.");
  return row;
}

/** Lists every file to export, relative to the archive folder, skipping transient files. */
function archiveFiles(folder: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && !TRANSIENT.some((pattern) => pattern.test(entry.name))) {
        files.push(relative(folder, path).split(sep).join("/"));
      }
    }
  };
  walk(folder);
  return files.filter((file) => file !== "archive.db" && file !== "edits.log").sort();
}

function zipName(archiveName: string, now: Date): string {
  const safe =
    archiveName
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "archive";
  return `${safe.slice(0, 60)}-${now.toISOString().slice(0, 10)}.zip`;
}

const ALREADY_COMPRESSED = /\.(jpe?g|png|gif|webp|mp4)$/i;

/**
 * Exports an archive to a zip and returns the finished job. Owners and
 * members may export. The job is recorded first, so its status can be
 * checked if the requester's connection ends while it runs.
 */
export async function createExport(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown },
): Promise<ExportJob> {
  const archive = requireArchiveAccess(context, actor, input.archiveId);
  const store = openStore(context, archive.archiveId);
  const jobId = newId();
  const now = context.now();
  const fileName = zipName(archive.name, now);
  const jobDir = join(context.paths.exportsDir, jobId);
  const relativePath = `${jobId}/${fileName}`;
  context.botDb
    .prepare(
      `INSERT INTO archivist_export_jobs (id, archive_id, requested_by, state, created_ms, relative_path)
       VALUES (?, ?, ?, 'running', ?, ?)`,
    )
    .run(jobId, archive.archiveId, actor.userId, now.getTime(), relativePath);

  try {
    mkdirSync(jobDir, { recursive: true });
    // Snapshot. Everything up to the file listing runs without awaiting, so
    // no archive change can run in between.
    recoverPendingMutation(store, mutationHooks(context));
    const snapshotDb = join(jobDir, "snapshot.db");
    store.db.prepare("VACUUM INTO ?").run(snapshotDb);
    const snapshotLog = join(jobDir, "snapshot.log");
    writeFileSync(snapshotLog, existsSync(logFile(store)) ? readFileSync(logFile(store)) : "");
    const files = archiveFiles(store.folder);

    const zipPath = join(jobDir, fileName);
    const output = createWriteStream(zipPath);
    const zip = new ZipArchive({ zlib: { level: 6 } });
    const done = finished(output);
    zip.pipe(output);
    const root = archive.archiveId;
    zip.file(snapshotDb, { name: `${root}/archive.db` });
    zip.file(snapshotLog, { name: `${root}/edits.log` });
    for (const file of files) {
      // Media is already compressed, so it is stored rather than deflated again.
      const entry: ZipEntryData = { name: `${root}/${file}`, store: ALREADY_COMPRESSED.test(file) };
      zip.file(join(store.folder, file), entry);
    }
    await zip.finalize();
    await done;
    rmSync(snapshotDb, { force: true });
    rmSync(snapshotLog, { force: true });

    context.botDb
      .prepare("UPDATE archivist_export_jobs SET state = 'ready', expires_ms = ? WHERE id = ?")
      .run(context.now().getTime() + EXPORT_LIFETIME_MS, jobId);
  } catch (error) {
    rmSync(jobDir, { recursive: true, force: true });
    context.botDb
      .prepare(
        "UPDATE archivist_export_jobs SET state = 'failed', error_code = ?, relative_path = NULL WHERE id = ?",
      )
      .run(error instanceof ArchivistError ? error.code : "export_failed", jobId);
    throw error instanceof ArchivistError
      ? error
      : new ArchivistError(
          "dependency_unavailable",
          "The export could not be written. Try again later.",
        );
  }
  return toJob(context, readJob(context, archive.archiveId, jobId));
}

export function exportStatus(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; jobId: unknown },
): ExportJob {
  const archive = requireArchiveAccess(context, actor, input.archiveId);
  return toJob(context, readJob(context, archive.archiveId, String(input.jobId ?? "")));
}

/**
 * Returns a ready export's file after checking access again, as every
 * download must. Expired and failed exports cannot be downloaded.
 */
export function exportFile(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; jobId: unknown },
): { path: string; fileName: string; byteLength: number } {
  const archive = requireArchiveAccess(context, actor, input.archiveId);
  const row = readJob(context, archive.archiveId, String(input.jobId ?? ""));
  const job = toJob(context, row);
  const expired = row.expires_ms !== null && row.expires_ms <= context.now().getTime();
  if (job.state !== "ready" || expired || !row.relative_path || job.byteLength === null) {
    throw new ArchivistError(
      "not_found",
      expired || job.state === "expired"
        ? "That export has expired. Create a new one."
        : "That export is not ready to download.",
    );
  }
  return {
    path: join(context.paths.exportsDir, row.relative_path),
    fileName: job.fileName!,
    byteLength: job.byteLength,
  };
}

/** Deletes ready exports older than 24 hours. Returns how many expired. */
export function expireExports(context: ArchivistContext): number {
  const due = context.botDb
    .prepare("SELECT id FROM archivist_export_jobs WHERE state = 'ready' AND expires_ms <= ?")
    .all(context.now().getTime()) as { id: string }[];
  for (const job of due) {
    rmSync(join(context.paths.exportsDir, job.id), { recursive: true, force: true });
    context.botDb
      .prepare(
        "UPDATE archivist_export_jobs SET state = 'expired', relative_path = NULL WHERE id = ?",
      )
      .run(job.id);
  }
  return due.length;
}

/** Marks exports a restart interrupted as failed, and removes their partial files. */
export function settleInterruptedExports(context: ArchivistContext): number {
  const running = context.botDb
    .prepare("SELECT id FROM archivist_export_jobs WHERE state IN ('queued', 'running')")
    .all() as { id: string }[];
  for (const job of running) {
    rmSync(join(context.paths.exportsDir, job.id), { recursive: true, force: true });
    context.botDb
      .prepare(
        "UPDATE archivist_export_jobs SET state = 'failed', error_code = 'interrupted', relative_path = NULL WHERE id = ?",
      )
      .run(job.id);
  }
  return running.length;
}
