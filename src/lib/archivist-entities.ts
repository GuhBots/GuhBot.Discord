import {
  ActionRowBuilder,
  type AutocompleteInteraction,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type CommandInteraction,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  type Actor,
  actorOf,
  autocompleteArchive,
  getArchiveDetails,
  selectArchive,
} from "./archivist.js";
import { archivePath, archivistApi } from "./archivist-api.js";
import { ArchivistError } from "./archivist-errors.js";
import { entityEmbed, shorten } from "./archivist-format.js";
import { lookupCharacters } from "./archivist-intake.js";
import type { EntityDetails, EntityKind, SearchHit } from "./archivist-types.js";

/**
 * Discord handlers for creating, showing, editing, and deleting characters,
 * accounts, servers, and channels, as a client of the Archivist service.
 * Editing covers a record's own fields. Dated history is edited on the
 * website, by the owner's decision of 2026-11-23.
 */

const ephemeral = { flags: MessageFlags.Ephemeral } as const;
const KINDS: EntityKind[] = ["character", "account", "server", "channel"];

export interface CreateEntityOptions {
  archive?: string;
  kind: string;
  name: string;
  discordId?: string;
  realName?: string;
  birthDay?: string;
  metInPerson?: string;
  server?: string;
  channelKind?: string;
  parentChannel?: string;
  character?: string;
  accountKind?: string;
}

/** The fields of an entity's page that its edit form fills in. */
interface EntityRecord {
  id: string;
  version: number;
  knownName?: string;
  realName?: string | null;
  birthDay?: string | null;
  metInPerson?: string;
  label?: string;
  discordId?: string | null;
  characterId?: string | null;
  accountKind?: string;
  color?: string;
}

function entityKind(value: string | null | undefined): EntityKind {
  if (!KINDS.includes(value as EntityKind)) {
    throw new ArchivistError(
      "invalid_input",
      "Kind must be character, account, server, or channel.",
      { field: "kind" },
    );
  }
  return value as EntityKind;
}

function entityPath(archiveId: string, kind: EntityKind, id: string, ...rest: string[]): string {
  return archivePath(archiveId, "entities", kind, id, ...rest);
}

/** Reads an entity's labeled summary, by full or short ID. */
function getSummary(
  actor: Actor,
  archiveId: string,
  kind: EntityKind,
  id: string,
): Promise<EntityDetails> {
  return archivistApi().get<EntityDetails>(
    actor.userId,
    entityPath(archiveId, kind, id, "summary"),
  );
}

/** Resolves an optional related record typed by full or short ID to its full ID. */
async function related(
  actor: Actor,
  archiveId: string,
  kind: EntityKind,
  value: string | undefined,
): Promise<string | undefined> {
  if (!value?.trim()) return undefined;
  return (await getSummary(actor, archiveId, kind, value.trim())).id;
}

export async function createEntityFromCommand(
  interaction: CommandInteraction,
  options: CreateEntityOptions,
): Promise<void> {
  await interaction.deferReply(ephemeral);
  const actor = await actorOf(interaction);
  const archive = await selectArchive(actor, options.archive);
  const archiveId = archive.archiveId;
  const kind = entityKind(options.kind);
  const body =
    kind === "character"
      ? {
          knownName: options.name,
          realName: options.realName,
          birthDay: options.birthDay,
          metInPerson: options.metInPerson,
        }
      : kind === "server"
        ? { label: options.name, discordId: options.discordId }
        : kind === "channel"
          ? {
              kind: options.channelKind ?? "guild_channel",
              label: options.name,
              serverId: await related(actor, archiveId, "server", options.server),
              parentChannelId: await related(actor, archiveId, "channel", options.parentChannel),
              discordId: options.discordId,
            }
          : {
              kind: options.accountKind ?? "human",
              label: options.name,
              discordId: options.discordId,
              characterId: await related(actor, archiveId, "character", options.character),
            };
  const created = await archivistApi().post<{ id: string }>(
    actor.userId,
    archivePath(archiveId, "entities", kind),
    body,
  );
  const entity = await getSummary(actor, archiveId, kind, created.id);
  await interaction.editReply(
    entityReply(entity, archiveId, archive.name, `Created in **${archive.name}**.`),
  );
}

