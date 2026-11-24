import { EmbedBuilder } from "discord.js";
import { dayText, localDateTime, localText } from "./archivist-dates.js";
import type {
  ArtifactDetails,
  DuplicateDifference,
  EntityDetails,
  EventDetails,
  RequestDetails,
  StoredDate,
} from "./archivist-types.js";

/**
 * How Archivist records read in Discord. Stored text is never shortened.
 * Only what an embed shows is cut to Discord's limits, with a pointer to the
 * full record.
 */

export const EMBED_DESCRIPTION_LIMIT = 4096;
const FIELD_LIMIT = 1024;
const OPTION_TEXT_LIMIT = 100;
/** Blurple, the accent color from the Archivist design tokens. */
export const ARCHIVIST_COLOR = 0x5865f2;

/** The name of a preview image attached to a reply. */
export const PREVIEW_ATTACHMENT = "preview.webp";

export function shorten(text: string, limit: number, note = "…"): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - note.length))}${note}`;
}

/**
 * A stored date as contributors read it, with the month's name so no one misreads
 * the order, and in the archive's timezone where it has a time.
 */
export function dateText(date: StoredDate, archiveTimeZone: string): string {
  if (date.kind === "day") return dayText(date.calendarDay);
  if (date.kind === "unknown_local") return `${localText(date.localDateTime)} (timezone unknown)`;
  return `${localText(localDateTime(date.instantMs, archiveTimeZone))} ${archiveTimeZone}`;
}

/** The selected date with its basis, labeled so file dates are never mistaken for verified ones. */
export function selectedDateText(artifact: ArtifactDetails, archiveTimeZone: string): string {
  const selected = artifact.dates.selected;
  if (!selected) {
    return artifact.media.fileDateStatus === "conflict" ||
      artifact.media.fileDateStatus === "malformed"
      ? "Unknown. The file's own dates disagree or are damaged, so set the date by hand."
      : "Unknown";
  }
  const text = dateText(selected.date, archiveTimeZone);
  if (selected.basis === "exact") {
    const basis = artifact.dates.exact?.basis;
    return basis ? `${text} (exact: ${basis})` : `${text} (exact)`;
  }
  if (selected.basis === "estimated") {
    return `around ${text} (estimated: ${artifact.dates.estimated!.reason})`;
  }
  return `${text} (from file metadata, not verified)`;
}

/** How an exact time the contributor typed was read, shown so they can check it. */
export function interpretationNote(artifact: ArtifactDetails): string | null {
  const exact = artifact.dates.exact?.date;
  if (!exact || exact.kind !== "instant") return null;
  if (/^([+-]\d{2}:\d{2}|UTC)$/.test(exact.timezone)) {
    return `"${exact.originalText}" was read with its own offset, ${exact.timezone}.`;
  }
  const local = localText(localDateTime(exact.instantMs, exact.timezone));
  return `"${exact.originalText}" was read as ${local} ${exact.timezone}.`;
}

export interface ArtifactView {
  archiveName: string;
  archiveTimeZone: string;
  characterNames: string[];
  /** Set when a preview image is attached to the message. */
  hasPreviewAttachment: boolean;
  /** Set for public announcements, which credit the contributor. */
  addedBy?: string;
  /** Titles of the events the artifact is evidence for. */
  eventNames?: string[];
}

/** Who is in an artifact, noting when someone in it is not identified yet. */
export function charactersText(names: string[], unidentifiedCharacters: boolean): string {
  if (!unidentifiedCharacters) return names.length ? names.join(", ") : "No characters linked yet";
  return names.length
    ? `${names.join(", ")}, and an unidentified character`
    : "An unidentified character";
}

/** The embed for an artifact, used in private replies and public announcements. */
export function artifactEmbed(artifact: ArtifactDetails, view: ArtifactView): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(ARCHIVIST_COLOR)
    .setTitle(shorten(`${view.archiveName} - artifact ${artifact.id.slice(0, 8)}`, 256))
    .setDescription(
      shorten(
        artifact.description,
        EMBED_DESCRIPTION_LIMIT,
        "…\n\nThe full description is in `/archivist artifact show`.",
      ),
    )
    .addFields(
      {
        name: "Characters",
        value: shorten(
          charactersText(view.characterNames, artifact.unidentifiedCharacters),
          FIELD_LIMIT,
        ),
      },
      {
        name: "Date",
        value: shorten(selectedDateText(artifact, view.archiveTimeZone), FIELD_LIMIT),
      },
    );
  if (view.eventNames?.length) {
    embed.addFields({ name: "Events", value: shorten(view.eventNames.join(", "), FIELD_LIMIT) });
  }
  if (view.addedBy) embed.addFields({ name: "Added by", value: `<@${view.addedBy}>` });
  if (view.hasPreviewAttachment) {
    embed.setImage(`attachment://${PREVIEW_ATTACHMENT}`);
  } else if (artifact.media.mimeType.startsWith("video/")) {
    embed.addFields({ name: "File", value: `Video, ${artifact.media.originalFilename}` });
  } else if (artifact.media.mimeType.startsWith("audio/")) {
    embed.addFields({ name: "File", value: `Audio, ${artifact.media.originalFilename}` });
  } else {
    embed.addFields({
      name: "File",
      value: `${artifact.media.originalFilename} (no preview available)`,
    });
  }
  return embed;
}

