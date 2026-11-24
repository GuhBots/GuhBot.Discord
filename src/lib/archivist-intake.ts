import { createWriteStream, mkdtempSync, openAsBlob, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  ActionRowBuilder,
  type Attachment,
  AttachmentBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type Client,
  type CommandInteraction,
  type InteractionEditReplyOptions,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { type Actor, actorOf, getArchiveDetails, selectArchive } from "./archivist.js";
import { type ArchivistApi, archivePath, archivistApi } from "./archivist-api.js";
import { announceNow, announcementNote } from "./archivist-announce.js";
import { dayText } from "./archivist-dates.js";
import { ArchivistError } from "./archivist-errors.js";
import {
  artifactEmbed,
  differenceOption,
  interpretationNote,
  PREVIEW_ATTACHMENT,
  shorten,
} from "./archivist-format.js";
import { recall, remember } from "./archivist-pending.js";
import type {
  ArchiveSummary,
  ArtifactDetails,
  DatePreview,
  DuplicateDifference,
  EventDetails,
  IntakeReply,
} from "./archivist-types.js";

/**
 * The Discord artifact flow the owner approved, as a client of the Archivist
 * service: intake from an attachment or a Drive link, a confirmation when a
 * typed time has no zone, duplicate review, and the reply's Edit, Add
 * characters/events, Someone unidentified, and Delete buttons. The service
 * checks every field and access. The bot only downloads a Discord attachment
 * and forwards its bytes, because the service never reaches into Discord.
 */

const ephemeral = { flags: MessageFlags.Ephemeral } as const;
const MODAL_TEXT_LIMIT = 4000;
/** The service's limit for one original file. */
export const MAX_MEDIA_BYTES = 104_857_600;
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 2 * 60_000;
const DISCORD_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

type Respond = (payload: InteractionEditReplyOptions) => Promise<unknown>;

type FileSource =
  | { kind: "attachment"; id: string; url: string; size: number; name: string }
  | { kind: "drive"; link: string };

/** What the contributor typed, already resolved to record IDs. */
export interface IntakeFields {
  description: string;
  characters: string[];
  events: string[];
  exactDate?: string;
  estimatedDay?: string;
  estimateReason?: string;
  guildId?: string;
  channelId?: string;
}

interface PendingIntake {
  kind: "intake";
  archive: ArchiveSummary;
  fields: IntakeFields;
  file: FileSource;
}

interface PendingEdit {
  kind: "edit";
  archive: ArchiveSummary;
  artifactId: string;
  body: Record<string, unknown>;
}

interface PendingReview {
  archive: ArchiveSummary;
  reviewToken: string;
  artifactId: string;
  selected: string[];
}

export interface IntakeOptions {
  archive?: string;
  description: string;
  file?: Attachment;
  driveLink?: string;
  characters?: string;
  exactDate?: string;
  estimatedDay?: string;
  estimateReason?: string;
  /** One event the artifact is evidence for, by ID. More are added from the reply. */
  event?: string;
}

function invalid(message: string, field: string): ArchivistError {
  return new ArchivistError("invalid_input", message, { field });
}

/** The typed exact date, or undefined when the field was left empty. */
function exactText(date?: string): string | undefined {
  return date?.trim() ? date : undefined;
}

function estimatePair(day?: string, reason?: string) {
  if (!day?.trim() && !reason?.trim()) return undefined;
  if (!day?.trim())
    throw invalid("estimate_reason needs an estimated_day to go with it.", "estimated_day");
  if (!reason?.trim())
    throw invalid("An estimated day needs estimate_reason, saying why.", "estimate_reason");
  return { day, reason };
}

/** Custom IDs carry the archive, the record, and the version the contributor saw. */
function recordId(action: string, archiveId: string, artifactId: string, version: number): string {
  return `ax:${action}:${archiveId}:${artifactId}:${version}`;
}

function parseRecordId(customId: string): {
  archiveId: string;
  artifactId: string;
  version: number;
} {
  const [, , archiveId = "", artifactId = "", version = ""] = customId.split(":");
  return { archiveId, artifactId, version: Number(version) };
}

function artifactPath(archiveId: string, artifactId: string): string {
  return archivePath(archiveId, "artifacts", artifactId);
}

export function getArtifact(
  actor: Actor,
  archiveId: string,
  id: string,
  api: ArchivistApi = archivistApi(),
): Promise<ArtifactDetails> {
  return api.get<ArtifactDetails>(actor.userId, artifactPath(archiveId, id));
}

/** Resolves typed character names, aliases, or `Name (shortid)` tags to IDs. */
export async function lookupCharacters(
  actor: Actor,
  archiveId: string,
  typed: string | undefined,
): Promise<string[]> {
  if (!typed?.trim()) return [];
  const { characters } = await archivistApi().get<{ characters: { id: string }[] }>(
    actor.userId,
    archivePath(archiveId, "lookup", "characters"),
    { names: typed },
  );
  return characters.map((character) => character.id);
}

/** Resolves typed event titles or short IDs to IDs. */
export async function lookupEvents(
  actor: Actor,
  archiveId: string,
  typed: string | undefined,
): Promise<string[]> {
  if (!typed?.trim()) return [];
  const { events } = await archivistApi().get<{ events: { id: string }[] }>(
    actor.userId,
    archivePath(archiveId, "lookup", "events"),
    { names: typed },
  );
  return events.map((event) => event.id);
}

/** Display names of characters and events by ID. Unknown IDs show their short ID. */
export async function lookupNames(
  actor: Actor,
  archiveId: string,
  ids: { characters?: string[]; events?: string[] },
): Promise<{ characters: Record<string, string>; events: Record<string, string> }> {
  const characters = ids.characters ?? [];
  const events = ids.events ?? [];
  if (characters.length + events.length === 0) return { characters: {}, events: {} };
  const found = await archivistApi().get<{
    characters: Record<string, string | null>;
    events: Record<string, string | null>;
  }>(actor.userId, archivePath(archiveId, "lookup", "names"), {
    character: characters,
    event: events,
  });
  const named = (map: Record<string, string | null>, list: string[]) =>
    Object.fromEntries(list.map((id) => [id, map[id] ?? id.slice(0, 8)]));
  return { characters: named(found.characters, characters), events: named(found.events, events) };
}

/** The artifact's preview image for a reply, read as the contributor, or null without one. */
async function previewFor(
  actor: Actor,
  archiveId: string,
  artifact: ArtifactDetails,
): Promise<AttachmentBuilder | null> {
  if (!artifact.media.hasPreview) return null;
  try {
    const bytes = await archivistApi().bytes(
      actor.userId,
      archivePath(archiveId, "media", artifact.media.id, "preview"),
    );
    return new AttachmentBuilder(bytes, { name: PREVIEW_ATTACHMENT });
  } catch {
    return null;
  }
}

/**
 * The private reply showing an artifact, with its Edit, Add characters/events,
 * Someone unidentified, and Delete buttons. The flag button reads "Everyone
 * identified" while the flag is set, and pressing it clears the flag.
 */
export async function artifactReply(
  actor: Actor,
  archive: ArchiveSummary,
  artifact: ArtifactDetails,
  headline: string,
  notes: (string | null)[] = [],
): Promise<InteractionEditReplyOptions> {
  const [details, names, preview] = await Promise.all([
    getArchiveDetails(actor, archive.archiveId),
    lookupNames(actor, archive.archiveId, {
      characters: artifact.links.characters,
      events: artifact.links.events,
    }),
    previewFor(actor, archive.archiveId, artifact),
  ]);
  const id = (action: string) => recordId(action, archive.archiveId, artifact.id, artifact.version);
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(id("edit")).setLabel("Edit").setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(id("links"))
      .setLabel("Add characters/events")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(id("unid"))
      .setLabel(artifact.unidentifiedCharacters ? "Everyone identified" : "Someone unidentified")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(id("delete")).setLabel("Delete").setStyle(ButtonStyle.Danger),
  );
  return {
    content: [headline, ...notes.filter(Boolean)].join("\n"),
    embeds: [
      artifactEmbed(artifact, {
        archiveName: archive.name,
        archiveTimeZone: details.timezone,
        characterNames: artifact.links.characters.map((c) => names.characters[c]!),
        eventNames: artifact.links.events.map((e) => names.events[e]!),
        hasPreviewAttachment: preview !== null,
      }),
    ],
    files: preview ? [preview] : [],
    components: [buttons],
    allowedMentions: { parse: [] },
  };
}

