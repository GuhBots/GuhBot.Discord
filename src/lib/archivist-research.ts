import {
  ActionRowBuilder,
  type AutocompleteInteraction,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type CommandInteraction,
  type InteractionEditReplyOptions,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { type Actor, actorOf, getArchiveDetails, selectArchive } from "./archivist.js";
import { archivePath, archivistApi } from "./archivist-api.js";
import { searchRecords } from "./archivist-entities.js";
import { ArchivistError } from "./archivist-errors.js";
import { eventEmbed, requestEmbed, shorten } from "./archivist-format.js";
import { lookupCharacters, lookupNames } from "./archivist-intake.js";
import type {
  ArchiveSummary,
  EntityDetails,
  EventDateKind,
  EventDetails,
  RequestDetails,
  SearchHit,
} from "./archivist-types.js";

/**
 * Discord handlers for events and missing-media requests, as a client of the
 * Archivist service. Discord is for quick additions, so the research board,
 * moving requests between buckets, dated history, and character merge are on
 * the website only, by the owner's decisions of 2026-11-23.
 */

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

/** An event with the names of everything it links to, as its read route returns it. */
type NamedEvent = EventDetails & { names?: Record<string, string> };

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

async function buttonArchive(actor: Actor, archiveId: string): Promise<ArchiveSummary> {
  const details = await getArchiveDetails(actor, archiveId);
  return { archiveId: details.archiveId, name: details.name };
}

/** Resolves a server or channel typed by full or short ID. */
async function placeId(
  actor: Actor,
  archiveId: string,
  kind: "server" | "channel",
  value: string,
): Promise<string> {
  const summary = await archivistApi().get<EntityDetails>(
    actor.userId,
    archivePath(archiveId, "entities", kind, value.trim(), "summary"),
  );
  return summary.id;
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

function getEvent(actor: Actor, archiveId: string, id: string): Promise<NamedEvent> {
  return archivistApi().get<NamedEvent>(actor.userId, archivePath(archiveId, "events", id));
}

async function eventReply(
  actor: Actor,
  archive: ArchiveSummary,
  eventId: string,
  headline: string,
): Promise<InteractionEditReplyOptions> {
  const [event, details] = await Promise.all([
    getEvent(actor, archive.archiveId, eventId),
    getArchiveDetails(actor, archive.archiveId),
  ]);
  const name = (id: string) => event.names?.[id] ?? id.slice(0, 8);
  return {
    content: headline,
    embeds: [
      eventEmbed(event, {
        archiveName: archive.name,
        archiveTimeZone: details.timezone,
        characterNames: event.links.characters.map(name),
        placeNames: [
          ...event.links.servers.map(name),
          ...event.links.channels.map((id) => `#${name(id)}`),
        ],
      }),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ax:evedit:${archive.archiveId}:${event.id}:${event.version}`)
          .setLabel("Edit")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`ax:evdel:${archive.archiveId}:${event.id}:${event.version}`)
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
  await interaction.deferReply(ephemeral);
  const actor = await actorOf(interaction);
  const archive = await selectArchive(actor, options.archive);
  const archiveId = archive.archiveId;
  const event = await archivistApi().post<EventDetails>(
    actor.userId,
    archivePath(archiveId, "events"),
    {
      title: options.title,
      description: options.description,
      dateKind: options.kind,
      certainty: options.certainty ?? "exact",
      start: options.start,
      end: options.end,
      color: options.color,
      links: {
        characters: await lookupCharacters(actor, archiveId, options.characters),
        servers: options.server ? [await placeId(actor, archiveId, "server", options.server)] : [],
        channels: options.channel
          ? [await placeId(actor, archiveId, "channel", options.channel)]
          : [],
      },
    },
  );
  await interaction.editReply(
    await eventReply(
      actor,
      archive,
      event.id,
      `Saved to **${archive.name}** - event \`${event.id.slice(0, 8)}\``,
    ),
  );
}

export async function showEventCommand(
  interaction: CommandInteraction,
  options: { archive?: string; id: string },
): Promise<void> {
  await interaction.deferReply(ephemeral);
  const actor = await actorOf(interaction);
  const archive = await selectArchive(actor, options.archive);
  const event = await getEvent(actor, archive.archiveId, options.id);
  await interaction.editReply(
    await eventReply(actor, archive, event.id, `Event \`${event.id.slice(0, 8)}\``),
  );
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
  version?: number,
  kind?: string,
  certainty?: string,
): Promise<void> {
  const event = await getEvent(await actorOf(interaction), archiveId, eventId);
  const dateKind = (kind as EventDateKind | undefined) ?? event.dateKind;
  if (!KIND_CODES[dateKind])
    throw new ArchivistError("invalid_input", "Choose a date kind from the list.", {
      field: "kind",
    });
  const sure = (certainty ?? event.certainty) === "estimated" ? "e" : "x";
  const modal = new ModalBuilder()
    .setCustomId(
      `ax:evform:${archiveId}:${event.id}:${version ?? event.version}:${KIND_CODES[dateKind]}${sure}`,
    )
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
  const actor = await actorOf(interaction);
  await interaction.deferReply(ephemeral);
  const dateKind = KIND_FROM_CODE[codes[0] ?? "s"]!;
  const [archive, current] = await Promise.all([
    buttonArchive(actor, archiveId),
    getEvent(actor, archiveId, eventId),
  ]);
  const description = optionalField(interaction, "description");
  const updated = await archivistApi().patch<EventDetails>(
    actor.userId,
    archivePath(archiveId, "events", current.id),
    {
      expectedVersion: Number(version),
      title: interaction.fields.getTextInputValue("title"),
      // A description too long for the form was left out of it and stays as it is.
      description: description || undefined,
      dateKind,
      certainty: codes[1] === "e" ? "estimated" : "exact",
      start: interaction.fields.getTextInputValue("start"),
      end: dateKind === "single" ? null : interaction.fields.getTextInputValue("end"),
      disputedReason: interaction.fields.getTextInputValue("disputed"),
    },
  );
  await interaction.editReply(
    await eventReply(
      actor,
      archive,
      updated.id,
      updated.version === current.version
        ? "Nothing changed."
        : `Updated event \`${updated.id.slice(0, 8)}\`.`,
    ),
  );
}

/**
 * Asks to confirm deleting an event. The service checks first whether a
 * missing-media request uses it as its date, so a delete it would refuse is
 * refused before the Delete permanently button appears.
 */
export async function askDeleteEvent(
  interaction: CommandInteraction | ButtonInteraction,
  archiveId: string,
  eventId: string,
  version?: number,
): Promise<void> {
  await interaction.deferReply(ephemeral);
  const actor = await actorOf(interaction);
  const event = await getEvent(actor, archiveId, eventId);
  await archivistApi().get(
    actor.userId,
    archivePath(archiveId, "events", event.id, "deletion-check"),
  );
  await interaction.editReply({
    content:
      `Permanently delete event **${shorten(event.title, 100)}**? There is no trash or undo. ` +
      "Its links and its own edit history are removed. The artifacts that supported it stay.",
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ax:evdelc:${archiveId}:${event.id}:${version ?? event.version}`)
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
  await interaction.deferUpdate();
  await archivistApi().delete(
    (await actorOf(interaction)).userId,
    archivePath(archiveId, "events", eventId),
    { expectedVersion: Number(version) },
  );
  await interaction.editReply({
    content: "Deleted the event. The artifacts that supported it stay.",
    components: [],
  });
}

/* Missing-media requests */

async function requestReply(
  actor: Actor,
  archive: ArchiveSummary,
  request: RequestDetails,
  headline: string,
): Promise<InteractionEditReplyOptions> {
  const names = await lookupNames(actor, archive.archiveId, {
    characters: request.characters,
    events: request.events,
  });
  return {
    content: headline,
    embeds: [
      requestEmbed(request, {
        archiveName: archive.name,
        characterNames: request.characters.map((id) => names.characters[id]!),
        eventNames: request.events.map((id) => names.events[id]!),
      }),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ax:rqedit:${archive.archiveId}:${request.id}:${request.version}`)
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
  await interaction.deferReply(ephemeral);
  const actor = await actorOf(interaction);
  const archive = await selectArchive(actor, options.archive);
  const archiveId = archive.archiveId;
  const eventId = options.event ? (await getEvent(actor, archiveId, options.event)).id : undefined;
  const request = await archivistApi().post<RequestDetails>(
    actor.userId,
    archivePath(archiveId, "requests"),
    {
      description: options.description,
      characters: await lookupCharacters(actor, archiveId, options.characters),
      constraint: {
        kind: options.when,
        day: options.day,
        start: options.start,
        end: options.end,
        eventId,
      },
      researchNotes: options.notes,
    },
  );
  await interaction.editReply(
    await requestReply(
      actor,
      archive,
      request,
      `Added to the board in **${archive.name}** - request \`${request.id.slice(0, 8)}\``,
    ),
  );
}

function getRequest(actor: Actor, archiveId: string, id: string): Promise<RequestDetails> {
  return archivistApi().get<RequestDetails>(actor.userId, archivePath(archiveId, "requests", id));
}

export async function showRequestCommand(
  interaction: CommandInteraction,
  options: { archive?: string; id: string },
): Promise<void> {
  await interaction.deferReply(ephemeral);
  const actor = await actorOf(interaction);
  const archive = await selectArchive(actor, options.archive);
  const request = await getRequest(actor, archive.archiveId, options.id);
  await interaction.editReply(
    await requestReply(actor, archive, request, `Request \`${request.id.slice(0, 8)}\``),
  );
}

export async function showRequestForm(
  interaction: CommandInteraction | ButtonInteraction,
  archiveId: string,
  requestId: string,
  version?: number,
): Promise<void> {
  const request = await getRequest(await actorOf(interaction), archiveId, requestId);
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(`ax:rqform:${archiveId}:${request.id}:${version ?? request.version}`)
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
  const actor = await actorOf(interaction);
  await interaction.deferReply(ephemeral);
  const updated = await archivistApi().patch<RequestDetails>(
    actor.userId,
    archivePath(archiveId, "requests", requestId),
    {
      expectedVersion: Number(version),
      description: optionalField(interaction, "description"),
      researchNotes: interaction.fields.getTextInputValue("notes"),
    },
  );
  await interaction.editReply(
    await requestReply(
      actor,
      await buttonArchive(actor, archiveId),
      updated,
      `Updated request \`${updated.id.slice(0, 8)}\`.`,
    ),
  );
}

/* Suggestions */

async function respond(interaction: AutocompleteInteraction, hits: SearchHit[]) {
  await interaction.respond(
    hits.map((hit) => ({
      name: shorten(`${hit.label.replace(/\s+/g, " ")} (${hit.id.slice(0, 8)})`, 100),
      value: hit.id,
    })),
  );
}

export async function suggestEventIds(interaction: AutocompleteInteraction): Promise<void> {
  await respond(
    interaction,
    await searchRecords(interaction, "event", String(interaction.options.getFocused())),
  );
}

export async function suggestRequestIds(interaction: AutocompleteInteraction): Promise<void> {
  await respond(
    interaction,
    await searchRecords(interaction, "request", String(interaction.options.getFocused())),
  );
}
