import type { Migration } from "./runner.js";

/** The newest operational schema version this build can read and write. */
export const OPERATIONAL_SCHEMA_VERSION = 2;

/**
 * Ordered migrations for Archivist's tables in the bot's `guhbot.db`. They only
 * add tables, so the AFK table and any other bot data stay untouched.
 */
export const OPERATIONAL_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
    CREATE TABLE archivist_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version >= 1)
    );

    CREATE TABLE archivist_archives (
      archive_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL UNIQUE,
      relative_path TEXT NOT NULL UNIQUE,
      registered_at TEXT NOT NULL,
      registered_by TEXT NOT NULL
    );

    CREATE TABLE archivist_whitelist (
      archive_id TEXT NOT NULL REFERENCES archivist_archives(archive_id) ON DELETE CASCADE,
      discord_user_id TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      PRIMARY KEY (archive_id, discord_user_id)
    );

    CREATE TABLE archivist_timezones (
      discord_user_id TEXT PRIMARY KEY,
      timezone TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE archivist_last_archives (
      discord_user_id TEXT PRIMARY KEY,
      archive_id TEXT NOT NULL REFERENCES archivist_archives(archive_id) ON DELETE CASCADE,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE archivist_sessions (
      token_hash TEXT PRIMARY KEY,
      discord_user_id TEXT NOT NULL,
      created_ms INTEGER NOT NULL,
      expires_ms INTEGER NOT NULL,
      owner_checked_ms INTEGER,
      is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
      CHECK (expires_ms > created_ms)
    );

    CREATE TABLE archivist_auth_states (
      token_hash TEXT PRIMARY KEY,
      expires_ms INTEGER NOT NULL
    );

    CREATE TABLE archivist_announcement_channels (
      archive_id TEXT PRIMARY KEY REFERENCES archivist_archives(archive_id) ON DELETE CASCADE,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      configured_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE archivist_announcements (
      archive_id TEXT NOT NULL REFERENCES archivist_archives(archive_id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'failed', 'indeterminate')),
      attempted_at TEXT,
      error_code TEXT,
      PRIMARY KEY (archive_id, artifact_id)
    );

    CREATE TABLE archivist_export_jobs (
      id TEXT PRIMARY KEY,
      archive_id TEXT NOT NULL REFERENCES archivist_archives(archive_id) ON DELETE CASCADE,
      requested_by TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'failed', 'expired')),
      created_ms INTEGER NOT NULL,
      expires_ms INTEGER,
      relative_path TEXT,
      error_code TEXT
    );

    CREATE INDEX archivist_membership_user ON archivist_whitelist(discord_user_id, archive_id);
    CREATE INDEX archivist_session_expiry ON archivist_sessions(expires_ms);
    CREATE INDEX archivist_export_expiry ON archivist_export_jobs(expires_ms);
    `,
  },
  {
    // Each person's order for all-number dates, chosen by the owner on 2026-11-23.
    version: 2,
    sql: `
    CREATE TABLE archivist_date_orders (
      discord_user_id TEXT PRIMARY KEY,
      date_order TEXT NOT NULL CHECK (date_order IN ('ymd', 'mdy', 'dmy')),
      updated_at TEXT NOT NULL
    );
    `,
  },
];