/** Runs `/archive artifact add`. Everything typed is checked by the service before the file moves. */
export async function startIntake(
  interaction: CommandInteraction,
  options: IntakeOptions,
): Promise<void> {
  await interaction.deferReply(ephemeral);
  const actor = await actorOf(interaction);
  if (Boolean(options.file) === Boolean(options.driveLink?.trim())) {
    throw invalid("Attach one file or paste one Google Drive link, not both or neither.", "file");
  }
  if (options.file && options.file.size > MAX_MEDIA_BYTES) {
    throw new ArchivistError("media_too_large", "Files can be at most 100 MiB.", { field: "file" });
  }
  const archive = await selectArchive(actor, options.archive);
  const estimate = estimatePair(options.estimatedDay, options.estimateReason);
  const events = options.event
    ? [
        (
          await archivistApi().get<EventDetails>(
            actor.userId,
            archivePath(archive.archiveId, "events", options.event),
          )
        ).id,
      ]
    : [];
  const fields: IntakeFields = {
    description: options.description,
    characters: await lookupCharacters(actor, archive.archiveId, options.characters),
    events,
    exactDate: exactText(options.exactDate),
    estimatedDay: estimate?.day,
    estimateReason: estimate?.reason,
    guildId: interaction.guildId ?? undefined,
    channelId: interaction.channelId,
  };
  const file: FileSource = options.file
    ? {
        kind: "attachment",
        id: options.file.id,
        url: options.file.url,
        size: options.file.size,
        name: options.file.name,
      }
    : { kind: "drive", link: options.driveLink!.trim() };
  const pending: PendingIntake = { kind: "intake", archive, fields, file };
  const respond: Respond = (payload) => interaction.editReply(payload);
  if (
    fields.exactDate &&
    (await askZoneConfirmation(actor, archive, fields.exactDate, pending, respond))
  ) {
    return;
  }
  await completeIntake(interaction.client, actor, pending, respond, false);
}

