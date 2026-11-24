import { fileURLToPath } from "node:url";
import { type Client, PermissionFlagsBits } from "discord.js";
import { requireOwner } from "../archivist/access.js";
import type { Actor } from "../archivist/context.js";
import { buildWebApp } from "../archivist/web/app.js";
import { WebListener, type WebStatus } from "../archivist/web/listener.js";
import { checkWebSettings } from "../archivist/web/settings.js";
import { config } from "../config.js";
import { archivist } from "./archivist.js";
import { onShutdown } from "./lifecycle.js";
import { isApplicationOwner } from "./owner.js";
import { announceArtifact } from "./archivist-announce.js";
import { ArchivistError } from "../archivist/errors.js";

/**
 * The bot's single Archivist web listener. It is created stopped, so a bot
 * restart always leaves the website stopped until the owner starts it.
 */

/** The built frontend, `build/web`, next to the compiled bot. */
const FRONTEND_ROOT = fileURLToPath(new URL("../web/", import.meta.url));

let listener: WebListener | undefined;
/** The logged-in client, for owner checks on web requests. Set when the owner starts the website. */
let botClient: Client<true> | undefined;

function webListener(): WebListener {
  if (!listener) {
    const settings = config.archivistWeb;
    listener = new WebListener({
      host: settings.host,
      port: settings.port,
      url: settings.baseUrl,
      build() {
        checkWebSettings(settings);
        return buildWebApp({
          context: archivist(),
          settings,
          isOwner: async (userId) => (botClient ? isApplicationOwner(botClient, userId) : false),
          announce: async (archiveId, artifact) =>
            botClient
              ? announceArtifact(botClient, archivist(), archiveId, artifact)
              : { status: "not_configured" },
          checkAnnouncementChannel: async (userId, channelId) => {
            if (!botClient)
              throw new ArchivistError("dependency_unavailable", "The bot is not connected.");
            return checkLogsChannelFor(botClient, userId, channelId);
          },
          driveApiKey: config.googleDriveApiKey,
          frontendRoot: FRONTEND_ROOT,
          logError: (message, error) => console.error(`Archivist website: ${message}:`, error),
        }).app;
      },
    });
    // Registered before the Archivist context's own hook, so requests finish before stores close.
    onShutdown(async () => {
      await listener?.stop();
    });
  }
  return listener;
}

// Create the listener when this module loads, so its shutdown hook runs first.
webListener();

/** Starts the website for the owner. A running website is left as it is. */
export function startWeb(client: Client<true>, actor: Actor): Promise<WebStatus> {
  requireOwner(actor, "start the website");
  botClient = client;
  return webListener().start();
}

/** Stops the website for the owner. A stopped website stays stopped. */
export function stopWeb(actor: Actor): Promise<WebStatus> {
  requireOwner(actor, "stop the website");
  return webListener().stop();
}

export function webStatus(actor: Actor): WebStatus {
  requireOwner(actor, "see the website's status");
  return webListener().status();
}

/**
 * The same checks as `/set-artifact-logs-channel`: a text channel in a server
 * where Archivist works, where the bot can post embeds and files, and which
 * the contributor can see.
 */
async function checkLogsChannelFor(client: Client<true>, userId: string, channelId: string) {
  const refuse = (message: string) =>
    new ArchivistError("invalid_input", message, { field: "channelId" });
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !("guild" in channel) || !channel.isTextBased()) {
    throw refuse("The bot cannot see a text channel with that ID.");
  }
  if (!config.archivistGuildIds.includes(channel.guild.id)) {
    throw refuse("That channel is in a server where Archivist is not turned on.");
  }
  const me = channel.guild.members.me;
  const needed = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
  ];
  if (!me || !channel.permissionsFor(me).has(needed)) {
    throw refuse("The bot needs to see the channel and post messages, embeds, and files in it.");
  }
  const member = await channel.guild.members.fetch(userId).catch(() => null);
  if (!member || !channel.permissionsFor(member).has(PermissionFlagsBits.ViewChannel)) {
    throw refuse("You need to be able to see that channel yourself.");
  }
  return { guildId: channel.guild.id };
}
