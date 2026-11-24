import { GatewayIntentBits } from "discord.js";
import { config } from "./config.js";
import { archivistServerIds } from "./lib/archivist-servers.js";

/**
 * A group of commands and listeners that can be turned on or off as a unit.
 * Each module is one /help category. Its command classes use the module's
 * `name` with `@Category`.
 */
export interface BotModule {
  /** The /help heading. Its lowercase form is the name used in MODULES. */
  name: string;
  /** The /help description. */
  description: string;
  /** Gateway intents the module needs beyond Guilds, which every module gets. */
  intents?: readonly GatewayIntentBits[];
  /** Loads even when MODULES leaves it out, because the bot needs it. */
  alwaysOn?: boolean;
  /**
   * Limits the module to the servers `ids` returns, which can change while the
   * bot runs. Its command classes must use `@Guild` with the same function, so
   * its commands register only there, and /help shows it only there.
   */
  servers?: { ids(): readonly string[] };
  /**
   * Settings the module cannot run without. When MODULES is unset, a module
   * missing them stays off. When MODULES names it, its `load` stops the start
   * with a message naming them.
   */
  settings?: { names: readonly string[]; present: boolean };
  /** Imports the module's files, which registers their commands and listeners with discordx. */
  load(): Promise<void>;
}

/** Every module, in /help order. */
export const ALL_MODULES: readonly BotModule[] = [
  {
    name: "Fun",
    description: "What more can I say? They're fun commands.",
    load: async () => void (await import("./commands/fun.js")),
  },
  {
    name: "Games",
    description: "Some games to play in your server!",
    load: async () => void (await import("./commands/games.js")),
  },
  {
    name: "Images",
    description: "Image manipulation commands",
    load: async () => void (await import("./commands/images.js")),
  },
  {
    name: "Misc",
    description: "Miscellaneous Commands",
    // The AFK listener sees who talks and who they mention.
    intents: [GatewayIntentBits.GuildMessages],
    load: async () => {
      await import("./commands/misc.js");
      await import("./events/afk.js");
    },
  },
  {
    name: "Moderation",
    description: "Commands for your Moderators",
    load: async () => void (await import("./commands/moderation.js")),
  },
  {
    name: "Roleplay",
    description: "Roleplay Commands!!!",
    load: async () => void (await import("./commands/roleplay.js")),
  },
  {
    name: "Archivist",
    description: "Archiving tools for this server",
    servers: { ids: () => archivistServerIds() },
    settings: {
      names: ["ARCHIVIST_API_URL", "ARCHIVIST_SERVICE_TOKEN"],
      present: Boolean(config.archivistApi.url && config.archivistApi.token),
    },
    load: async () => {
      // The commands call the separate Archivist service, so its address and
      // token must be set. This stops the start with a message naming them.
      const { archivistApi } = await import("./lib/archivist-api.js");
      archivistApi();
      reportArchivistServers();
      await import("./commands/archivist.js");
      // Posts the upload announcements Archivist queues, such as for website uploads.
      await import("./events/archivist-announcements.js");
      // Archivist administration is an owner command, so it registers only in
      // the owner's server, and only when Archivist itself is on.
      if (config.ownerGuildId) await import("./commands/archivist-admin.js");
    },
  },
  {
    name: "Meta",
    description: "About the bot",
    alwaysOn: true,
    load: async () => void (await import("./commands/meta.js")),
  },
];

/** The name a module goes by in MODULES. */
export function moduleKey(module: BotModule): string {
  return module.name.toLowerCase();
}

/** Fails on names in MODULES that match no module, so a typo does not silently turn one off. */
function checkRequestedNames(requested: readonly string[]): void {
  const known = new Set(ALL_MODULES.map(moduleKey));
  const unknown = requested.filter((name) => !known.has(name));
  if (unknown.length) {
    throw new Error(
      `MODULES names unknown modules: ${unknown.join(", ")}. ` +
        `Known modules: ${[...known].join(", ")}.`,
    );
  }
}

if (config.modules) checkRequestedNames(config.modules);

/** Whether MODULES asks for the module. Every module is asked for when MODULES is unset. */
function isRequested(module: BotModule): boolean {
  return module.alwaysOn || !config.modules || config.modules.includes(moduleKey(module));
}

/**
 * Modules on by default because MODULES is unset, but missing their settings.
 * They stay off, so a bot without them still starts.
 */
export const MODULES_WITHOUT_SETTINGS: readonly BotModule[] = config.modules
  ? []
  : ALL_MODULES.filter((module) => module.settings && !module.settings.present);

/** The modules this run of the bot loads. */
export const ENABLED_MODULES: readonly BotModule[] = ALL_MODULES.filter(
  (module) => isRequested(module) && !MODULES_WITHOUT_SETTINGS.includes(module),
);

/** Whether a loaded module works in a server. */
export function isAvailableIn(module: BotModule, guildId: string | null): boolean {
  return !module.servers || (guildId !== null && module.servers.ids().includes(guildId));
}

/** Logs where the Archivist commands work, and how to change it. */
function reportArchivistServers(): void {
  const count = archivistServerIds().length;
  const manage = config.ownerGuildId
    ? "Add servers with /archivist-admin server add."
    : "Set OWNER_GUILD_ID to manage them with /archivist-admin server.";
  console.log(
    count
      ? `Archivist: commands are on in ${count} server(s).`
      : `Archivist: commands are on in no servers yet. ${manage}`,
  );
}

/** The gateway intents the enabled modules need. */
export function requiredIntents(): GatewayIntentBits[] {
  const intents = new Set<GatewayIntentBits>([GatewayIntentBits.Guilds]);
  for (const module of ENABLED_MODULES) {
    for (const intent of module.intents ?? []) intents.add(intent);
  }
  return [...intents];
}

/** Imports every enabled module and logs which modules are on. */
export async function loadModules(): Promise<void> {
  for (const module of ENABLED_MODULES) {
    await module.load();
  }
  console.log(`Modules: ${ENABLED_MODULES.map((module) => module.name).join(", ")}`);
  for (const module of MODULES_WITHOUT_SETTINGS) {
    console.log(
      `Modules: ${module.name} is off until ${module.settings!.names.join(" and ")} are set`,
    );
  }
}
