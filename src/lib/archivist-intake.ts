import { join } from "node:path";
import {
  ActionRowBuilder,
  type Attachment,
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
import { registeredArchive } from "../archivist/access.js";
import { archiveDetails } from "../archivist/archives.js";
import {
  applyDuplicateReview,
  type ArtifactDetails,
  checkIntake,
  createArtifact,
  deleteArtifact,
  duplicateDifferences,
  findArtifactBySource,
  getArtifact,
  type IntakeInput,
  readArtifact,
  type UpdateArtifactInput,
  updateArtifact,
} from "../archivist/artifacts.js";
import { type Actor, type ArchivistContext, openStore } from "../archivist/context.js";
import {
  dayText,
  localDateTime,
  localText,
  needsZoneConfirmation,
  offsetLabel,
  parseDateInput,
} from "../archivist/dates.js";
import { downloadDiscordAttachment } from "../archivist/download.js";
import { DriveClient, type DriveLink, parseDriveLink } from "../archivist/drive.js";
import { ArchivistError } from "../archivist/errors.js";
import {
  createStagingFolder,
  discardStaging,
  MAX_MEDIA_BYTES,
  stageMedia,
} from "../archivist/media.js";
import { peopleNames, resolveEvents, resolvePeople, resolveShortId } from "../archivist/people.js";
import { getDateOrder, inputTimeZone, resolveArchiveSelection } from "../archivist/preferences.js";
import { config } from "../config.js";
import { actorOf, archivist } from "./archivist.js";
import {
  announceArtifact,
  type AnnouncementOutcome,
  previewAttachment,
} from "./archivist-announce.js";
import {
  artifactEmbed,
  differenceOption,
  interpretationNote,
  shorten,
} from "./archivist-format.js";
import { recall, remember } from "./archivist-pending.js";

/**
 * The Discord artifact flow the owner approved: intake from an attachment or
 * a Drive link, a confirmation when a typed time has no zone, duplicate
 * review, and the reply's Edit, Add people, Someone unidentified, and Delete
 * buttons.
 */

const ephemeral = { flags: MessageFlags.Ephemeral } as const;
const MODAL_TEXT_LIMIT = 4000;

type Respond = (payload: InteractionEditReplyOptions) => Promise<unknown>;

type FileSource =
  | { kind: "attachment"; id: string; url: string; size: number; name: string }
  | { kind: "drive"; link: DriveLink };

interface PendingIntake {
  kind: "intake";
  intake: IntakeInput;
  file: FileSource;
}

interface PendingEdit {
  kind: "edit";
  input: UpdateArtifactInput;
}

interface PendingReview {
  intake: IntakeInput;
  artifactId: string;
  version: number;
  selected: string[];
}

export interface IntakeOptions {
  archive?: string;
  description: string;
  file?: Attachment;
  driveLink?: string;
  people?: string;
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

/** Custom IDs carry the archive, the record, and the version the person saw. */
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

function archiveName(context: ArchivistContext, archiveId: string): string {
  return registeredArchive(context, archiveId)?.name ?? "the archive";
}

/**
 * The private reply showing an artifact, with its Edit, Add people, Someone
 * unidentified, and Delete buttons. The flag button reads "Everyone
 * identified" while the flag is set, and pressing it clears the flag.
 */
export function artifactReply(
  context: ArchivistContext,
  archiveId: string,
  artifact: ArtifactDetails,
  headline: string,
  notes: (string | null)[] = [],
): InteractionEditReplyOptions {
  const store = openStore(context, archiveId);
  const details = archiveDetails(store);
  const preview = previewAttachment(context, archiveId, artifact);
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(recordId("edit", archiveId, artifact.id, artifact.version))
      .setLabel("Edit")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(recordId("people", archiveId, artifact.id, artifact.version))
      .setLabel("Add people")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(recordId("unid", archiveId, artifact.id, artifact.version))
      .setLabel(artifact.unidentifiedPeople ? "Everyone identified" : "Someone unidentified")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(recordId("delete", archiveId, artifact.id, artifact.version))
      .setLabel("Delete")
      .setStyle(ButtonStyle.Danger),
  );
  return {
    content: [headline, ...notes.filter(Boolean)].join("\n"),
    embeds: [
      artifactEmbed(artifact, {
        archiveName: archiveName(context, archiveId),
        archiveTimeZone: details.timezone,
        peopleNames: peopleNames(store.db, artifact.links.people),
        eventNames: artifact.links.events.map(
          (id) =>
            (
              store.db.prepare("SELECT title FROM events WHERE id = ?").get(id) as
                { title: string } | undefined
            )?.title ?? id.slice(0, 8),
        ),
        hasPreviewAttachment: preview !== null,
      }),
    ],
    files: preview ? [preview] : [],
    components: [buttons],
    allowedMentions: { parse: [] },
  };
}

function announcementNote(outcome: AnnouncementOutcome): string | null {
  if (outcome.status === "failed" || outcome.status === "indeterminate") {
    return `Saved, but not announced. ${outcome.reason}`;
  }
  return null;
}

/** Runs `/archivist artifact add`. Everything is checked before the file is downloaded. */
export async function startIntake(
  interaction: CommandInteraction,
  options: IntakeOptions,
): Promise<void> {
  await interaction.deferReply(ephemeral);
  const context = archivist();
  const actor = await actorOf(interaction);
  if (Boolean(options.file) === Boolean(options.driveLink?.trim())) {
    throw invalid("Attach one file or paste one Google Drive link, not both or neither.", "file");
  }
  const archive = resolveArchiveSelection(context, actor, options.archive);
  const store = openStore(context, archive.archiveId);
  const file: FileSource = options.file
    ? {
        kind: "attachment",
        id: options.file.id,
        url: options.file.url,
        size: options.file.size,
        name: options.file.name,
      }
    : { kind: "drive", link: parseDriveLink(options.driveLink) };
  if (file.kind === "attachment" && file.size > MAX_MEDIA_BYTES) {
    throw new ArchivistError("media_too_large", "Files can be at most 100 MiB.", { field: "file" });
  }
  const intake: IntakeInput = {
    archiveId: archive.archiveId,
    description: options.description,
    source:
      file.kind === "attachment"
        ? { provider: "discord_attachment", key: file.id, url: file.url.split("?")[0] }
        : {
            provider: "drive",
            key: file.link.fileId,
            url: file.link.url,
            resourceKey: file.link.resourceKey,
          },
    exactDate: exactText(options.exactDate),
    estimatedDate: estimatePair(options.estimatedDay, options.estimateReason),
    links: {
      people: resolvePeople(store.db, options.people),
      events: options.event ? [resolveShortId(store.db, "events", options.event, "event")] : [],
    },
    submission: { guildId: interaction.guildId ?? undefined, channelId: interaction.channelId },
  };
  checkIntake(context, actor, intake);
  const respond: Respond = (payload) => interaction.editReply(payload);
  const pending: PendingIntake = { kind: "intake", intake, file };
  if (needsZoneConfirmation(options.exactDate, getDateOrder(context, actor))) {
    await askZoneConfirmation(
      context,
      actor,
      archive.archiveId,
      options.exactDate!,
      pending,
      respond,
    );
    return;
  }
  await completeIntake(interaction.client, actor, pending, respond);
}

/** Shows how a typed time without a zone will be read, before it is saved. */
async function askZoneConfirmation(
  context: ArchivistContext,
  actor: Actor,
  archiveId: string,
  typed: string,
  pending: PendingIntake | PendingEdit,
  respond: Respond,
): Promise<void> {
  const zone = inputTimeZone(
    context,
    actor,
    archiveDetails(openStore(context, archiveId)).timezone,
  );
  const value = parseDateInput("exact_date", typed, zone, getDateOrder(context, actor));
  if (value.kind !== "instant") return;
  const local = localText(localDateTime(value.instantMs, zone));
  const token = remember(actor.userId, pending);
  await respond({
    content:
      `"${typed}" will be read as **${local} ${zone}** (UTC${offsetLabel(value.instantMs, zone)}). ` +
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
}

async function completeIntake(
  client: Client<true>,
  actor: Actor,
  pending: PendingIntake,
  respond: Respond,
) {
  const context = archivist();
  const archiveId = String(pending.intake.archiveId);
  const store = openStore(context, archiveId);
  const existing = findArtifactBySource(
    store.db,
    pending.intake.source.provider,
    pending.intake.source.key,
  );
  if (existing) {
    await showDuplicateReview(context, actor, pending.intake, existing, respond);
    return;
  }
  const staging = createStagingFolder(context);
  try {
    const file = join(staging, "original");
    let originalFilename: string;
    if (pending.file.kind === "attachment") {
      await downloadDiscordAttachment(pending.file.url, file);
      originalFilename = pending.file.name;
    } else {
      const drive = new DriveClient({ apiKey: config.googleDriveApiKey });
      const metadata = await drive.metadata(pending.file.link);
      await drive.download(pending.file.link, file);
      originalFilename = metadata.name;
    }
    const media = await stageMedia(context, { file, originalFilename });
    const result = createArtifact(context, actor, { ...pending.intake, media });
    if (result.status === "duplicate") {
      await showDuplicateReview(context, actor, pending.intake, result.artifact, respond);
      return;
    }
    const outcome = await announceArtifact(client, context, archiveId, result.artifact);
    await respond(
      artifactReply(
        context,
        archiveId,
        result.artifact,
        `Saved to **${archiveName(context, archiveId)}** - artifact \`${result.artifact.id.slice(0, 8)}\``,
        [
          interpretationNote(result.artifact),
          result.artifact.media.readable
            ? null
            : "The file could not be read, so it has no preview. It is kept exactly as uploaded.",
          announcementNote(outcome),
        ],
      ),
    );
  } finally {
    discardStaging(context, staging);
  }
}

/** Shows what a resubmitted source would change. Nothing is saved until the person applies it. */
async function showDuplicateReview(
  context: ArchivistContext,
  actor: Actor,
  intake: IntakeInput,
  existing: ArtifactDetails,
  respond: Respond,
  note?: string,
): Promise<void> {
  const archiveId = String(intake.archiveId);
  const store = openStore(context, archiveId);
  const differences = duplicateDifferences(existing, checkIntake(context, actor, intake));
  const header =
    `This file is already in **${archiveName(context, archiveId)}** as artifact \`${existing.id.slice(0, 8)}\` ` +
    `(added by <@${existing.createdBy}> on ${dayText(existing.createdAt.slice(0, 10))}).`;
  if (differences.length === 0) {
    await respond({
      ...artifactReply(context, archiveId, existing, header, [
        note ?? null,
        "Everything you entered matches it, so nothing changed.",
      ]),
    });
    return;
  }
  const token = remember(actor.userId, {
    intake,
    artifactId: existing.id,
    version: existing.version,
    selected: [],
  } satisfies PendingReview);
  const names = (kind: string, ids: string[]) =>
    kind === "people" ? peopleNames(store.db, ids) : ids.map((id) => id.slice(0, 8));
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ax:dsel:${token}`)
    .setPlaceholder("Tick the changes to apply")
    .setMinValues(0)
    .setMaxValues(differences.length)
    .addOptions(differences.map((difference) => differenceOption(difference, names)));
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
  const context = archivist();
  const actor = await actorOf(interaction);
  const archiveId = String(review.intake.archiveId);
  if (review.selected.length === 0) {
    await respond({ content: "Nothing was ticked, so nothing changed." });
    return;
  }
  try {
    const updated = applyDuplicateReview(context, actor, {
      intake: review.intake,
      artifactId: review.artifactId,
      expectedVersion: review.version,
      selected: review.selected,
    });
    await respond(
      artifactReply(context, archiveId, updated, `Updated artifact \`${updated.id.slice(0, 8)}\`.`),
    );
  } catch (error) {
    if (!(error instanceof ArchivistError) || error.code !== "stale_version") throw error;
    const latest = readArtifact(openStore(context, archiveId).db, review.artifactId);
    if (!latest) throw error;
    await showDuplicateReview(
      context,
      actor,
      review.intake,
      latest,
      respond,
      "Someone changed this artifact while you were reviewing it. Here are the differences from its latest version.",
    );
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
    await completeIntake(interaction.client, actor, pending, respond);
    return;
  }
  const context = archivist();
  const updated = updateArtifact(context, actor, pending.input);
  await respond(
    artifactReply(
      context,
      String(pending.input.archiveId),
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

/** Shows the edit form for an artifact, bound to the version the person saw. */
export async function showEditForm(
  interaction: ButtonInteraction | CommandInteraction,
  archiveId: string,
  artifactId: string,
  version: number,
): Promise<void> {
  const artifact = getArtifact(archivist(), await actorOf(interaction), {
    archiveId,
    id: artifactId,
  });
  const modal = new ModalBuilder()
    .setCustomId(recordId("editm", archiveId, artifactId, version))
    .setTitle(shorten(`Edit artifact ${artifactId.slice(0, 8)}`, 45));
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

export async function submitEdit(interaction: ModalSubmitInteraction): Promise<void> {
  const { archiveId, artifactId, version } = parseRecordId(interaction.customId);
  const context = archivist();
  const actor = await actorOf(interaction);
  const current = getArtifact(context, actor, { archiveId, id: artifactId });
  const exactDate = field(interaction, "exact_date");
  const exact = exactText(exactDate);
  const estimate = estimatePair(
    field(interaction, "estimated_day"),
    field(interaction, "estimate_reason"),
  );
  const input: UpdateArtifactInput = {
    archiveId,
    id: artifactId,
    expectedVersion: version,
    description: field(interaction, "description"),
    exactDate: exact ?? (current.dates.exact ? null : undefined),
    estimatedDate: estimate ?? (current.dates.estimated ? null : undefined),
  };
  await interaction.deferReply(ephemeral);
  const respond: Respond = (payload) => interaction.editReply(payload);
  if (
    exact &&
    needsZoneConfirmation(exactDate, getDateOrder(context, actor)) &&
    current.dates.exact?.date.originalText !== exactDate?.trim()
  ) {
    await askZoneConfirmation(
      context,
      actor,
      archiveId,
      exactDate!,
      { kind: "edit", input },
      respond,
    );
    return;
  }
  const updated = updateArtifact(context, actor, input);
  await respond(
    artifactReply(
      context,
      archiveId,
      updated,
      updated.version === current.version
        ? "Nothing changed."
        : `Updated artifact \`${updated.id.slice(0, 8)}\`.`,
    ),
  );
}

export async function openAddPeople(interaction: ButtonInteraction): Promise<void> {
  const { archiveId, artifactId, version } = parseRecordId(interaction.customId);
  getArtifact(archivist(), await actorOf(interaction), { archiveId, id: artifactId });
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
      .setCustomId(recordId("peoplem", archiveId, artifactId, version))
      .setTitle("Add people or events")
      .addComponents(
        input("people", "People, separated by commas", "Sam, Lee, Alex (3f9a1c2e)"),
        input("events", "Events it shows, by title or ID", "Summer season, First meetup"),
      ),
  );
}

export async function submitAddPeople(interaction: ModalSubmitInteraction): Promise<void> {
  const { archiveId, artifactId, version } = parseRecordId(interaction.customId);
  const context = archivist();
  const actor = await actorOf(interaction);
  getArtifact(context, actor, { archiveId, id: artifactId });
  const db = openStore(context, archiveId).db;
  const people = resolvePeople(db, interaction.fields.getTextInputValue("people"));
  const events = resolveEvents(db, field(interaction, "events"));
  if (people.length === 0 && events.length === 0) {
    throw invalid("Add at least one person or event.", "people");
  }
  await interaction.deferReply(ephemeral);
  const updated = updateArtifact(context, actor, {
    archiveId,
    id: artifactId,
    expectedVersion: version,
    addLinks: { people, events },
  });
  await interaction.editReply(
    artifactReply(context, archiveId, updated, `Updated artifact \`${updated.id.slice(0, 8)}\`.`),
  );
}

/**
 * Sets or clears the flag that someone in the artifact is not identified yet,
 * which the research board uses for missing-people cards. The same message
 * is updated, so its buttons carry the new version.
 */
export async function toggleUnidentified(interaction: ButtonInteraction): Promise<void> {
  const { archiveId, artifactId, version } = parseRecordId(interaction.customId);
  const context = archivist();
  const actor = await actorOf(interaction);
  const current = getArtifact(context, actor, { archiveId, id: artifactId });
  const updated = updateArtifact(context, actor, {
    archiveId,
    id: artifactId,
    expectedVersion: version,
    unidentifiedPeople: !current.unidentifiedPeople,
  });
  await interaction.update({
    ...artifactReply(
      context,
      archiveId,
      updated,
      updated.unidentifiedPeople
        ? `Artifact \`${updated.id.slice(0, 8)}\` is marked as having someone not identified yet.`
        : `Artifact \`${updated.id.slice(0, 8)}\` is no longer marked as having someone unidentified.`,
    ),
    attachments: [],
  });
}

export async function askDelete(interaction: ButtonInteraction): Promise<void> {
  const { archiveId, artifactId, version } = parseRecordId(interaction.customId);
  await askDeleteFor(interaction, archiveId, artifactId, version);
}

/** Asks the person to confirm permanently deleting an artifact. */
export async function askDeleteFor(
  interaction: ButtonInteraction | CommandInteraction,
  archiveId: string,
  artifactId: string,
  version: number,
): Promise<void> {
  getArtifact(archivist(), await actorOf(interaction), { archiveId, id: artifactId });
  await interaction.reply({
    ...ephemeral,
    content:
      `Permanently delete artifact \`${artifactId.slice(0, 8)}\`? There is no trash or undo. ` +
      "Its links and its own edit history are removed. Its media file stays in the archive, and any announcement stays posted.",
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(recordId("deletec", archiveId, artifactId, version))
          .setLabel("Delete permanently")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

export async function confirmDelete(interaction: ButtonInteraction): Promise<void> {
  const { archiveId, artifactId, version } = parseRecordId(interaction.customId);
  deleteArtifact(archivist(), await actorOf(interaction), {
    archiveId,
    id: artifactId,
    expectedVersion: version,
  });
  await interaction.update({
    content: `Deleted artifact \`${artifactId.slice(0, 8)}\`. Its media file stays in the archive.`,
    components: [],
  });
}