const DIFFERENCE_LABELS: Record<DuplicateDifference["key"], string> = {
  description: "Description",
  exactDate: "Exact date",
  estimatedDate: "Estimated date",
  characters: "Add characters",
  accounts: "Add accounts",
  servers: "Add servers",
  channels: "Add channels",
  events: "Add events",
};

/** A select-menu option for one duplicate-review difference. */
export function differenceOption(
  difference: DuplicateDifference,
  names: (kind: DuplicateDifference["key"], ids: string[]) => string[],
): { label: string; value: string; description: string } {
  const label = DIFFERENCE_LABELS[difference.key];
  const isLink = !["description", "exactDate", "estimatedDate"].includes(difference.key);
  const description = isLink
    ? names(difference.key, difference.proposed.split(",")).join(", ")
    : `${difference.current || "none"} -> ${difference.proposed}`;
  return {
    label,
    value: difference.key,
    description: shorten(description, OPTION_TEXT_LIMIT),
  };
}

const ENTITY_TITLES: Record<EntityDetails["kind"], string> = {
  character: "Character",
  account: "Account",
  server: "Server",
  channel: "Channel",
};

/** The embed for a character, account, server, or channel. */
export function entityEmbed(entity: EntityDetails, archiveName: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(ARCHIVIST_COLOR)
    .setTitle(shorten(`${ENTITY_TITLES[entity.kind]}: ${entity.name}`, 256))
    .setDescription(`${archiveName} - \`${entity.id.slice(0, 8)}\` - version ${entity.version}`)
    .addFields(
      entity.fields.map(([name, value]) => ({
        name,
        value: shorten(value, FIELD_LIMIT),
        inline: value.length < 40,
      })),
    );
}

/** When an event happened, with the meaning of its range in words. */
export function eventWhen(event: EventDetails, archiveTimeZone: string): string {
  const start = dateText(event.start, archiveTimeZone);
  const certainty = event.certainty === "estimated" ? " (estimated)" : "";
  if (event.dateKind === "single") return `${start}${certainty}`;
  const end = dateText(event.end!, archiveTimeZone);
  return event.dateKind === "duration"
    ? `Lasted from ${start} to ${end}${certainty}`
    : `Happened sometime between ${start} and ${end}${certainty}`;
}

export interface EventView {
  archiveName: string;
  archiveTimeZone: string;
  characterNames: string[];
  placeNames: string[];
}

/** The embed for an event. */
export function eventEmbed(event: EventDetails, view: EventView): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(Number.parseInt(event.color.slice(1), 16))
    .setTitle(shorten(event.title, 256))
    .setDescription(shorten(event.description, EMBED_DESCRIPTION_LIMIT, "…"))
    .addFields(
      { name: "When", value: shorten(eventWhen(event, view.archiveTimeZone), FIELD_LIMIT) },
      {
        name: "Characters",
        value: shorten(view.characterNames.join(", ") || "No characters linked yet", FIELD_LIMIT),
      },
      { name: "Places", value: shorten(view.placeNames.join(", ") || "None linked", FIELD_LIMIT) },
      {
        name: "Evidence",
        value: event.supportingArtifacts.length
          ? `${event.supportingArtifacts.length} artifact${event.supportingArtifacts.length === 1 ? "" : "s"}`
          : "No supporting artifacts",
      },
    )
    .setFooter({
      text: `${view.archiveName} - event ${event.id.slice(0, 8)} - lane color ${event.color}`,
    });
  if (event.disputedReason)
    embed.addFields({ name: "Disputed", value: shorten(event.disputedReason, FIELD_LIMIT) });
  return embed;
}

/** The embed for a missing-media request. */
export function requestEmbed(
  request: RequestDetails,
  view: { archiveName: string; characterNames: string[]; eventNames: string[] },
): EmbedBuilder {
  const status =
    request.status === "resolved"
      ? `Resolved. Found in ${request.foundArtifacts.map((id) => `\`${id.slice(0, 8)}\``).join(", ")}`
      : request.status === "unrecoverable"
        ? `Unrecoverable: ${request.unrecoverableReason}`
        : "Needed";
  const embed = new EmbedBuilder()
    .setColor(ARCHIVIST_COLOR)
    .setTitle(shorten(request.label, 256))
    .setDescription(shorten(request.description, EMBED_DESCRIPTION_LIMIT, "…"))
    .addFields(
      { name: "When", value: shorten(request.wording, FIELD_LIMIT) },
      { name: "Characters", value: shorten(view.characterNames.join(", "), FIELD_LIMIT) },
      { name: "Status", value: shorten(status, FIELD_LIMIT) },
    )
    .setFooter({
      text: `${view.archiveName} - request ${request.id.slice(0, 8)} - priority ${request.priority}`,
    });
  if (view.eventNames.length)
    embed.addFields({ name: "Events", value: shorten(view.eventNames.join(", "), FIELD_LIMIT) });
  if (request.researchNotes)
    embed.addFields({ name: "Notes", value: shorten(request.researchNotes, FIELD_LIMIT) });
  return embed;
}
