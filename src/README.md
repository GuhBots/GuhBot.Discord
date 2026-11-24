# Source

The bot's TypeScript source. `npm run build` compiles it to `build/`.

## Layout

| Path | Contents |
| --- | --- |
| `main.ts` | Entry point. Loads the enabled modules, creates the client, and logs in |
| `config.ts` | Settings read from environment variables, and paths to `assets/` |
| `modules.ts` | The list of modules, and which ones this run loads |
| `commands/` | One file per module, plus `owner.ts` for owner commands and `archivist-admin.ts` for Archivist administration |
| `events/` | Gateway event listeners, such as the AFK listener, and the poller that posts Archivist's queued announcements |
| `lib/` | Shared helpers for command sync, embeds, cooldowns, the database, presence, shutdown, and the Archivist commands' client of the Archivist service's API |

## Modules

A module is a group of commands and listeners that the `MODULES` setting turns on or off. Each module is one /help category. `ALL_MODULES` in `modules.ts` lists every module with its /help description, the gateway intents it needs, and a `load` function that imports its files. A module that is off never loads, so its commands are never registered and the bot does not request its intents.

* **Always on:** Meta holds /help, so it loads even when `MODULES` leaves it out.
* **Limited to some servers:** A module with `servers` works only in the servers its setting lists, such as Archivist with `ARCHIVIST_GUILD_IDS`. Its command classes use `@Guild` with the same IDs, so its commands register only there, and /help shows it only there. It stays off while its setting is empty.

`modules.ts` stops the bot at startup when `MODULES` names a module that does not exist, so a typo does not silently turn a module off. The bot logs which modules are on when it starts.

## How Commands Are Registered

Each module file declares a class with discordx's `@Discord` decorator. Its methods use `@Slash` for commands and `@SlashOption` for options. Importing the file registers the commands, so each module's `load` imports its files. When the bot logs in, `lib/command-sync.ts` sends the commands to Discord and deletes any command that the code does not define. It registers them globally, or only in `DEV_GUILD_ID` when that is set. It replaces discordx's `initApplicationCommands`, which never deletes stale global commands when no global commands remain, and which drops the Activity entry point command.

Owner commands in `commands/owner.ts` use `@Guild` to register only in `OWNER_GUILD_ID`. `main.ts` imports the module only when that setting exists.

## Adding a Command

1. Add a method to the class in the matching `commands/` file. For a new module, add a file and add the module to `ALL_MODULES` in `modules.ts`, with the same name as its `@Category`.
2. Decorate it with `@Slash({ name, description, ...GUILD_ONLY })` and `@Guard(Cooldown(seconds))`.
3. Add `defaultMemberPermissions` for commands that only moderators should see.
4. For a module limited to some servers, add a setting for its server IDs to `config.ts`, `.env.example`, and `compose.yaml`, and use it in both `servers` and `@Guild`.
5. Add the command to the [Command Reference](../docs/commands.md).

Use the helpers in `lib/embeds.ts` so that replies match the rest of the bot. `baseEmbed` colours an embed by the member's role. `replyError` sends the standard error embed.