/**
 * Shows how a typed time without a zone will be read, before it is saved.
 * The service reads the date with the contributor's preferences and refuses
 * one it cannot read. Returns false when no confirmation is needed.
 */
async function askZoneConfirmation(
  actor: Actor,
  archive: ArchiveSummary,
  typed: string,
  pending: PendingIntake | PendingEdit,
  respond: Respond,
): Promise<boolean> {
  const preview = await archivistApi().get<DatePreview>(
    actor.userId,
    archivePath(archive.archiveId, "date-preview"),
    { text: typed },
  );
  if (!preview.assumedZone || !preview.display) return false;
  const { local, zone, offset } = preview.display;
  const token = remember(actor.userId, pending);
  await respond({
    content:
      `"${typed}" will be read as **${local} ${zone}** (UTC${offset}). ` +
      "Save it like that? To use another zone, cancel and add the zone or offset after the time, " +
      "such as `Jul 15 2019 6:30pm Europe/London` or `2019-07-15 18:30 -04:00`. This expires in 15 minutes.",
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ax:zsave:${token}`)
          .setLabel("Save")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`ax:zcancel:${token}`)
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
  return true;
}

/**
 * Downloads a Discord attachment into `file`, refusing anything over the
 * service's size limit while it streams. Only Discord's own file hosts are
 * fetched.
 */
export async function downloadAttachment(
  url: string,
  file: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const address = new URL(url);
  if (address.protocol !== "https:" || !DISCORD_CDN_HOSTS.has(address.hostname)) {
    throw invalid("That attachment is not on Discord's file host.", "file");
  }
  let response: Response;
  try {
    response = await fetchImpl(address, {
      signal: AbortSignal.timeout(ATTACHMENT_DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new ArchivistError(
      "dependency_unavailable",
      "Discord did not send the attachment. Try again in a moment.",
      { field: "file" },
    );
  }
  if (!response.ok || !response.body) {
    throw invalid("Discord would not provide that attachment. Upload it again.", "file");
  }
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if (declared > MAX_MEDIA_BYTES) {
    await response.body.cancel();
    throw new ArchivistError("media_too_large", "Files can be at most 100 MiB.", { field: "file" });
  }
  let total = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      total += chunk.length;
      if (total > MAX_MEDIA_BYTES) {
        done(
          new ArchivistError("media_too_large", "Files can be at most 100 MiB.", { field: "file" }),
        );
        return;
      }
      done(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as unknown as WebReadableStream),
    limit,
    createWriteStream(file),
  );
  return total;
}

/** The intake's fields as the service reads them, every field before any file. */
export function intakeForm(fields: IntakeFields, zoneConfirmed: boolean): [string, string][] {
  const entries: [string, string][] = [["description", fields.description]];
  for (const id of fields.characters) entries.push(["characters", id]);
  for (const id of fields.events) entries.push(["events", id]);
  if (fields.exactDate) entries.push(["exactDate", fields.exactDate]);
  if (fields.estimatedDay) entries.push(["estimatedDay", fields.estimatedDay]);
  if (fields.estimateReason) entries.push(["estimateReason", fields.estimateReason]);
  if (zoneConfirmed) entries.push(["zoneConfirmed", "true"]);
  if (fields.guildId) entries.push(["submissionGuildId", fields.guildId]);
  if (fields.channelId) entries.push(["submissionChannelId", fields.channelId]);
  return entries;
}

/**
 * Sends the intake to the service: an attachment's bytes as a multipart
 * upload with its Discord identity, or a Drive link for the service to fetch.
 */
export async function submitIntake(
  actor: Actor,
  archiveId: string,
  fields: IntakeFields,
  file: FileSource,
  zoneConfirmed: boolean,
  api: ArchivistApi = archivistApi(),
  fetchImpl: typeof fetch = fetch,
): Promise<IntakeReply> {
  const path = archivePath(archiveId, "artifacts", "intake");
  const entries = intakeForm(fields, zoneConfirmed);
  if (file.kind === "drive") {
    const body: Record<string, string | string[]> = { driveLink: file.link };
    for (const [name, value] of entries) {
      const previous = body[name];
      body[name] =
        previous === undefined
          ? value
          : [...(Array.isArray(previous) ? previous : [previous]), value];
    }
    // Lists stay lists even with one entry.
    body.characters = fields.characters;
    body.events = fields.events;
    return api.post<IntakeReply>(actor.userId, path, body);
  }
  const folder = mkdtempSync(join(tmpdir(), "archivist-upload-"));
  try {
    const original = join(folder, "original");
    await downloadAttachment(file.url, original, fetchImpl);
    const form = new FormData();
    for (const [name, value] of entries) form.append(name, value);
    form.append("discordAttachmentId", file.id);
    form.append("discordAttachmentUrl", file.url);
    form.append("file", await openAsBlob(original), file.name);
    return await api.upload<IntakeReply>(actor.userId, path, form);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

async function completeIntake(
  client: Client,
  actor: Actor,
  pending: PendingIntake,
  respond: Respond,
  zoneConfirmed: boolean,
) {
  const { archive } = pending;
  const reply = await submitIntake(
    actor,
    archive.archiveId,
    pending.fields,
    pending.file,
    zoneConfirmed,
  );
  if (reply.status === "duplicate") {
    await showDuplicateReview(actor, archive, reply, respond);
    return;
  }
  const outcome = await announceNow(
    client as Client<true>,
    archive.archiveId,
    reply.artifact.id,
    reply.announcement.status,
  );
  await respond(
    await artifactReply(
      actor,
      archive,
      reply.artifact,
      `Saved to **${archive.name}** - artifact \`${reply.artifact.id.slice(0, 8)}\``,
      [
        interpretationNote(reply.artifact),
        reply.artifact.media.readable
          ? null
          : "The file could not be read, so it has no preview. It is kept exactly as uploaded.",
        announcementNote(outcome),
      ],
    ),
  );
}

