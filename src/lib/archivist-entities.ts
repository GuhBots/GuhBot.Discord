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
import { registeredArchive, requireArchiveAccess } from "../archivist/access.js";
import { openStore } from "../archivist/context.js";
import {
  createAccount,
  createChannel,
  createCharacter,
  createServer,
  deleteEntity,
  entityBlockers,
  type EntityKind,
  type EntityDetails,
  entityKindValue,
  getEntity,
  updateEntity,
} from "../archivist/entities.js";
import { ArchivistError } from "../archivist/errors.js";
import { resolvePeople, resolveShortId } from "../archivist/people.js";
import { resolveArchiveSelection } from "../archivist/preferences.js";
import { searchArtifacts, searchEntities } from "../archivist/search.js";
import { actorOf, archivist } from "./archivist.js";
import { entityEmbed, shorten } from "./archivist-format.js";

/**
 * Discord handlers for creating, showing, editing, and deleting characters,
 * accounts, servers, and channels. Editing covers a record's own fields.
 * Dated history is edited on the website, by the owner's decision of
 * 2026-11-23.
 */

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

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

/** Resolves an optional short ID of a related record, keeping full IDs as they are. */
function related(
  archiveId: string,
  kind: EntityKind,
  value: string | undefined,
): string | undefined {
  if (!value?.trim()) return undefined;
  const table = {
    character: "characters",
    account: "accounts",
    server: "servers",
    channel: "channels",
  } as const;
  return resolveShortId(openStore(archivist(), archiveId).db, table[kind], value, kind);
}

