# Source

The bot's TypeScript source. `npm run build` compiles it to `build/`.

## Layout

| Path | Contents |
| --- | --- |
| `main.ts` | Entry point. Imports every command module, creates the client, and logs in |
| `config.ts` | Settings read from environment variables, and paths to `assets/` |
| `commands/` | One module per /help category, plus `owner.ts` for owner commands |
| `events/` | Gateway event listeners, such as the AFK listener |
| `lib/` | Shared helpers for command sync, embeds, cooldowns, the database, presence, and shutdown |

## How Commands Are Registered

Each command module declares a class with discordx's `@Discord` decorator. Its methods use `@Slash` for commands and `@SlashOption` for options. Importing the module registers the commands, so `main.ts` imports each module explicitly. When the bot logs in, `lib/command-sync.ts` sends the commands to Discord and deletes any command that the code does not define. It registers them globally, or only in `DEV_GUILD_ID` when that is set. It replaces discordx's `initApplicationCommands`, which never deletes stale global commands when no global commands remain, and which drops the Activity entry point command.

Owner commands in `commands/owner.ts` use `@Guild` to register only in `OWNER_GUILD_ID`. `main.ts` imports the module only when that setting exists.

## Adding a Command

1. Add a method to the class in the matching `commands/` module, or add a new module and import it in `main.ts`.
2. Decorate it with `@Slash({ name, description, ...GUILD_ONLY })` and `@Guard(Cooldown(seconds))`.
3. Add `defaultMemberPermissions` for commands that only moderators should see.
4. For a new module, add its category to `CATEGORIES` in `lib/categories.ts` so that /help lists it.
5. Add the command to the [Command Reference](../docs/commands.md).

Use the helpers in `lib/embeds.ts` so that replies match the rest of the bot. `baseEmbed` colours an embed by the member's role. `replyError` sends the standard error embed.