/** Shows what a resubmitted source would change. Nothing is saved until the contributor applies it. */
async function showDuplicateReview(
  actor: Actor,
  archive: ArchiveSummary,
  reply: Extract<IntakeReply, { status: "duplicate" }>,
  respond: Respond,
  note?: string,
): Promise<void> {
  const existing = reply.artifact;
  const header =
    `This file is already in **${archive.name}** as artifact \`${existing.id.slice(0, 8)}\` ` +
    `(added by <@${existing.createdBy}> on ${dayText(existing.createdAt.slice(0, 10))}).`;
  if (reply.differences.length === 0 || !reply.reviewToken) {
    await respond(
      await artifactReply(actor, archive, existing, header, [
        note ?? null,
        "Everything you entered matches it, so nothing changed.",
      ]),
    );
    return;
  }
  const idsOf = (key: DuplicateDifference["key"]) =>
    reply.differences.filter((d) => d.key === key).flatMap((d) => d.proposed.split(","));
  const names = await lookupNames(actor, archive.archiveId, {
    characters: idsOf("characters"),
    events: idsOf("events"),
  });
  const token = remember(actor.userId, {
    archive,
    reviewToken: reply.reviewToken,
    artifactId: existing.id,
    selected: [],
  } satisfies PendingReview);
  const label = (kind: DuplicateDifference["key"], ids: string[]) =>
    ids.map((id) =>
      kind === "characters"
        ? (names.characters[id] ?? id.slice(0, 8))
        : kind === "events"
          ? (names.events[id] ?? id.slice(0, 8))
          : id.slice(0, 8),
    );
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ax:dsel:${token}`)
    .setPlaceholder("Tick the changes to apply")
    .setMinValues(0)
    .setMaxValues(reply.differences.length)
    .addOptions(reply.differences.map((difference) => differenceOption(difference, label)));
  await respond({
    content: [
      note,
      `${header} Nothing was saved yet.`,
      "Choose what to apply. Unticked items stay as they are, links are only added, and the original file is never replaced. This expires in 15 minutes.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    embeds: [],
    files: [],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ax:dapply:${token}`)
          .setLabel("Apply selected")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`ax:dcancel:${token}`)
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { parse: [] },
  });
}