export async function createEntityFromCommand(
  interaction: CommandInteraction,
  options: CreateEntityOptions,
): Promise<void> {
  const context = archivist();
  const actor = await actorOf(interaction);
  const archive = resolveArchiveSelection(context, actor, options.archive);
  const archiveId = archive.archiveId;
  const kind = entityKindValue(options.kind);
  const created =
    kind === "character"
      ? createCharacter(context, actor, {
          archiveId,
          knownName: options.name,
          realName: options.realName,
          birthDay: options.birthDay,
          metInPerson: options.metInPerson,
        })
      : kind === "server"
        ? createServer(context, actor, {
            archiveId,
            label: options.name,
            discordId: options.discordId,
          })
        : kind === "channel"
          ? createChannel(context, actor, {
              archiveId,
              kind: options.channelKind ?? "guild_channel",
              label: options.name,
              serverId: related(archiveId, "server", options.server),
              parentChannelId: related(archiveId, "channel", options.parentChannel),
              discordId: options.discordId,
            })
          : createAccount(context, actor, {
              archiveId,
              kind: options.accountKind ?? "human",
              label: options.name,
              discordId: options.discordId,
              characterId: related(archiveId, "character", options.character),
            });
  const entity = getEntity(context, actor, { archiveId, kind, id: created.id });
  await interaction.reply(
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
    ...ephemeral,
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

/** Shows the edit form for an entity's own fields, bound to the version the person saw. */
export async function showEntityForm(
  interaction: CommandInteraction | ButtonInteraction,
  archiveId: string,
  kind: EntityKind,
  id: string,
  version: number,
): Promise<void> {
  const context = archivist();
  const entity = getEntity(context, await actorOf(interaction), { archiveId, kind, id });
  const db = openStore(context, archiveId).db;
  const table = {
    character: "characters",
    account: "accounts",
    server: "servers",
    channel: "channels",
  }[kind];
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(entity.id) as Record<
    string,
    string | null
  >;
  const rows =
    kind === "character"
      ? [
          formRow("knownName", "Known name", row.known_name, true),
          formRow("realName", "Real name (empty to clear)", row.real_name),
          formRow("birthDay", "Birth day (empty to clear)", row.birth_day),
          formRow("metInPerson", "Met in person: yes, no, or unknown", row.met_in_person, true, 7),
        ]
      : [
          formRow("label", "Name", row.label, true),
          formRow("discordId", "Discord ID (empty to clear)", row.discord_id, false, 20),
          ...(kind === "account"
            ? [
                formRow(
                  "character",
                  "Character (empty to unlink)",
                  row.character_id
                    ? `${(db.prepare("SELECT known_name AS n FROM characters WHERE id = ?").get(row.character_id) as { n: string }).n} (${row.character_id.slice(0, 8)})`
                    : null,
                ),
                formRow("subkind", "Kind: human or bot", row.kind, true, 5),
              ]
            : [formRow("color", "Lane color, such as #5865f2", row.color, true, 7)]),
        ];
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(`ax:eform:${archiveId}:${LETTERS[kind]}:${entity.id}:${version}`)
      .setTitle(shorten(`Edit ${kind} ${entity.name}`, 45))
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
  const context = archivist();
  const actor = await actorOf(interaction);
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
      const found = resolvePeople(openStore(context, archiveId).db, character);
      if (found.length !== 1) {
        throw new ArchivistError("invalid_input", "Give one character for the account.", {
          field: "character",
        });
      }
      characterId = found[0];
    }
  }
  const before = getEntity(context, actor, { archiveId, kind, id });
  const updated = updateEntity(context, actor, {
    archiveId,
    kind,
    id,
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
  const name = registeredArchive(context, archiveId)?.name ?? "the archive";
  await interaction.reply(
    entityReply(
      updated,
      archiveId,
      name,
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
  const context = archivist();
  const actor = await actorOf(interaction);
  const archive = resolveArchiveSelection(context, actor, options.archive);
  const entity = getEntity(context, actor, {
    archiveId: archive.archiveId,
    kind: options.kind,
    id: options.id,
  });
  await interaction.reply(entityReply(entity, archive.archiveId, archive.name));
}

/** Asks for confirmation, or explains what still links to the entity. */
export async function askDeleteEntity(
  interaction: CommandInteraction,
  options: { archive?: string; kind: string; id: string },
): Promise<void> {
  const context = archivist();
  const actor = await actorOf(interaction);
  const archive = resolveArchiveSelection(context, actor, options.archive);
  const entity = getEntity(context, actor, {
    archiveId: archive.archiveId,
    kind: options.kind,
    id: options.id,
  });
  const blockers = entityBlockers(openStore(context, archive.archiveId).db, entity.kind, entity.id);
  if (Object.keys(blockers).length > 0) {
    const summary = Object.entries(blockers)
      .map(([label, count]) => `${count} ${label}`)
      .join(", ");
    throw new ArchivistError(
      "reference_blocked",
      `${entity.name} is still linked from ${summary}. Remove those links first.`,
    );
  }
  await interaction.reply({
    ...ephemeral,
    content:
      `Permanently delete ${entity.kind} **${entity.name}**? There is no trash or undo. ` +
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
  deleteEntity(archivist(), await actorOf(interaction), {
    archiveId,
    kind,
    id,
    expectedVersion: Number(version),
  });
  await interaction.update({ content: `Deleted the ${kind}.`, components: [] });
}

/** The archive named in the command being typed, or the remembered one, without changing it. */
export async function typedArchive(interaction: AutocompleteInteraction): Promise<string | null> {
  const actor = await actorOf(interaction);
  const typed = interaction.options.getString("archive");
  try {
    return typed
      ? requireArchiveAccess(archivist(), actor, typed).archiveId
      : resolveArchiveSelection(archivist(), actor, undefined).archiveId;
  } catch {
    return null;
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
  const archiveId = await typedArchive(interaction);
  const focused = interaction.options.getFocused(true);
  let kind: EntityKind | undefined = OPTION_KINDS[focused.name];
  if (!kind) {
    try {
      kind = entityKindValue(interaction.options.getString("kind"));
    } catch {
      kind = undefined;
    }
  }
  if (!archiveId || !kind) {
    await interaction.respond([]);
    return;
  }
  const hits = searchEntities(openStore(archivist(), archiveId).db, kind, String(focused.value));
  await interaction.respond(
    hits.map((hit) => ({
      name: shorten(`${hit.label} (${hit.id.slice(0, 8)})`, 100),
      value: hit.id,
    })),
  );
}

/** Suggests artifacts by description or ID. */
export async function suggestArtifactIds(interaction: AutocompleteInteraction): Promise<void> {
  const archiveId = await typedArchive(interaction);
  if (!archiveId) {
    await interaction.respond([]);
    return;
  }
  const hits = searchArtifacts(
    openStore(archivist(), archiveId).db,
    interaction.options.getFocused(),
  );
  await interaction.respond(
    hits.map((hit) => ({
      name: shorten(`${hit.id.slice(0, 8)} ${hit.label.replace(/\s+/g, " ")}`, 100),
      value: hit.id,
    })),
  );
}
