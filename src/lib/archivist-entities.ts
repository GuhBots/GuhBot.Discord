import {
  ActionRowBuilder,
  type AutocompleteInteraction,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type CommandInteraction,
  MessageFlags,
} from "discord.js";
import { requireArchiveAccess } from "../archivist/access.js";
import { openStore } from "../archivist/context.js";
import {
  createAccount,
  createChannel,
  createCharacter,
  createServer,
  deleteEntity,
  entityBlockers,
  type EntityKind,
  entityKindValue,
  getEntity,
} from "../archivist/entities.js";
import { ArchivistError } from "../archivist/errors.js";
import { resolveShortId } from "../archivist/people.js";
import { resolveArchiveSelection } from "../archivist/preferences.js";
import { searchArtifacts, searchEntities } from "../archivist/search.js";
import { actorOf, archivist } from "./archivist.js";
import { entityEmbed, shorten } from "./archivist-format.js";

/** Discord handlers for creating, showing, and deleting characters, accounts, servers, and channels. */

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
  await interaction.reply({
    ...ephemeral,
    content: `Created in **${archive.name}**.`,
    embeds: [entityEmbed(entity, archive.name)],
  });
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
  await interaction.reply({ ...ephemeral, embeds: [entityEmbed(entity, archive.name)] });
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
async function typedArchive(interaction: AutocompleteInteraction): Promise<string | null> {
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