/** Remembers which differences are ticked. The menu's values arrive only with the menu itself. */
export async function selectDifferences(interaction: StringSelectMenuInteraction): Promise<void> {
  const token = interaction.customId.split(":")[2] ?? "";
  const review = recall<PendingReview>(token, interaction.user.id, false);
  review.selected = interaction.values;
  await interaction.deferUpdate();
}

export async function applyReview(interaction: ButtonInteraction): Promise<void> {
  const token = interaction.customId.split(":")[2] ?? "";
  const review = recall<PendingReview>(token, interaction.user.id);
  await interaction.update({ content: "Applying…", components: [] });
  const respond: Respond = (payload) => interaction.editReply(payload);
  const actor = await actorOf(interaction);
  if (review.selected.length === 0) {
    await respond({ content: "Nothing was ticked, so nothing changed." });
    return;
  }
  try {
    const updated = await archivistApi().post<ArtifactDetails>(
      actor.userId,
      archivePath(review.archive.archiveId, "artifacts", "reviews", review.reviewToken, "apply"),
      { selected: review.selected },
    );
    await respond(
      await artifactReply(
        actor,
        review.archive,
        updated,
        `Updated artifact \`${updated.id.slice(0, 8)}\`.`,
      ),
    );
  } catch (error) {
    if (!(error instanceof ArchivistError) || error.code !== "stale_version") throw error;
    // The service's review is used up. Submitting again shows the latest differences.
    await respond({
      content:
        "Someone changed this artifact while you were reviewing it, so nothing was applied. Submit the file again to see the differences from its latest version.",
    });
  }
}

export async function cancelReview(interaction: ButtonInteraction): Promise<void> {
  const token = interaction.customId.split(":")[2] ?? "";
  recall(token, interaction.user.id);
  await interaction.update({ content: "Cancelled. Nothing changed.", components: [] });
}

export async function confirmZone(interaction: ButtonInteraction): Promise<void> {
  const token = interaction.customId.split(":")[2] ?? "";
  const pending = recall<PendingIntake | PendingEdit>(token, interaction.user.id);
  const actor = await actorOf(interaction);
  await interaction.update({ content: "Saving…", components: [] });
  const respond: Respond = (payload) => interaction.editReply(payload);
  if (pending.kind === "intake") {
    await completeIntake(interaction.client, actor, pending, respond, true);
    return;
  }
  const updated = await archivistApi().patch<ArtifactDetails>(
    actor.userId,
    artifactPath(pending.archive.archiveId, pending.artifactId),
    pending.body,
  );
  await respond(
    await artifactReply(
      actor,
      pending.archive,
      updated,
      `Updated artifact \`${updated.id.slice(0, 8)}\`.`,
      [interpretationNote(updated)],
    ),
  );
}

export async function cancelZone(interaction: ButtonInteraction): Promise<void> {
  const token = interaction.customId.split(":")[2] ?? "";
  recall(token, interaction.user.id);
  await interaction.update({ content: "Cancelled. Nothing was saved.", components: [] });
}

