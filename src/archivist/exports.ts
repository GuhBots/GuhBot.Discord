import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { finished } from "node:stream/promises";
import { ZipArchive, type ZipEntryData } from "archiver";
import { registeredArchive, requireArchiveOwner, requireOwner } from "./access.js";
import { type Actor, type ArchivistContext, mutationHooks, openStore } from "./context.js";
import { logFile, recoverPendingMutation } from "./mutations.js";
import { ArchivistError } from "./errors.js";
import { newId } from "./fields.js";

/**
 * Complete-folder zip exports, made by the bot owner and left on the host.
 * The owner decided on 2026-11-23 that exports are owner-only, are never sent
 * through Discord or the web app, and stay until the owner deletes them.
 *
 * A consistent snapshot is taken first: any unfinished change is completed,
 * the database is copied with VACUUM INTO, the edit log is copied, and the
 * archive's files are listed. Archive changes run synchronously, so nothing
 * can change the archive while this happens. Compression runs afterward,
 * while new changes may continue. Original and preview files never change
 * once written, so the listed files match the snapshot.
 *
 * The zip holds one folder named by the archive ID, with its database, edit
 * log, originals, previews, and media no longer referenced by any record.
 * Operational state, staging, journals, and other archives live outside the
 * archive folder and are never included. The zip is written under a
 * `.partial` name and renamed when complete, so a file in
 * `archivist-exports/` with a `.zip` name is always whole.
 */

export type ExportState = "queued" | "running" | "ready" | "failed" | "expired";

export interface ExportJob {
  id: string;
  archiveId: string;
  archiveName: string;
  requestedBy: string;
  state: ExportState;
  createdMs: number;
  /** Where the zip is, or will be, on the bot's host. */
  path: string | null;
  /** The zip's size in bytes once ready and still on disk. */
  byteLength: number | null;
  /** False once a ready zip has been deleted from the host. */
  onDisk: boolean;
  errorCode: string | null;
}

interface JobRow {
  id: string;
  archive_id: string;
  requested_by: string;
  state: ExportState;
  created_ms: number;
  relative_path: string | null;
  error_code: string | null;
}

/** Files in an archive folder that are transient and never exported. */
const TRANSIENT = [/^archive\.db-(journal|wal|shm)$/, /\.rewrite$/, /\.tmp$/];

const PARTIAL = ".partial";

function snapshotDir(context: ArchivistContext, jobId: string): string {
  return join(context.paths.tmpDir, "exports", jobId);
}

function toJob(context: ArchivistContext, row: JobRow): ExportJob {
  const path = row.relative_path ? join(context.paths.exportsDir, row.relative_path) : null;
  const onDisk = path !== null && row.state === "ready" && existsSync(path);
  return {
    id: row.id,
    archiveId: row.archive_id,
    archiveName: registeredArchive(context, row.archive_id)?.name ?? row.archive_id,
    requestedBy: row.requested_by,
    state: row.state,
    createdMs: row.created_ms,
    path,
    byteLength: onDisk ? statSync(path).size : null,
    onDisk,
    errorCode: row.error_code,
  };
}

