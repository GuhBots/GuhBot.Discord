/**
 * The JSON shapes the Archivist service's API returns, as the bot reads them.
 * The service in GuhBot.Archivist owns these records. Its server code is the
 * source of truth, and docs/design/bot-api.md there describes the routes. Only
 * the fields the bot uses need to stay in step.
 */

export type DateValue =
  | { kind: "day"; originalText: string; calendarDay: string }
  | { kind: "instant"; originalText: string; instantMs: number; timezone: string }
  | { kind: "unknown_local"; originalText: string; calendarDay: string; localDateTime: string };

export type StoredDate = DateValue & { id: string; archiveDay: string };

export type DateOrder = "ymd" | "mdy" | "dmy";

export type LinkKind = "characters" | "accounts" | "servers" | "channels" | "events";
export type Links = Record<LinkKind, string[]>;
export type LinkInput = Partial<Record<LinkKind, string[]>>;

export type SourceProvider = "drive" | "discord_attachment" | "web_upload";
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
  unidentifiedCharacters: boolean;
  links: Links;
}

/** One field a resubmitted source would change, in a duplicate review. */
export interface DuplicateDifference {
  key: "description" | "exactDate" | "estimatedDate" | LinkKind;
  current: string;
  proposed: string;
}

export type IntakeReply =
  | {
      status: "created";
      artifact: ArtifactDetails;
      /** `queued` means the bot will post it. */
      announcement: { status: string };
    }
  | {
      status: "duplicate";
      artifact: ArtifactDetails;
      differences: DuplicateDifference[];
      /** Null when everything submitted matches the existing artifact. */
      reviewToken: string | null;
    };

export type EntityKind = "character" | "account" | "server" | "channel";

/** A record's own fields as labeled values, from the summary route. */
export interface EntityDetails {
  kind: EntityKind;
  id: string;
  version: number;
  createdAt: string;
  createdBy: string;
  name: string;
  fields: [label: string, value: string][];
}

export type EventDateKind = "single" | "duration" | "occurrence_window";
export type Certainty = "exact" | "estimated";

export interface EventDetails {
  id: string;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  title: string;
  description: string;
  dateKind: EventDateKind;
  certainty: Certainty;
  start: StoredDate;
  end: StoredDate | null;
  exactBasis: string | null;
  disputedReason: string | null;
  color: string;
  /** Events link characters and places. Artifacts link to events, as `supportingArtifacts`. */
  links: Record<"characters" | "servers" | "channels", string[]>;
  supportingArtifacts: string[];
}

export type ConstraintKind =
  "approximate_day" | "date_range" | "before_date" | "before_event" | "after_event";
export type RequestStatus = "needed" | "resolved" | "unrecoverable";
export type Priority = "critical" | "high" | "medium" | "low";

export interface RequestDetails {
  id: string;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  description: string;
  label: string;
  constraint: {
    kind: ConstraintKind;
    startDay: string | null;
    endDay: string | null;
    anchorEventId: string | null;
  };
  window: { around?: string; from?: string; to?: string; after?: string; before?: string };
  wording: string;
  status: RequestStatus;
  priority: Priority;
  researchNotes: string | null;
  unrecoverableReason: string | null;
  characters: string[];
  events: string[];
  foundArtifacts: string[];
}

export interface ArchiveSummary {
  archiveId: string;
  name: string;
}

export interface ArchiveDetails extends ArchiveSummary {
  version: number;
  schemaVersion: number;
  timezone: string;
  mainServerId: string | null;
  laneGapDays: number;
  colors: Record<string, string>;
  createdAt: string;
}

export interface Me {
  user: { id: string; name: string | null; avatarUrl: string | null };
  isOwner: boolean;
  via: "session" | "service" | "local";
  sessionExpires: string | null;
  preferences: { timeZone: string | null; dateOrder: DateOrder };
}

export interface DatePreview {
  value: DateValue;
  archiveDay: string;
  /** The text had a time but no zone, so the contributor's zone was assumed. */
  assumedZone: boolean;
  /** For a date and time: the wall-clock reading, the zone it was read in, and its offset. */
  display: { local: string; zone: string; offset: string } | null;
}

export interface SearchHit {
  id: string;
  label: string;
}

export interface Member {
  userId: string;
  grantedAt: string;
  grantedBy: string;
}

export type ExportState = "queued" | "running" | "ready" | "failed" | "expired";

export interface ExportJob {
  id: string;
  archiveId: string;
  archiveName: string;
  requestedBy: string;
  state: ExportState;
  createdMs: number;
  /** Where the zip is on the service's host. */
  path: string | null;
  byteLength: number | null;
  onDisk: boolean;
  errorCode: string | null;
}

/** One queued upload announcement the bot has claimed. */
export interface AnnouncementItem {
  archiveId: string;
  artifactId: string;
  claimId: string;
  channel: { guildId: string; channelId: string };
  archiveName: string;
  archiveTimeZone: string;
  /** The artifact as it was submitted. */
  artifact: ArtifactDetails;
  /** Known names of `artifact.links.characters`, in the same order. */
  characterNames: string[];
  /** Where to download the preview, relative to the service's base address. */
  previewPath: string | null;
}
