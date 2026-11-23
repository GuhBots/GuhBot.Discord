import {
  ActionRowBuilder,
  type AutocompleteInteraction,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type CommandInteraction,
  EmbedBuilder,
  type InteractionReplyOptions,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { registeredArchive } from "../archivist/access.js";
import { archiveDetails } from "../archivist/archives.js";
import {
  flagForResearch,
  type GapKind,
  type GapStatus,
  listGapCards,
  updateGapCard,
} from "../archivist/board.js";
import { type ArchivistContext, openStore } from "../archivist/context.js";
import {
  createEvent,
  deleteEvent,
  type EventDateKind,
  type EventDetails,
  getEvent,
  updateEvent,
} from "../archivist/events.js";
import { ArchivistError } from "../archivist/errors.js";
import { peopleNames, resolvePeople, resolveShortId } from "../archivist/people.js";
import { resolveArchiveSelection } from "../archivist/preferences.js";
import {
  type ConstraintInput,
  createRequest,
  getRequest,
  listRequests,
  type RequestDetails,
  type RequestStatus,
  updateRequest,
} from "../archivist/requests.js";
import {
  searchArtifacts,
  searchEntities,
  searchEvents,
  searchRequests,
} from "../archivist/search.js";
import { actorOf, archivist } from "./archivist.js";
import { typedArchive } from "./archivist-entities.js";
import {
  ARCHIVIST_COLOR,
  boardLine,
  eventEmbed,
  requestEmbed,
  requestLine,
  shorten,
} from "./archivist-format.js";

/**
 * Discord handlers for events, missing-media requests, and the research
 * board. Dated history and character merge are website-only, by the owner's
 * decision of 2026-11-23.
 */

const ephemeral = { flags: MessageFlags.Ephemeral } as const;
const BOARD_LINES = 20;

function archiveName(context: ArchivistContext, archiveId: string): string {
  return registeredArchive(context, archiveId)?.name ?? "the archive";
}

function names(
  context: ArchivistContext,
  archiveId: string,
  table: "servers" | "channels" | "events",
  ids: string[],
) {
  const column = table === "events" ? "title" : "label";
  const statement = openStore(context, archiveId).db.prepare(
    `SELECT ${column} AS name FROM ${table} WHERE id = ?`,
  );
  return ids.map(
    (id) => (statement.get(id) as { name: string } | undefined)?.name ?? id.slice(0, 8),
  );
}

/** A form field's value, or undefined when the form left that field out. */
function optionalField(interaction: ModalSubmitInteraction, id: string): string | undefined {
  try {
    return interaction.fields.getTextInputValue(id);
  } catch {
    return undefined;
  }
}

/** Form rows, leaving out a description too long for a form so it stays as it is. */
function rows(...items: (ActionRowBuilder<TextInputBuilder> | null)[]) {
  return items.filter((item): item is ActionRowBuilder<TextInputBuilder> => item !== null);
}

/* Events */

const KIND_CODES: Record<EventDateKind, string> = {
  single: "s",
  duration: "d",
  occurrence_window: "w",
};
const KIND_FROM_CODE: Record<string, EventDateKind> = {
  s: "single",
  d: "duration",
  w: "occurrence_window",
};

function eventReply(
  context: ArchivistContext,
  archiveId: string,
  event: EventDetails,
  headline: string,
): InteractionReplyOptions {
  const db = openStore(context, archiveId).db;
  return {
    content: headline,
    embeds: [
      eventEmbed(event, {
        archiveName: archiveName(context, archiveId),
        archiveTimeZone: archiveDetails(openStore(context, archiveId)).timezone,
        peopleNames: peopleNames(db, event.links.people),
        placeNames: [
          ...names(context, archiveId, "servers", event.links.servers),
          ...names(context, archiveId, "channels", event.links.channels).map((name) => `#${name}`),
        ],
      }),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ax:evedit:${archiveId}:${event.id}:${event.version}`)
          .setLabel("Edit")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`ax:evdel:${archiveId}:${event.id}:${event.version}`)
          .setLabel("Delete")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

export interface EventOptions {
  archive?: string;
  title: string;
  description: string;
  kind: string;
  certainty?: string;
  start: string;
  end?: string;
  people?: string;
  server?: string;
  channel?: string;
  color?: string;
}

export async function createEventFromCommand(
  interaction: CommandInteraction,
  options: EventOptions,
): Promise<void> {
  const context = archivist();
  const actor = await actorOf(interaction);
  const archive = resolveArchiveSelection(context, actor, options.archive);
  const db = openStore(context, archive.archiveId).db;
  const event = createEvent(context, actor, {
    archiveId: archive.archiveId,
    title: options.title,
    description: options.description,
    dateKind: options.kind,
    certainty: options.certainty ?? "exact",
    start: options.start,
    end: options.end,
    color: options.color,
    links: {
      people: resolvePeople(db, options.people),
      servers: options.server ? [resolveShortId(db, "servers", options.server, "server")] : [],
      channels: options.channel ? [resolveShortId(db, "channels", options.channel, "channel")] : [],
    },
  });
  await interaction.reply({
    ...ephemeral,
    ...eventReply(
      context,
      archive.archiveId,
      event,
      `Saved to **${archive.name}** - event \`${event.id.slice(0, 8)}\``,
    ),
  });
}