function textInput(
  id: string,
  label: string,
  value: string | undefined,
  style: TextInputStyle,
  max: number,
) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style)
    .setRequired(false)
    .setMaxLength(max);
  if (value) input.setValue(value);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

/** Opens the edit form, bound to the version shown on the button. */
export async function openEdit(interaction: ButtonInteraction): Promise<void> {
  const { archiveId, artifactId, version } = parseRecordId(interaction.customId);
  await showEditForm(interaction, archiveId, artifactId, version);
}

/**
 * Shows the edit form for an artifact, bound to the version the contributor
 * saw, or to its current version when opened from a command. Discord allows
 * only a few seconds before the form must open, so this makes one request.
 */
export async function showEditForm(
  interaction: ButtonInteraction | CommandInteraction,
  archiveId: string,
  artifactId: string,
  version?: number,
): Promise<void> {
  const artifact = await getArtifact(await actorOf(interaction), archiveId, artifactId);
  const modal = new ModalBuilder()
    .setCustomId(recordId("editm", archiveId, artifact.id, version ?? artifact.version))
    .setTitle(shorten(`Edit artifact ${artifact.id.slice(0, 8)}`, 45));
  const rows: ActionRowBuilder<TextInputBuilder>[] = [];
  if (artifact.description.length <= MODAL_TEXT_LIMIT) {
    rows.push(
      textInput(
        "description",
        "Description",
        artifact.description,
        TextInputStyle.Paragraph,
        MODAL_TEXT_LIMIT,
      ),
    );
  }
  rows.push(
    textInput(
      "exact_date",
      "Exact date (empty to clear)",
      artifact.dates.exact?.date.originalText,
      TextInputStyle.Short,
      100,
    ),
    textInput(
      "estimated_day",
      "Estimated day, such as Jul 15 2019",
      artifact.dates.estimated?.date.originalText,
      TextInputStyle.Short,
      100,
    ),
    textInput(
      "estimate_reason",
      "Why you estimate that day",
      artifact.dates.estimated?.reason,
      TextInputStyle.Short,
      MODAL_TEXT_LIMIT,
    ),
  );
  modal.addComponents(...rows);
  await interaction.showModal(modal);
}

function field(interaction: ModalSubmitInteraction, id: string): string | undefined {
  try {
    return interaction.fields.getTextInputValue(id);
  } catch {
    return undefined;
  }
}

/** The archive a button's record belongs to, with its name, checked as the contributor. */
async function buttonArchive(actor: Actor, archiveId: string): Promise<ArchiveSummary> {
  const details = await getArchiveDetails(actor, archiveId);
  return { archiveId: details.archiveId, name: details.name };
}

export async function submitEdit(interaction: ModalSubmitInteraction): Promise<void> {
  const { archiveId, artifactId, version } = parseRecordId(interaction.customId);
  const actor = await actorOf(interaction);
  await interaction.deferReply(ephemeral);
  const respond: Respond = (payload) => interaction.editReply(payload);
  const [archive, current] = await Promise.all([
    buttonArchive(actor, archiveId),
    getArtifact(actor, archiveId, artifactId),
  ]);
  const exactDate = field(interaction, "exact_date");
  const exact = exactText(exactDate);
  const estimate = estimatePair(
    field(interaction, "estimated_day"),
    field(interaction, "estimate_reason"),
  );
  const body: Record<string, unknown> = {
    expectedVersion: version,
    description: field(interaction, "description"),
    exactDate: exact ?? (current.dates.exact ? null : undefined),
    estimatedDate: estimate ?? (current.dates.estimated ? null : undefined),
  };
  const changedExact = exact && current.dates.exact?.date.originalText !== exactDate?.trim();
  if (
    changedExact &&
    (await askZoneConfirmation(
      actor,
      archive,
      exact,
      { kind: "edit", archive, artifactId: current.id, body },
      respond,
    ))
  ) {
    return;
  }
  const updated = await archivistApi().patch<ArtifactDetails>(
    actor.userId,
    artifactPath(archiveId, current.id),
    body,
  );
  await respond(
    await artifactReply(
      actor,
      archive,
      updated,
      updated.version === current.version
        ? "Nothing changed."
        : `Updated artifact \`${updated.id.slice(0, 8)}\`.`,
    ),
  );
}

