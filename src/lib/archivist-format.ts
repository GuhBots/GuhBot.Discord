import { EmbedBuilder } from "discord.js";
import type { ArtifactDetails, DuplicateDifference } from "../archivist/artifacts.js";
import { localDateTime } from "../archivist/dates.js";
import type { StoredDate } from "../archivist/date-store.js";
import type { EntityDetails } from "../archivist/entities.js";

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

/** A stored date as people read it, in the archive's timezone where it has a time. */
export function dateText(date: StoredDate, archiveTimeZone: string): string {
  if (date.kind === "day") return date.calendarDay;
  if (date.kind === "unknown_local") {
    return `${date.localDateTime.replace("T", " ").slice(0, 16)} (timezone unknown)`;
  }
  const local = localDateTime(date.instantMs, archiveTimeZone).replace("T", " ").slice(0, 16);
  return `${local} ${archiveTimeZone}`;
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
  if (selected.basis === "exact") return `${text} (exact: ${artifact.dates.exact!.basis})`;
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
  const local = localDateTime(exact.instantMs, exact.timezone).replace("T", " ").slice(0, 16);
  return `"${exact.originalText}" was read as ${local} ${exact.timezone}.`;
}

export interface ArtifactView {
  archiveName: string;
  archiveTimeZone: string;
  peopleNames: string[];
  /** Set when a preview image is attached to the message. */
  hasPreviewAttachment: boolean;
  /** Set for public announcements, which credit the contributor. */
  addedBy?: string;
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
        name: "People",
        value: shorten(
          view.peopleNames.length
            ? view.peopleNames.join(", ")
            : artifact.identificationState === "complete"
              ? "Nobody identifiable"
              : "Not identified yet",
          FIELD_LIMIT,
        ),
      },
      {
        name: "Date",
        value: shorten(selectedDateText(artifact, view.archiveTimeZone), FIELD_LIMIT),
      },
    );
  if (view.addedBy) embed.addFields({ name: "Added by", value: `<@${view.addedBy}>` });
  if (view.hasPreviewAttachment) {
    embed.setImage(`attachment://${PREVIEW_ATTACHMENT}`);
  } else if (artifact.media.mimeType.startsWith("video/")) {
    embed.addFields({ name: "File", value: `Video, ${artifact.media.originalFilename}` });
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
  identificationState: "Identification",
  people: "Add people",
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
  const isLink = !["description", "exactDate", "estimatedDate", "identificationState"].includes(
    difference.key,
  );
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
