import { fileURLToPath } from "node:url";
import type { Client } from "discord.js";
import { requireOwner } from "../archivist/access.js";
import type { Actor } from "../archivist/context.js";
import { buildWebApp } from "../archivist/web/app.js";
import { WebListener, type WebStatus } from "../archivist/web/listener.js";
import { checkWebSettings } from "../archivist/web/settings.js";
import { config } from "../config.js";
import { archivist } from "./archivist.js";
import { onShutdown } from "./lifecycle.js";
import { isApplicationOwner } from "./owner.js";

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
