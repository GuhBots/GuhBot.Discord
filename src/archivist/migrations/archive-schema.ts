import type { Migration } from "./runner.js";

/** The newest archive schema version this build can read and write. */
export const ARCHIVE_SCHEMA_VERSION = 1;

/**
 * Ordered migrations for each archive's `archive.db`. Never edit a released
 * migration. Add a new one, and back up the archive first when it removes or
 * rewrites data.
 */
export const ARCHIVE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
    CREATE TABLE date_values (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('day', 'instant', 'unknown_local')),
      original_text TEXT NOT NULL,
      calendar_day TEXT,
      instant_ms INTEGER,
      local_datetime TEXT,
      timezone TEXT,
      archive_day TEXT NOT NULL,
      CHECK ((kind = 'day' AND calendar_day IS NOT NULL AND instant_ms IS NULL AND local_datetime IS NULL AND timezone IS NULL) OR (kind = 'instant' AND instant_ms IS NOT NULL AND calendar_day IS NULL AND local_datetime IS NULL AND timezone IS NOT NULL) OR (kind = 'unknown_local' AND calendar_day IS NOT NULL AND local_datetime IS NOT NULL AND instant_ms IS NULL AND timezone IS NULL))
    );

    CREATE TABLE media (
      id TEXT PRIMARY KEY,
      original_path TEXT NOT NULL UNIQUE,
      preview_path TEXT UNIQUE,
      original_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 104857600),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
      metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
      created_at TEXT NOT NULL
    );

    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      known_name TEXT NOT NULL CHECK (length(trim(known_name)) BETWEEN 1 AND 100),
      real_name TEXT,
      birth_day TEXT,
      met_in_person TEXT NOT NULL DEFAULT 'unknown' CHECK (met_in_person IN ('unknown', 'yes', 'no')),
      fallback_media_id TEXT REFERENCES media(id) ON DELETE RESTRICT
    );

    CREATE TABLE character_aliases (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
      observed_date_id TEXT REFERENCES date_values(id),
      UNIQUE (character_id, name, observed_date_id)
    );

    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      discord_id TEXT UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('human', 'bot')),
      label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
      character_id TEXT REFERENCES characters(id) ON DELETE RESTRICT,
      CHECK (kind = 'human' OR character_id IS NULL)
    );

    CREATE TABLE account_ownerships (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
      start_date_id TEXT REFERENCES date_values(id),
      end_date_id TEXT REFERENCES date_values(id)
    );

    CREATE TABLE character_main_accounts (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      observed_date_id TEXT REFERENCES date_values(id)
    );

    CREATE TABLE account_names (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      discriminator TEXT,
      observed_date_id TEXT REFERENCES date_values(id)
    );

    CREATE TABLE account_avatars (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      media_id TEXT NOT NULL REFERENCES media(id),
      observed_date_id TEXT REFERENCES date_values(id)
    );

    CREATE TABLE bot_owners (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
      PRIMARY KEY (account_id, character_id)
    );

    CREATE TABLE servers (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      discord_id TEXT UNIQUE,
      label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
      color TEXT NOT NULL CHECK (color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')
    );

    CREATE TABLE server_names (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      observed_date_id TEXT REFERENCES date_values(id)
    );

    CREATE TABLE server_icons (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      media_id TEXT NOT NULL REFERENCES media(id),
      observed_date_id TEXT REFERENCES date_values(id)
    );

    CREATE TABLE server_owners (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
      observed_date_id TEXT REFERENCES date_values(id)
    );

    CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      discord_id TEXT UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('guild_channel', 'thread', 'direct_message', 'group_chat')),
      server_id TEXT REFERENCES servers(id) ON DELETE RESTRICT,
      parent_channel_id TEXT REFERENCES channels(id) ON DELETE RESTRICT,
      label TEXT NOT NULL,
      icon_media_id TEXT REFERENCES media(id),
      color TEXT NOT NULL CHECK (color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
      CHECK ((kind IN ('guild_channel', 'thread') AND server_id IS NOT NULL) OR (kind IN ('direct_message', 'group_chat') AND server_id IS NULL)),
      CHECK ((kind = 'thread' AND parent_channel_id IS NOT NULL) OR (kind <> 'thread' AND parent_channel_id IS NULL))
    );

    CREATE TABLE channel_names (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      observed_date_id TEXT REFERENCES date_values(id)
    );

    CREATE TABLE memberships (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
      joined_date_id TEXT REFERENCES date_values(id),
      left_date_id TEXT REFERENCES date_values(id)
    );

    CREATE TABLE introductions (
      id TEXT PRIMARY KEY,
      introducer_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
      introduced_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
      date_id TEXT REFERENCES date_values(id),
      CHECK (introducer_id <> introduced_id)
    );

    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
      description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 20000),
      date_kind TEXT NOT NULL CHECK (date_kind IN ('single', 'duration', 'occurrence_window')),
      certainty TEXT NOT NULL CHECK (certainty IN ('exact', 'estimated')),
      start_date_id TEXT NOT NULL REFERENCES date_values(id),
      end_date_id TEXT REFERENCES date_values(id),
      exact_basis TEXT,
      disputed_reason TEXT,
      color TEXT NOT NULL CHECK (color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
      CHECK ((date_kind = 'single' AND end_date_id IS NULL) OR (date_kind <> 'single' AND end_date_id IS NOT NULL)),
      CHECK (certainty <> 'exact' OR length(trim(coalesce(exact_basis, ''))) > 0)
    );

    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      media_id TEXT NOT NULL UNIQUE REFERENCES media(id),
      description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 20000),
      source_provider TEXT NOT NULL CHECK (source_provider IN ('drive', 'discord_attachment', 'web_upload')),
      source_key TEXT NOT NULL,
      source_url TEXT,
      source_resource_key TEXT,
      submission_guild_id TEXT,
      submission_channel_id TEXT,
      submission_message_id TEXT,
      exact_date_id TEXT REFERENCES date_values(id),
      exact_basis TEXT,
      estimated_date_id TEXT REFERENCES date_values(id),
      estimate_reason TEXT,
      file_date_id TEXT REFERENCES date_values(id),
      selected_date_id TEXT REFERENCES date_values(id),
      identification_state TEXT NOT NULL DEFAULT 'unreviewed' CHECK (identification_state IN ('unreviewed', 'incomplete', 'complete')),
      UNIQUE (source_provider, source_key),
      CHECK (selected_date_id IS coalesce(exact_date_id, estimated_date_id, file_date_id)),
      CHECK (exact_date_id IS NULL OR length(trim(coalesce(exact_basis, ''))) > 0),
      CHECK (estimated_date_id IS NULL OR length(trim(coalesce(estimate_reason, ''))) > 0)
    );

    CREATE TABLE artifact_people (
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
      PRIMARY KEY (artifact_id, character_id)
    );

    CREATE TABLE artifact_accounts (
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      PRIMARY KEY (artifact_id, account_id)
    );

    CREATE TABLE artifact_servers (
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
      PRIMARY KEY (artifact_id, server_id)
    );

    CREATE TABLE artifact_channels (
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
      PRIMARY KEY (artifact_id, channel_id)
    );

    CREATE TABLE artifact_events (
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      PRIMARY KEY (artifact_id, event_id)
    );

    CREATE TABLE event_people (
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
      PRIMARY KEY (event_id, character_id)
    );

    CREATE TABLE event_servers (
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
      PRIMARY KEY (event_id, server_id)
    );

    CREATE TABLE event_channels (
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
      PRIMARY KEY (event_id, channel_id)
    );

    CREATE TABLE research_requests (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 20000),
      constraint_kind TEXT NOT NULL CHECK (constraint_kind IN ('approximate_day', 'date_range', 'before_date', 'before_event', 'after_event')),
      start_day TEXT,
      end_day TEXT,
      anchor_event_id TEXT REFERENCES events(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'needed' CHECK (status IN ('needed', 'resolved', 'unrecoverable')),
      priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical', 'high', 'medium', 'low')),
      research_notes TEXT,
      unrecoverable_reason TEXT,
      CHECK ((constraint_kind IN ('approximate_day', 'before_date') AND start_day IS NOT NULL AND end_day IS NULL AND anchor_event_id IS NULL) OR (constraint_kind = 'date_range' AND start_day IS NOT NULL AND end_day IS NOT NULL AND end_day >= start_day AND anchor_event_id IS NULL) OR (constraint_kind IN ('before_event', 'after_event') AND start_day IS NULL AND end_day IS NULL AND anchor_event_id IS NOT NULL)),
      CHECK (status <> 'unrecoverable' OR length(trim(coalesce(unrecoverable_reason, ''))) > 0)
    );

    CREATE TABLE request_people (
      request_id TEXT NOT NULL REFERENCES research_requests(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
      PRIMARY KEY (request_id, character_id)
    );

    CREATE TABLE request_events (
      request_id TEXT NOT NULL REFERENCES research_requests(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      PRIMARY KEY (request_id, event_id)
    );

    CREATE TABLE request_artifacts (
      request_id TEXT NOT NULL REFERENCES research_requests(id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      PRIMARY KEY (request_id, artifact_id)
    );

    CREATE TABLE gap_cards (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('unreadable_media', 'missing_people', 'account_character', 'undated', 'missing_evidence', 'date_research', 'custom')),
      artifact_id TEXT REFERENCES artifacts(id) ON DELETE CASCADE,
      account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
      event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
      character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
      server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
      field_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'needed' CHECK (status IN ('needed', 'resolved', 'unrecoverable')),
      priority TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'medium', 'low')),
      reason TEXT,
      CHECK ((artifact_id IS NOT NULL) + (account_id IS NOT NULL) + (event_id IS NOT NULL) + (character_id IS NOT NULL) + (server_id IS NOT NULL) = 1),
      CHECK (status <> 'unrecoverable' OR length(trim(coalesce(reason, ''))) > 0),
      UNIQUE (kind, artifact_id, field_name),
      UNIQUE (kind, account_id, field_name),
      UNIQUE (kind, event_id, field_name),
      UNIQUE (kind, character_id, field_name),
      UNIQUE (kind, server_id, field_name)
    );

    CREATE TABLE archive_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      archive_id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
      name TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'America/Toronto',
      main_server_id TEXT REFERENCES servers(id) ON DELETE RESTRICT,
      lane_gap_days INTEGER NOT NULL DEFAULT 90 CHECK (lane_gap_days >= 1),
      colors_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(colors_json)),
      created_at TEXT NOT NULL
    );

    CREATE INDEX date_archive_day ON date_values(archive_day, id);

    CREATE INDEX artifact_selected_date ON artifacts(selected_date_id, id);

    CREATE INDEX event_start_date ON events(start_date_id, id);

    CREATE INDEX event_end_date ON events(end_date_id);

    CREATE INDEX request_anchor ON research_requests(anchor_event_id);

    CREATE INDEX request_status_priority ON research_requests(status, priority, id);

    CREATE INDEX gap_status_priority ON gap_cards(status, priority, id);

    CREATE INDEX artifact_people_reverse ON artifact_people(character_id, artifact_id);

    CREATE INDEX artifact_event_reverse ON artifact_events(event_id, artifact_id);

    CREATE INDEX artifact_server_reverse ON artifact_servers(server_id, artifact_id);

    CREATE INDEX artifact_channel_reverse ON artifact_channels(channel_id, artifact_id);

    CREATE INDEX artifact_account_reverse ON artifact_accounts(account_id, artifact_id);

    CREATE INDEX event_people_reverse ON event_people(character_id, event_id);

    CREATE INDEX event_server_reverse ON event_servers(server_id, event_id);

    CREATE INDEX event_channel_reverse ON event_channels(channel_id, event_id);

    CREATE INDEX main_account_character ON character_main_accounts(character_id);

    CREATE INDEX membership_server ON memberships(server_id, account_id);

    CREATE INDEX request_people_reverse ON request_people(character_id, request_id);

    CREATE INDEX request_artifact_reverse ON request_artifacts(artifact_id, request_id);
    `,
  },
];