const LETTERS: Record<EntityKind, string> = {
  character: "c",
  account: "a",
  server: "s",
  channel: "h",
};
const FROM_LETTER: Record<string, EntityKind> = {
  c: "character",
  a: "account",
  s: "server",
  h: "channel",
};

/** An entity's embed with an Edit button bound to the version shown. */
function entityReply(
  entity: EntityDetails,
  archiveId: string,
  archiveName: string,
  content?: string,
) {
  return {
    content,
    embeds: [entityEmbed(entity, archiveName)],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            `ax:eedit:${archiveId}:${LETTERS[entity.kind]}:${entity.id}:${entity.version}`,
          )
          .setLabel("Edit")
          .setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

function formRow(
  id: string,
  label: string,
  value: string | null | undefined,
  required = false,
  max = 100,
) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(TextInputStyle.Short)
    .setRequired(required)
    .setMaxLength(max);
  if (value) input.setValue(value);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

/** Shows the edit form for an entity's own fields, bound to the version the contributor saw. */
export async function showEntityForm(
  interaction: CommandInteraction | ButtonInteraction,
  archiveId: string,
  kind: EntityKind,
  id: string,
  version?: number,
): Promise<void> {
  const actor = await actorOf(interaction);
  const record = await archivistApi().get<EntityRecord>(
    actor.userId,
    entityPath(archiveId, kind, id),
  );
  let character: string | null = null;
  if (kind === "account" && record.characterId) {
    const linked = await getSummary(actor, archiveId, "character", record.characterId);
    character = `${linked.name} (${linked.id.slice(0, 8)})`;
  }
  const rows =
    kind === "character"
      ? [
          formRow("knownName", "Known name", record.knownName, true),
          formRow("realName", "Real name (empty to clear)", record.realName),
          formRow("birthDay", "Birth day (empty to clear)", record.birthDay),
          formRow("metInPerson", "Met in person: yes, no, or unknown", record.metInPerson, true, 7),
        ]
      : [
          formRow("label", "Name", record.label, true),
          formRow("discordId", "Discord ID (empty to clear)", record.discordId, false, 20),
          ...(kind === "account"
            ? [
                formRow("character", "Character (empty to unlink)", character),
                formRow("subkind", "Kind: human or bot", record.accountKind, true, 5),
              ]
            : [formRow("color", "Lane color, such as #5865f2", record.color, true, 7)]),
        ];
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(
        `ax:eform:${archiveId}:${LETTERS[kind]}:${record.id}:${version ?? record.version}`,
      )
      .setTitle(shorten(`Edit ${kind} ${record.knownName ?? record.label ?? ""}`, 45))
      .addComponents(...rows),
  );
}

export async function openEntityEdit(interaction: ButtonInteraction): Promise<void> {
  const [, , archiveId = "", letter = "", id = "", version = ""] = interaction.customId.split(":");
  await showEntityForm(
    interaction,
    archiveId,
    FROM_LETTER[letter] ?? "character",
    id,
    Number(version),
  );
}

export async function submitEntityForm(interaction: ModalSubmitInteraction): Promise<void> {
  const [, , archiveId = "", letter = "", id = "", version = ""] = interaction.customId.split(":");
  const kind = FROM_LETTER[letter] ?? "character";
  const actor = await actorOf(interaction);
  await interaction.deferReply(ephemeral);
  const field = (name: string) => {
    try {
      return interaction.fields.getTextInputValue(name).trim();
    } catch {
      return undefined;
    }
  };
  let characterId: string | null | undefined;
  const character = field("character");
  if (kind === "account" && character !== undefined) {
    if (!character) characterId = null;
    else {
      const found = await lookupCharacters(actor, archiveId, character);
      if (found.length !== 1) {
        throw new ArchivistError("invalid_input", "Give one character for the account.", {
          field: "character",
        });
      }
      characterId = found[0];
    }
  }
  const [archive, before] = await Promise.all([
    getArchiveDetails(actor, archiveId),
    getSummary(actor, archiveId, kind, id),
  ]);
  await archivistApi().patch(actor.userId, entityPath(archiveId, kind, id), {
    expectedVersion: Number(version),
    knownName: field("knownName"),
    realName: field("realName"),
    birthDay: field("birthDay"),
    metInPerson: field("metInPerson")?.toLowerCase(),
    label: field("label"),
    discordId: field("discordId"),
    subkind: field("subkind")?.toLowerCase(),
    characterId,
    color: field("color"),
  });
  const updated = await getSummary(actor, archiveId, kind, id);
  await interaction.editReply(
    entityReply(
      updated,
      archiveId,
      archive.name,
      updated.version === before.version
        ? "Nothing changed."
        : `Updated ${kind} \`${updated.id.slice(0, 8)}\`.`,
    ),
  );
}