export async function showEventCommand(
  interaction: CommandInteraction,
  options: { archive?: string; id: string },
): Promise<void> {
  const context = archivist();
  const actor = await actorOf(interaction);
  const archive = resolveArchiveSelection(context, actor, options.archive);
  const event = getEvent(context, actor, { archiveId: archive.archiveId, id: options.id });
  await interaction.reply({
    ...ephemeral,
    ...eventReply(context, archive.archiveId, event, `Event \`${event.id.slice(0, 8)}\``),
  });
}

function eventInput(
  id: string,
  label: string,
  value: string | null | undefined,
  style: TextInputStyle,
  max: number,
  required = false,
) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style)
    .setRequired(required)
    .setMaxLength(max);
  if (value) input.setValue(value);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

/**
 * Shows the event form bound to the version the person saw. A changed date
 * kind or certainty, chosen in the command, travels with the form.
 */
export async function showEventForm(
  interaction: CommandInteraction | ButtonInteraction,
  archiveId: string,
  eventId: string,
  version: number,
  kind?: string,
  certainty?: string,
): Promise<void> {
  const event = getEvent(archivist(), await actorOf(interaction), { archiveId, id: eventId });
  const dateKind = (kind as EventDateKind | undefined) ?? event.dateKind;
  if (!KIND_CODES[dateKind])
    throw new ArchivistError("invalid_input", "Choose a date kind from the list.", {
      field: "kind",
    });
  const sure = (certainty ?? event.certainty) === "estimated" ? "e" : "x";
  const modal = new ModalBuilder()
    .setCustomId(`ax:evform:${archiveId}:${event.id}:${version}:${KIND_CODES[dateKind]}${sure}`)
    .setTitle(shorten(`Edit event ${event.id.slice(0, 8)}`, 45))
    .addComponents(
      ...rows(
        eventInput("title", "Title", event.title, TextInputStyle.Short, 200, true),
        event.description.length <= 4000
          ? eventInput(
              "description",
              "Description",
              event.description,
              TextInputStyle.Paragraph,
              4000,
              true,
            )
          : null,
        eventInput(
          "start",
          dateKind === "single" ? "Day" : "Start",
          event.start.originalText,
          TextInputStyle.Short,
          100,
          true,
        ),
        eventInput(
          "end",
          dateKind === "single" ? "End (single-day events have none)" : "End",
          event.end?.originalText,
          TextInputStyle.Short,
          100,
        ),
        eventInput(
          "disputed",
          "Disputed? Say why, or leave empty",
          event.disputedReason,
          TextInputStyle.Paragraph,
          4000,
        ),
      ),
    );
  await interaction.showModal(modal);
}

export async function openEventEdit(interaction: ButtonInteraction): Promise<void> {
  const [, , archiveId = "", eventId = "", version = ""] = interaction.customId.split(":");
  await showEventForm(interaction, archiveId, eventId, Number(version));
}

export async function submitEventForm(interaction: ModalSubmitInteraction): Promise<void> {
  const [, , archiveId = "", eventId = "", version = "", codes = "sx"] =
    interaction.customId.split(":");
  const context = archivist();
  const actor = await actorOf(interaction);
  const field = (id: string) => interaction.fields.getTextInputValue(id);
  const dateKind = KIND_FROM_CODE[codes[0] ?? "s"]!;
  const current = getEvent(context, actor, { archiveId, id: eventId });
  const updated = updateEvent(context, actor, {
    archiveId,
    id: eventId,
    expectedVersion: Number(version),
    title: field("title"),
    description:
      field("description") ||
      (current.description.length > 4000 ? undefined : field("description")),
    dateKind,
    certainty: codes[1] === "e" ? "estimated" : "exact",
    start: field("start"),
    end: dateKind === "single" ? null : field("end"),
    disputedReason: field("disputed"),
  });
  await interaction.reply({
    ...ephemeral,
    ...eventReply(
      context,
      archiveId,
      updated,
      updated.version === current.version
        ? "Nothing changed."
        : `Updated event \`${updated.id.slice(0, 8)}\`.`,
    ),
  });
}