export async function openAddLinks(interaction: ButtonInteraction): Promise<void> {
  const { archiveId, artifactId, version } = parseRecordId(interaction.customId);
  const input = (id: string, label: string, placeholder: string) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId(id)
        .setLabel(label)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(1000)
        .setPlaceholder(placeholder),
    );
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(recordId("linksm", archiveId, artifactId, version))
      .setTitle("Add characters or events")
      .addComponents(
        input("characters", "Characters, separated by commas", "Sam, Lee, Alex (3f9a1c2e)"),
        input("events", "Events it shows, by title or ID", "Summer season, First meetup"),
      ),
  );
}

export async function submitAddLinks(interaction: ModalSubmitInteraction): Promise<void> {
  const { archiveId, artifactId, version } = parseRecordId(interaction.customId);
  const actor = await actorOf(interaction);
  await interaction.deferReply(ephemeral);
  const [characters, events] = await Promise.all([
    lookupCharacters(actor, archiveId, field(interaction, "characters")),
    lookupEvents(actor, archiveId, field(interaction, "events")),
  ]);
  if (characters.length === 0 && events.length === 0) {
    throw invalid("Add at least one character or event.", "characters");
  }
  const updated = await archivistApi().patch<ArtifactDetails>(
    actor.userId,
    artifactPath(archiveId, artifactId),
    { expectedVersion: version, addLinks: { characters, events } },
  );
  await interaction.editReply(
    await artifactReply(
      actor,
      await buttonArchive(actor, archiveId),
      updated,
      `Updated artifact \`${updated.id.slice(0, 8)}\`.`,
    ),
  );
}

/**
 * Sets or clears the flag that someone in the artifact is not identified yet,
 * which the research board uses for missing-character cards. The same message
 * is updated, so its buttons carry the new version.
 */
export async function toggleUnidentified(interaction: ButtonInteraction): Promise<void> {
  const { archiveId, artifactId, version } = parseRecordId(interaction.customId);
  const actor = await actorOf(interaction);
  await interaction.deferUpdate();
  const current = await getArtifact(actor, archiveId, artifactId);
  const updated = await archivistApi().patch<ArtifactDetails>(
    actor.userId,
    artifactPath(archiveId, artifactId),
    { expectedVersion: version, unidentifiedCharacters: !current.unidentifiedCharacters },
  );
  await interaction.editReply({
    ...(await artifactReply(
      actor,
      await buttonArchive(actor, archiveId),
      updated,
      updated.unidentifiedCharacters
        ? `Artifact \`${updated.id.slice(0, 8)}\` is marked as having an unidentified character.`
        : `Artifact \`${updated.id.slice(0, 8)}\` is no longer marked as having an unidentified character.`,
    )),
    attachments: [],
  });
}

export async function askDelete(interaction: ButtonInteraction): Promise<void> {
  const { archiveId, artifactId, version } = parseRecordId(interaction.customId);
  await askDeleteFor(interaction, archiveId, artifactId, version);
}

/** Asks the contributor to confirm permanently deleting an artifact. */
export async function askDeleteFor(
  interaction: ButtonInteraction | CommandInteraction,
  archiveId: string,
  artifactId: string,
  version?: number,
): Promise<void> {
  await interaction.deferReply(ephemeral);
  const artifact = await getArtifact(await actorOf(interaction), archiveId, artifactId);
  await interaction.editReply({
    content:
      `Permanently delete artifact \`${artifact.id.slice(0, 8)}\`? There is no trash or undo. ` +
      "Its links and its own edit history are removed. Its media file stays in the archive, and any announcement stays posted.",
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(recordId("deletec", archiveId, artifact.id, version ?? artifact.version))
          .setLabel("Delete permanently")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

export async function confirmDelete(interaction: ButtonInteraction): Promise<void> {
  const { archiveId, artifactId, version } = parseRecordId(interaction.customId);
  await interaction.deferUpdate();
  await archivistApi().delete(
    (await actorOf(interaction)).userId,
    artifactPath(archiveId, artifactId),
    { expectedVersion: version },
  );
  await interaction.editReply({
    content: `Deleted artifact \`${artifactId.slice(0, 8)}\`. Its media file stays in the archive.`,
    components: [],
  });
}