export async function showEntity(
  interaction: CommandInteraction,
  options: { archive?: string; kind: string; id: string },
): Promise<void> {
  await interaction.deferReply(ephemeral);
  const actor = await actorOf(interaction);
  const archive = await selectArchive(actor, options.archive);
  const entity = await getSummary(actor, archive.archiveId, entityKind(options.kind), options.id);
  await interaction.editReply(entityReply(entity, archive.archiveId, archive.name));
}

/**
 * Asks for confirmation, or explains what still links to the entity. The
 * service checks the links first, so a delete it would refuse is refused
 * before the Delete permanently button appears.
 */
export async function askDeleteEntity(
  interaction: CommandInteraction,
  options: { archive?: string; kind: string; id: string },
): Promise<void> {
  await interaction.deferReply(ephemeral);
  const actor = await actorOf(interaction);
  const archive = await selectArchive(actor, options.archive);
  const kind = entityKind(options.kind);
  const entity = await getSummary(actor, archive.archiveId, kind, options.id);
  await archivistApi().get(
    actor.userId,
    entityPath(archive.archiveId, kind, entity.id, "deletion-check"),
  );
  await interaction.editReply({
    content:
      `Permanently delete ${entity.kind} **${entity.name}** from **${archive.name}**? There is no trash or undo. ` +
      "Its own history and edit log lines are removed too.",
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ax:edel:${archive.archiveId}:${entity.kind}:${entity.id}:${entity.version}`)
          .setLabel("Delete permanently")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

export async function confirmDeleteEntity(interaction: ButtonInteraction): Promise<void> {
  const [, , archiveId = "", kind = "", id = "", version = ""] = interaction.customId.split(":");
  await interaction.deferUpdate();
  await archivistApi().delete(
    (await actorOf(interaction)).userId,
    entityPath(archiveId, entityKind(kind), id),
    { expectedVersion: Number(version) },
  );
  await interaction.editReply({ content: `Deleted the ${kind}.`, components: [] });
}

/** The archive named in the command being typed, or the remembered one, without changing it. */
export const typedArchive = autocompleteArchive;

/** Records of one kind matching what was typed, for autocomplete. Empty when anything fails. */
export async function searchRecords(
  interaction: AutocompleteInteraction,
  kind: EntityKind | "artifact" | "event" | "request",
  typed: string,
): Promise<SearchHit[]> {
  const archiveId = await autocompleteArchive(interaction);
  if (!archiveId) return [];
  try {
    const { items } = await archivistApi().get<{ items: SearchHit[] }>(
      interaction.user.id,
      archivePath(archiveId, "lookup", "search"),
      { kind, q: typed.slice(0, 200), limit: 25 },
    );
    return items;
  } catch {
    return [];
  }
}

/** Which entity kind an autocompleted option looks up. */
const OPTION_KINDS: Record<string, EntityKind> = {
  server: "server",
  character: "character",
  parent_channel: "channel",
  channel: "channel",
};

/** Suggests characters, accounts, servers, or channels for an ID option. */
export async function suggestEntityIds(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const typedKind = interaction.options.getString("kind");
  const kind: EntityKind | undefined =
    OPTION_KINDS[focused.name] ??
    (KINDS.includes(typedKind as EntityKind) ? (typedKind as EntityKind) : undefined);
  if (!kind) {
    await interaction.respond([]);
    return;
  }
  const hits = await searchRecords(interaction, kind, String(focused.value));
  await interaction.respond(
    hits.map((hit) => ({
      name: shorten(`${hit.label} (${hit.id.slice(0, 8)})`, 100),
      value: hit.id,
    })),
  );
}

/** Suggests artifacts by description or ID. */
export async function suggestArtifactIds(interaction: AutocompleteInteraction): Promise<void> {
  const hits = await searchRecords(interaction, "artifact", interaction.options.getFocused());
  await interaction.respond(
    hits.map((hit) => ({
      name: shorten(`${hit.id.slice(0, 8)} ${hit.label.replace(/\s+/g, " ")}`, 100),
      value: hit.id,
    })),
  );
}