function readJob(context: ArchivistContext, jobId: string): JobRow {
  const row = context.botDb
    .prepare("SELECT * FROM archivist_export_jobs WHERE id = ?")
    .get(jobId) as JobRow | undefined;
  if (!row) throw new ArchivistError("not_found", "There is no export with that ID.");
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

/** A readable, unique zip name: the archive's name, the date, and the job's short ID. */
function zipName(archiveName: string, now: Date, jobId: string): string {
  const safe =
    archiveName
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "archive";
  return `${safe.slice(0, 60)}-${now.toISOString().slice(0, 10)}-${jobId.slice(0, 8)}.zip`;
}

const ALREADY_COMPRESSED = /\.(jpe?g|png|gif|webp|mp4|mov|webm|mkv|avi|mp3|m4a|ogg|flac)$/i;

export interface StartedExport {
  /** The job as it stands once the snapshot is taken. */
  job: ExportJob;
  /** Settles when the zip is complete, or with the error that stopped it. */
  done: Promise<ExportJob>;
}

/**
 * Starts an export of an archive. Only the bot owner may export. The
 * snapshot is taken before this returns, so the export reflects the archive
 * at this moment even though compression continues afterward. The job is
 * recorded first, so a restart during compression marks it failed.
 */
export function startExport(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown },
): StartedExport {
  const archive = requireArchiveOwner(context, actor, input.archiveId, "export an archive");
  const store = openStore(context, archive.archiveId);
  const jobId = newId();
  const now = context.now();
  const fileName = zipName(archive.name, now, jobId);
  context.botDb
    .prepare(
      `INSERT INTO archivist_export_jobs (id, archive_id, requested_by, state, created_ms, relative_path)
       VALUES (?, ?, ?, 'running', ?, ?)`,
    )
    .run(jobId, archive.archiveId, actor.userId, now.getTime(), fileName);

  const tmp = snapshotDir(context, jobId);
  const zipPath = join(context.paths.exportsDir, fileName);
  const partialPath = `${zipPath}${PARTIAL}`;
  const fail = (error: unknown): never => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(partialPath, { force: true });
    context.botDb
      .prepare(
        "UPDATE archivist_export_jobs SET state = 'failed', error_code = ?, relative_path = NULL WHERE id = ?",
      )
      .run(error instanceof ArchivistError ? error.code : "export_failed", jobId);
    throw error instanceof ArchivistError
      ? error
      : new ArchivistError(
          "dependency_unavailable",
          "The export could not be written. Check the free space on the host and try again.",
        );
  };

  const snapshotDb = join(tmp, "archive.db");
  const snapshotLog = join(tmp, "edits.log");
  let files: string[] = [];
  try {
    mkdirSync(tmp, { recursive: true });
    mkdirSync(context.paths.exportsDir, { recursive: true });
    // Snapshot. Everything up to the file listing runs without awaiting, so
    // no archive change can run in between.
    recoverPendingMutation(store, mutationHooks(context));
    store.db.prepare("VACUUM INTO ?").run(snapshotDb);
    writeFileSync(snapshotLog, existsSync(logFile(store)) ? readFileSync(logFile(store)) : "");
    files = archiveFiles(store.folder);
  } catch (error) {
    fail(error);
  }

  const compress = async (): Promise<ExportJob> => {
    try {
      const output = createWriteStream(partialPath);
      const zip = new ZipArchive({ zlib: { level: 6 } });
      const written = finished(output);
      zip.pipe(output);
      const root = archive.archiveId;
      zip.file(snapshotDb, { name: `${root}/archive.db` });
      zip.file(snapshotLog, { name: `${root}/edits.log` });
      for (const file of files) {
        // Media is already compressed, so it is stored rather than deflated again.
        const entry: ZipEntryData = {
          name: `${root}/${file}`,
          store: ALREADY_COMPRESSED.test(file),
        };
        zip.file(join(store.folder, file), entry);
      }
      await zip.finalize();
      await written;
      renameSync(partialPath, zipPath);
      rmSync(tmp, { recursive: true, force: true });
      context.botDb
        .prepare("UPDATE archivist_export_jobs SET state = 'ready' WHERE id = ?")
        .run(jobId);
      return toJob(context, readJob(context, jobId));
    } catch (error) {
      return fail(error);
    }
  };

  return { job: toJob(context, readJob(context, jobId)), done: compress() };
}

/** Exports an archive and waits for the zip to be complete. */
export async function createExport(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown },
): Promise<ExportJob> {
  return startExport(context, actor, input).done;
}

/** One export job. Owner only. */
export function exportStatus(
  context: ArchivistContext,
  actor: Actor,
  input: { jobId: unknown },
): ExportJob {
  requireOwner(actor, "see exports");
  return toJob(context, readJob(context, String(input.jobId ?? "").trim()));
}

/** The most recent export jobs across all archives, newest first. Owner only. */
export function listExports(context: ArchivistContext, actor: Actor, limit = 10): ExportJob[] {
  requireOwner(actor, "see exports");
  const rows = context.botDb
    .prepare("SELECT * FROM archivist_export_jobs ORDER BY created_ms DESC, id LIMIT ?")
    .all(limit) as JobRow[];
  return rows.map((row) => toJob(context, row));
}

/**
 * Marks exports a restart interrupted as failed, and removes their partial
 * zip and snapshot. Finished zips are never removed.
 */
export function settleInterruptedExports(context: ArchivistContext): number {
  const running = context.botDb
    .prepare(
      "SELECT id, relative_path FROM archivist_export_jobs WHERE state IN ('queued', 'running')",
    )
    .all() as { id: string; relative_path: string | null }[];
  for (const job of running) {
    rmSync(snapshotDir(context, job.id), { recursive: true, force: true });
    if (job.relative_path) {
      rmSync(join(context.paths.exportsDir, `${job.relative_path}${PARTIAL}`), { force: true });
    }
    context.botDb
      .prepare(
        "UPDATE archivist_export_jobs SET state = 'failed', error_code = 'interrupted', relative_path = NULL WHERE id = ?",
      )
      .run(job.id);
  }
  return running.length;
}