export async function askDeleteEvent(
  interaction: CommandInteraction | ButtonInteraction,
  archiveId: string,
  eventId: string,
  version: number,
): Promise<void> {
  const event = getEvent(archivist(), await actorOf(interaction), { archiveId, id: eventId });
  await interaction.reply({
    ...ephemeral,
    content:
      `Permanently delete event **${shorten(event.title, 100)}**? There is no trash or undo. ` +
      "Its links and its own edit history are removed. The artifacts that supported it stay.",
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ax:evdelc:${archiveId}:${event.id}:${version}`)
          .setLabel("Delete permanently")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
    allowedMentions: { parse: [] },
  });
}

export async function askDeleteEventButton(interaction: ButtonInteraction): Promise<void> {
  const [, , archiveId = "", eventId = "", version = ""] = interaction.customId.split(":");
  await askDeleteEvent(interaction, archiveId, eventId, Number(version));
}

export async function confirmDeleteEvent(interaction: ButtonInteraction): Promise<void> {
  const [, , archiveId = "", eventId = "", version = ""] = interaction.customId.split(":");
  deleteEvent(archivist(), await actorOf(interaction), {
    archiveId,
    id: eventId,
    expectedVersion: Number(version),
  });
  await interaction.update({
    content: "Deleted the event. The artifacts that supported it stay.",
    components: [],
  });
}

/* Missing-media requests */

function requestReply(
  context: ArchivistContext,
  archiveId: string,
  request: RequestDetails,
  headline: string,
): InteractionReplyOptions {
  const db = openStore(context, archiveId).db;
  return {
    content: headline,
    embeds: [
      requestEmbed(request, {
        archiveName: archiveName(context, archiveId),
        peopleNames: peopleNames(db, request.people),
        eventNames: names(context, archiveId, "events", request.events),
      }),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ax:rqedit:${archiveId}:${request.id}:${request.version}`)
          .setLabel("Edit")
          .setStyle(ButtonStyle.Primary),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

export interface RequestOptions {
  archive?: string;
  description: string;
  people: string;
  when: string;
  day?: string;
  start?: string;
  end?: string;
  event?: string;
  notes?: string;
}

export async function createRequestFromCommand(
  interaction: CommandInteraction,
  options: RequestOptions,
): Promise<void> {
  const context = archivist();
  const actor = await actorOf(interaction);
  const archive = resolveArchiveSelection(context, actor, options.archive);
  const db = openStore(context, archive.archiveId).db;
  const constraint: ConstraintInput = {
    kind: options.when,
    day: options.day,
    start: options.start,
    end: options.end,
    eventId: options.event,
  };
  const needs: Record<string, (keyof RequestOptions)[]> = {
    approximate_day: ["day"],
    before_date: ["day"],
    date_range: ["start", "end"],
    before_event: ["event"],
    after_event: ["event"],
  };
  const missing = (needs[options.when] ?? []).filter((option) => !options[option]);
  if (missing.length) {
    throw new ArchivistError(
      "invalid_input",
      `That choice of when also needs ${missing.join(" and ")}.`,
      { field: missing[0] },
    );
  }
  const request = createRequest(context, actor, {
    archiveId: archive.archiveId,
    description: options.description,
    people: resolvePeople(db, options.people),
    constraint,
    researchNotes: options.notes,
  });
  await interaction.reply({
    ...ephemeral,
    ...requestReply(
      context,
      archive.archiveId,
      request,
      `Added to the board in **${archive.name}** - request \`${request.id.slice(0, 8)}\``,
    ),
  });
}

export async function showRequestCommand(
  interaction: CommandInteraction,
  options: { archive?: string; id: string },
): Promise<void> {
  const context = archivist();
  const actor = await actorOf(interaction);
  const archive = resolveArchiveSelection(context, actor, options.archive);
  const request = getRequest(context, actor, { archiveId: archive.archiveId, id: options.id });
  await interaction.reply({
    ...ephemeral,
    ...requestReply(context, archive.archiveId, request, `Request \`${request.id.slice(0, 8)}\``),
  });
}

export async function showRequestForm(
  interaction: CommandInteraction | ButtonInteraction,
  archiveId: string,
  requestId: string,
  version: number,
): Promise<void> {
  const request = getRequest(archivist(), await actorOf(interaction), { archiveId, id: requestId });
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(`ax:rqform:${archiveId}:${request.id}:${version}`)
      .setTitle(shorten(`Edit request ${request.id.slice(0, 8)}`, 45))
      .addComponents(
        ...rows(
          request.description.length <= 4000
            ? eventInput(
                "description",
                "What is missing",
                request.description,
                TextInputStyle.Paragraph,
                4000,
                true,
              )
            : null,
          eventInput(
            "notes",
            "Research notes",
            request.researchNotes?.slice(0, 4000),
            TextInputStyle.Paragraph,
            4000,
          ),
        ),
      ),
  );
}

export async function openRequestEdit(interaction: ButtonInteraction): Promise<void> {
  const [, , archiveId = "", requestId = "", version = ""] = interaction.customId.split(":");
  await showRequestForm(interaction, archiveId, requestId, Number(version));
}

export async function submitRequestForm(interaction: ModalSubmitInteraction): Promise<void> {
  const [, , archiveId = "", requestId = "", version = ""] = interaction.customId.split(":");
  const context = archivist();
  const actor = await actorOf(interaction);
  const updated = updateRequest(context, actor, {
    archiveId,
    id: requestId,
    expectedVersion: Number(version),
    description: optionalField(interaction, "description"),
    researchNotes: interaction.fields.getTextInputValue("notes"),
  });
  await interaction.reply({
    ...ephemeral,
    ...requestReply(context, archiveId, updated, `Updated request \`${updated.id.slice(0, 8)}\`.`),
  });
}

/**
 * Moves a request between buckets from a command. The command states the
 * outcome, so it applies to the request as it is now, and the reply shows
 * the result.
 */
export async function moveRequestCommand(
  interaction: CommandInteraction,
  options: {
    archive?: string;
    id: string;
    status: RequestStatus;
    artifact?: string;
    reason?: string;
  },
): Promise<void> {
  const context = archivist();
  const actor = await actorOf(interaction);
  const archive = resolveArchiveSelection(context, actor, options.archive);
  const current = getRequest(context, actor, { archiveId: archive.archiveId, id: options.id });
  const db = openStore(context, archive.archiveId).db;
  const updated = updateRequest(context, actor, {
    archiveId: archive.archiveId,
    id: current.id,
    expectedVersion: current.version,
    status: options.status,
    foundArtifacts: options.artifact
      ? [resolveShortId(db, "artifacts", options.artifact, "artifact")]
      : undefined,
    unrecoverableReason: options.reason,
  });
  const headline = {
    needed: "Moved back to Needed. Its description and date are unchanged.",
    resolved: "Marked resolved.",
    unrecoverable: "Moved to Unrecoverable. It can be reopened if it turns up.",
  }[updated.status];
  await interaction.reply({
    ...ephemeral,
    ...requestReply(context, archive.archiveId, updated, headline),
  });
}

/* Research board */

export async function backlogListCommand(
  interaction: CommandInteraction,
  options: { archive?: string; show?: string; only?: string },
): Promise<void> {
  const context = archivist();
  const actor = await actorOf(interaction);
  const archive = resolveArchiveSelection(context, actor, options.archive);
  const status = (options.show ?? "needed") as GapStatus & RequestStatus;
  const lines = [
    ...(options.only === "gaps"
      ? []
      : listRequests(context, actor, { archiveId: archive.archiveId, status }).map(requestLine)),
    ...(options.only === "requests"
      ? []
      : listGapCards(context, actor, { archiveId: archive.archiveId, status }).map(boardLine)),
  ];
  const shown = lines.slice(0, BOARD_LINES);
  const embed = new EmbedBuilder()
    .setColor(ARCHIVIST_COLOR)
    .setTitle(shorten(`${archive.name} - research board, ${status}`, 256))
    .setDescription(shorten(shown.join("\n") || "Nothing here.", 4096))
    .setFooter({
      text:
        lines.length > shown.length
          ? `Showing ${shown.length} of ${lines.length}. The website shows the whole board.`
          : `${lines.length} item${lines.length === 1 ? "" : "s"}. Nobody is assigned anything.`,
    });
  await interaction.reply({ ...ephemeral, embeds: [embed], allowedMentions: { parse: [] } });
}

export async function backlogFlagCommand(
  interaction: CommandInteraction,
  options: {
    archive?: string;
    kind: string;
    recordKind?: string;
    record: string;
    reason: string;
    field?: string;
  },
): Promise<void> {
  const context = archivist();
  const actor = await actorOf(interaction);
  const archive = resolveArchiveSelection(context, actor, options.archive);
  const card = flagForResearch(context, actor, {
    archiveId: archive.archiveId,
    kind: options.kind,
    subjectKind: options.kind === "date_research" ? "artifact" : (options.recordKind ?? "artifact"),
    subjectId: options.record,
    reason: options.reason,
    field: options.field,
  });
  await interaction.reply({
    ...ephemeral,
    content: `On the board: ${boardLine(card)}`,
    allowedMentions: { parse: [] },
  });
}

export async function backlogUpdateCommand(
  interaction: CommandInteraction,
  options: { archive?: string; card: string; status: string; reason?: string },
): Promise<void> {
  const context = archivist();
  const actor = await actorOf(interaction);
  const archive = resolveArchiveSelection(context, actor, options.archive);
  const db = openStore(context, archive.archiveId).db;
  const id = resolveShortId(db, "gap_cards", options.card, "card");
  const { version } = db.prepare("SELECT version FROM gap_cards WHERE id = ?").get(id) as {
    version: number;
  };
  const card = updateGapCard(context, actor, {
    archiveId: archive.archiveId,
    id,
    expectedVersion: version,
    status: options.status,
    reason: options.reason,
  });
  await interaction.reply({
    ...ephemeral,
    content: `Updated: ${boardLine(card)} is now ${card.status}.`,
    allowedMentions: { parse: [] },
  });
}

/* Suggestions */

async function respond(
  interaction: AutocompleteInteraction,
  hits: { id: string; label: string }[],
) {
  await interaction.respond(
    hits.map((hit) => ({
      name: shorten(`${hit.label.replace(/\s+/g, " ")} (${hit.id.slice(0, 8)})`, 100),
      value: hit.id,
    })),
  );
}

export async function suggestEventIds(interaction: AutocompleteInteraction): Promise<void> {
  const archiveId = await typedArchive(interaction);
  if (!archiveId) return interaction.respond([]);
  await respond(
    interaction,
    searchEvents(openStore(archivist(), archiveId).db, String(interaction.options.getFocused())),
  );
}

export async function suggestRequestIds(interaction: AutocompleteInteraction): Promise<void> {
  const archiveId = await typedArchive(interaction);
  if (!archiveId) return interaction.respond([]);
  await respond(
    interaction,
    searchRequests(openStore(archivist(), archiveId).db, String(interaction.options.getFocused())),
  );
}

/** Cards still open, matching what was typed. */
export async function suggestCardIds(interaction: AutocompleteInteraction): Promise<void> {
  const archiveId = await typedArchive(interaction);
  if (!archiveId) return interaction.respond([]);
  const typed = String(interaction.options.getFocused()).toLowerCase();
  const cards = listGapCards(archivist(), await actorOf(interaction), { archiveId })
    .filter((card) => card.status !== "resolved")
    .filter(
      (card) =>
        !typed || card.subject.label.toLowerCase().includes(typed) || card.id.startsWith(typed),
    )
    .slice(0, 25);
  await respond(
    interaction,
    cards.map((card) => ({
      id: card.id,
      label: `${card.kind.replace("_", " ")}: ${card.subject.label}`,
    })),
  );
}

/** Records for a research flag, of the kind chosen in the same command. */
export async function suggestRecordIds(interaction: AutocompleteInteraction): Promise<void> {
  const archiveId = await typedArchive(interaction);
  if (!archiveId) return interaction.respond([]);
  const db = openStore(archivist(), archiveId).db;
  const typed = String(interaction.options.getFocused());
  const kind =
    interaction.options.getString("kind") === "date_research"
      ? "artifact"
      : (interaction.options.getString("record_kind") ?? "artifact");
  const hits =
    kind === "artifact"
      ? searchArtifacts(db, typed)
      : kind === "event"
        ? searchEvents(db, typed)
        : kind === "character" || kind === "account" || kind === "server"
          ? searchEntities(db, kind, typed)
          : [];
  await respond(interaction, hits);
}

export type { GapKind };
