import {
  ActionRowBuilder,
  type AutocompleteInteraction,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type CommandInteraction,
  type InteractionReplyOptions,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { registeredArchive } from "../archivist/access.js";
import { archiveDetails } from "../archivist/archives.js";
import { type ArchivistContext, openStore } from "../archivist/context.js";
import {
  assertEventDeletable,
  createEvent,
  deleteEvent,
  type EventDateKind,
  type EventDetails,
  getEvent,
  updateEvent,
} from "../archivist/events.js";
import { ArchivistError } from "../archivist/errors.js";
import { characterNames, resolveCharacters, resolveShortId } from "../archivist/lookup.js";
import { resolveArchiveSelection } from "../archivist/preferences.js";
import {
  type ConstraintInput,
  createRequest,
  getRequest,
  type RequestDetails,
  updateRequest,
} from "../archivist/requests.js";
import { searchEvents, searchRequests } from "../archivist/search.js";
import { actorOf, archivist } from "./archivist.js";
import { typedArchive } from "./archivist-entities.js";
import { eventEmbed, requestEmbed, shorten } from "./archivist-format.js";

/**
 * Discord handlers for events and missing-media requests. Discord is for
 * quick additions, so the research board, moving requests between buckets,
 * dated history, and character merge are on the website only, by the
 * owner's decisions of 2026-11-23.
 */

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

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
        characterNames: characterNames(db, event.links.characters),
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
  characters?: string;
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
      characters: resolveCharacters(db, options.characters),
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
 * Shows the event form bound to the version the contributor saw. A changed date
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
  assertEventDeletable(openStore(archivist(), archiveId).db, event.id);
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
        characterNames: characterNames(db, request.characters),
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
  characters: string;
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
    characters: resolveCharacters(db, options.characters),
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
