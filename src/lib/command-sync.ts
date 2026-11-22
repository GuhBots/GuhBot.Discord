import {
  type ApplicationCommand,
  type ApplicationCommandData,
  ApplicationCommandType,
  DiscordAPIError,
  type Guild,
  RESTJSONErrorCodes,
} from "discord.js";
import type { Client, DApplicationCommand } from "discordx";

/**
 * Makes the commands Discord shows match the commands in the code, and
 * removes every other command registered for the application.
 *
 * discordx's own `initApplicationCommands` is not used for this. It skips
 * the update when no global commands remain, so stale global commands are
 * never deleted, and it drops the Activity entry point command, which makes
 * Discord reject the update.
 */

const GLOBAL = "global";

/** How many servers to check at once, to stay well inside Discord's rate limits. */
const GUILD_CONCURRENCY = 5;

type Scopes = Map<string, ApplicationCommandData[]>;

/** Resolves a command's `@Guild` targets, which can be IDs or functions. */
async function explicitGuilds(client: Client, command: DApplicationCommand): Promise<string[]> {
  const resolved = await Promise.all(
    command.guilds.map((guild) => (typeof guild === "function" ? guild(client, command) : guild)),
  );
  return resolved.flat();
}

/**
 * Groups the code's commands by where they belong: "global" or a guild ID.
 * A command's own `@Guild` wins. Otherwise DEV_GUILD_ID, through the client's
 * `botGuilds`, moves it to the development server. Otherwise it is global.
 */
async function commandsByScope(client: Client): Promise<Scopes> {
  const devGuilds = await client.botResolvedGuilds;
  const scopes: Scopes = new Map();
  for (const command of client.applicationCommands) {
    if (!command.isBotAllowed(client.botId)) continue;
    const own = await explicitGuilds(client, command);
    const targets = own.length ? own : devGuilds.length ? devGuilds : [GLOBAL];
    const data = command.toJSON() as ApplicationCommandData;
    for (const scope of targets) {
      scopes.set(scope, [...(scopes.get(scope) ?? []), data]);
    }
  }
  return scopes;
}

/** Returns the names of existing commands that the update removes. */
function staleNames(
  existing: Iterable<ApplicationCommand>,
  wanted: ApplicationCommandData[],
): string[] {
  const names = new Set(wanted.map((command) => command.name));
  return [...existing]
    .filter((command) => command.type !== ApplicationCommandType.PrimaryEntryPoint)
    .filter((command) => !names.has(command.name))
    .map((command) => command.name);
}

/** Copies an Activity entry point so that a bulk update keeps it unchanged. */
function keepEntryPoint(command: ApplicationCommand): ApplicationCommandData {
  return {
    type: ApplicationCommandType.PrimaryEntryPoint,
    name: command.name,
    nameLocalizations: command.nameLocalizations ?? undefined,
    description: command.description,
    descriptionLocalizations: command.descriptionLocalizations ?? undefined,
    handler: command.handler ?? undefined,
    contexts: command.contexts ?? undefined,
    integrationTypes: command.integrationTypes ?? undefined,
  };
}

/** Replaces the global commands, keeping the Activity entry point if the app has one. */
async function syncGlobal(client: Client, wanted: ApplicationCommandData[]): Promise<string[]> {
  const commands = client.application!.commands;
  const existing = [...(await commands.fetch()).values()];
  const entryPoints = existing
    .filter((command) => command.type === ApplicationCommandType.PrimaryEntryPoint)
    .map(keepEntryPoint);
  await commands.set([...wanted, ...entryPoints]);
  return staleNames(existing, wanted);
}

/**
 * Replaces one server's commands. It skips the update when the server has
 * no commands and should have none, which is the case for most servers.
 */
async function syncGuild(guild: Guild, wanted: ApplicationCommandData[]): Promise<string[]> {
  const existing = [...(await guild.commands.fetch()).values()];
  if (existing.length === 0 && wanted.length === 0) return [];
  await guild.commands.set(wanted);
  return staleNames(existing, wanted);
}

/** Runs `task` on each item, with at most `limit` running at once. */
async function forEachLimited<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      await task(items[next++]!);
    }
  });
  await Promise.all(workers);
}

/** Syncs global commands and the commands in every server the bot is in. */
export async function syncAllCommands(client: Client): Promise<void> {
  const scopes = await commandsByScope(client);
  const global = scopes.get(GLOBAL) ?? [];
  const removedGlobal = await syncGlobal(client, global);
  console.log(
    `Commands: ${global.length} global` +
      (removedGlobal.length ? `, removed ${removedGlobal.join(", ")}` : ""),
  );

  const guilds = [...client.guilds.cache.values()];
  let withoutScope = 0;
  await forEachLimited(guilds, GUILD_CONCURRENCY, async (guild) => {
    const wanted = scopes.get(guild.id) ?? [];
    try {
      const removed = await syncGuild(guild, wanted);
      if (wanted.length || removed.length) {
        console.log(
          `Commands: ${wanted.length} in ${guild.name} (${guild.id})` +
            (removed.length ? `, removed ${removed.join(", ")}` : ""),
        );
      }
    } catch (error) {
      if (isMissingAccess(error) && wanted.length === 0) {
        withoutScope++;
        return;
      }
      console.error(`Could not sync commands in ${guild.name} (${guild.id}):`, error);
    }
  });
  console.log(
    `Commands: checked ${guilds.length} servers` +
      (withoutScope
        ? `. ${withoutScope} invited the bot without the applications.commands scope, so they can't have server commands`
        : ""),
  );
}

/**
 * Discord answers Missing Access when the bot was invited without the
 * applications.commands scope. Such a server can't hold server commands, so
 * there is nothing to remove. Global commands still work there.
 */
function isMissingAccess(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.MissingAccess;
}

/** Syncs one server's commands, such as after the bot joins it. */
export async function syncGuildCommands(client: Client, guild: Guild): Promise<void> {
  const wanted = (await commandsByScope(client)).get(guild.id) ?? [];
  let removed: string[];
  try {
    removed = await syncGuild(guild, wanted);
  } catch (error) {
    if (isMissingAccess(error) && wanted.length === 0) return;
    throw error;
  }
  console.log(
    `Commands: ${wanted.length} in ${guild.name} (${guild.id})` +
      (removed.length ? `, removed ${removed.join(", ")}` : ""),
  );
}
