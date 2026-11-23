# Command Reference

Every slash command, grouped by its /help module. The "Original" column gives the GuhBot.Prime prefix command and its aliases. Slash commands have no aliases, so each command keeps one name.

The `MODULES` setting chooses which modules are on, as [Discord Setup](guides/discord-setup.md#fill-in-the-settings) describes. A module that is off has no commands and is missing from /help.

All commands work only in servers, as the original bot did. Each command has a per-user cooldown in each server, carried over from the original.

## Fun

| Command | Original | Notes |
| --- | --- | --- |
| `/echo <message>` | `echo`, `say`, `repeat` | Needs Manage Messages. Posts the message as an embed and confirms privately, because a slash command leaves no message to delete |
| `/pp [member]` | `pp` and aliases | Hidden from /help |
| `/emoji <emoji>` | `emoji`, `emote` | Works only with emojis from servers the bot is in |
| `/enlarge <emoji>` | `enlarge` | |
| `/guh` | `guh` | Hidden from /help |
| `/kanye` | `kanye` and aliases | |

## Games

| Command | Original | Notes |
| --- | --- | --- |
| `/roll [dice]` | `roll`, `dice`, `dice_roll` | Choices from `D00` to `D20`. Defaults to `D6` |
| `/8ball <question>` | `eightball`, `8ball`, `8_ball` | |
| `/decide <question>` | `decide`, `decision` | |
| `/coinflip` | `coinflip`, `heads`, `tails`, `coin`, `cf` | |

## Images

Each command defaults to your own avatar.

| Command | Original | Notes |
| --- | --- | --- |
| `/australia [member]` | `australia` and aliases | |
| `/rotate [member] [angle]` | `rotate` | Rotates counterclockwise and keeps the original size |
| `/grayscale [member]` | `grayscale`, `greyscale`, `grey`, `gray` | |
| `/ross [member]` | `ross` | |
| `/trash [member]` | `trash` | |

## Misc

| Command | Original | Notes |
| --- | --- | --- |
| `/serverinfo` | `server_info`, `server_stats`, `server` | Hidden from /help. Region and the humans and bots counts are gone. They need data Discord no longer provides, or a privileged intent |
| `/roleinfo [role]` | `role_info`, `role_stats`, `role` | The member count is gone, because it needs the privileged Server Members intent |
| `/avatar [member]` | `avatar`, `av`, `pfp`, and others | |
| `/whois [member]` | `whois`, `user_info`, `who_is` | Online status is gone, because it needs the privileged Presence intent |
| `/afk [reason]` | `afk`, `afkon`, `afk_on` | Reasons are limited to 150 characters. Running it again replaces the reason |

The AFK listener works as before. When an AFK user sends a message, the bot clears their status and tells them how many times they were mentioned. When someone mentions an AFK user, the bot says they are away. Both notices disappear after 15 seconds.

## Moderation

Each command is shown only to members with the matching permission. The bot also checks that the moderator outranks the target and that its own role is high enough.

| Command | Original | Notes |
| --- | --- | --- |
| `/clear [amount]` | `clear`, `delete`, `purge` | Manage Messages. Deletes 1 to 100 messages, default 6. Skips messages older than two weeks |
| `/kick <member> [reason]` | `kick` | Kick Members. Sends the member the embed before kicking them |
| `/ban <member> [reason]` | `ban` | Ban Members. Sends the member the embed before banning them |
| `/unban <user> [reason]` | `unban` | Ban Members. Accepts a user ID or username |
| `/unkick [member] [reason]` | `unkick` | Kick Members. A joke command that does nothing. Hidden from /help |

## Roleplay

| Command | Original | Notes |
| --- | --- | --- |
| `/dab [member]` | `dab` | |
| `/fart [user]` | `fart` | Hidden from /help |

## Archivist

Archiving tools for specific servers, described in the [Archivist plan](proposals/ARCHIVIST-PLAN.md). The module is new and has no counterpart in the original bot. It works only in the servers listed in `ARCHIVIST_GUILD_IDS`, and /help shows it only there. Only people on an archive's whitelist, and the bot owner, can use that archive. Replies are private.

Archivist is being built in milestones. These commands exist so far.

| Command | Original | Notes |
| --- | --- | --- |
| `/archivist archive list` | None | Lists the archives you can use |
| `/archivist preferences show` | None | Shows how your typed dates and times are read |
| `/archivist preferences timezone <timezone>` | None | Sets the timezone your typed times are read in when you don't add a zone. Suggests timezone names as you type |
| `/archivist preferences date-order <order>` | None | Sets how all-number dates such as 03/04/2019 are read: year-month-day (the default), month-day-year, or day-month-year |
| `/archivist preferences reset` | None | Clears both, so typed times use each archive's timezone and all-number dates are read year first |
| `/archivist artifact add <description> [file] [drive_link] [people] [exact_date] [estimated_day] [estimate_reason] [archive]` | None | Archives one file or one public Google Drive file link. People are names separated by commas, with suggestions. An exact date needs no explanation, and an estimated day needs a reason. A time typed without a zone is confirmed before saving. A file already in the archive opens a review of what to change instead. The reply has Edit, Add people, Someone unidentified, and Delete buttons. Someone unidentified marks that someone in it is not identified yet, and pressing it again clears the mark |
| `/archivist artifact show <id> [archive]` | None | Shows an artifact with its Edit, Add people, and Delete buttons. Suggests artifacts by description |
| `/archivist artifact edit <id> [archive]` | None | Opens a form for the description and dates |
| `/archivist artifact delete <id> [archive]` | None | Asks for confirmation, then deletes permanently. The media file stays in the archive |
| `/archivist entity create <kind> <name> [...] [archive]` | None | Adds a character, account, server, or channel. Optional fields apply to one kind each, such as `birth_day` for characters or `server` for channels |
| `/archivist entity show <kind> <id> [archive]` | None | Shows a character, account, server, or channel. Suggests them by name |
| `/archivist entity delete <kind> <id> [archive]` | None | Deletes permanently once nothing links to it, or says what still does |
| `/set-artifact-logs-channel [channel] [archive]` | None | Announces every new artifact in the archive in a channel, this one by default. The bot must be able to post embeds and files there |
| `/remove-artifact-logs-channel [archive]` | None | Stops future announcements. Earlier posts stay |

`/a` is a short name for `/archivist` with the same commands, such as `/a artifact add`. /help lists them once, under `/archivist`.

Commands that take an archive use the one you chose last when you leave it empty. The archive option comes last, because it is the one you change least.

Dates can be typed in most common forms, such as `2019-07-15`, `Jul 15 2019`, `15 July 2019`, or `july, 2019, 15`, with an optional time such as `18:30` or `6:30pm` and an optional zone after the time, such as `-04:00` or `Europe/London`. Archivist shows dates with the month's name, such as `Jul 15, 2019`, so nobody misreads them.

## Meta

Meta is always on, because it holds /help.


| Command | Original | Notes |
| --- | --- | --- |
| `/help [module]` | `help` | Lists the modules that work in this server, or the commands in one module. Suggests module names as you type |
| `/stats` | `stats`, `statistics`, `info` | Shows Node.js and discord.js versions in place of Python and discord.py |
| `/ping` | `ping`, `latency` | |
| `/support` | `support`, `invite` | The bot invite is built from the running bot's ID. Other links come from settings |
| `/upvote` | `upvote`, `vote` | Shows only the vote links that are set |

## Owner

These commands are registered only in the server named by `OWNER_GUILD_ID`, and only the Discord application's owners can run them. Anyone else gets the rickroll from the original `logout` command.

| Command | Original | Notes |
| --- | --- | --- |
| `/setstatus [status]` | `setstatus`, `status` | Starts with `playing`, `watching`, `listening-to`, or `competing`. Supports `{guilds}`, `{users}`, and `{version}`. With no status, restores the default |
| `/logout [reason]` | `logout`, `close`, `disconnect` | Posts in the status channel and exits. Docker Compose restarts the bot, so use `docker compose stop` to keep it offline |

When the Archivist module is on, the owner server also gets Archivist administration.

| Command | Original | Notes |
| --- | --- | --- |
| `/archivist-admin archive create <name>` | None | Creates an archive folder, database, and edit log |
| `/archivist-admin archive list` | None | Lists every registered archive with its ID |
| `/archivist-admin archive rename <archive> <name> [version]` | None | Renames without moving files. With a version, refuses if the archive changed since |
| `/archivist-admin archive settings <archive> [timezone] [lane_gap_days] [version]` | None | Changes the archive's timezone or timeline lane gap |
| `/archivist-admin archive register <archive_id> [name]` | None | Hosts an archive folder already in the archive directory. Imports no old whitelist |
| `/archivist-admin archive unregister <archive>` | None | Asks for confirmation, then stops hosting the archive. Its files are kept |
| `/archivist-admin whitelist add <archive> <user>` | None | Lets someone use an archive |
| `/archivist-admin whitelist remove <archive> <user>` | None | Takes effect on their next request |
| `/archivist-admin whitelist list <archive> [page]` | None | Lists an archive's members |
| `/archivist-admin export create <archive>` | None | Zips the whole archive folder (database, edit log, originals, previews, and media no longer used by any record) into `archivist-exports/` in the bot's data folder. Replies with the zip's path and updates when it is done. The zip stays until you delete it |
| `/archivist-admin export list` | None | Lists recent exports, their paths and sizes, and whether each zip is still on the host |

Exports are written to `data/archivist-exports/` when the bot runs from source. With Docker Compose they are in the `data` volume at `/data/archivist-exports/`. Copy one out and then remove it from the volume:

```sh
docker compose cp app:/data/archivist-exports/<file>.zip .
docker compose exec app rm /data/archivist-exports/<file>.zip
```

## Removed Commands

| Original | Reason |
| --- | --- |
| `animal`, `pikachu`, `chatbot` | The some-random-api service they used no longer answers |
| `wink`, `pat`, `hug`, `facepalm` | Same as above |
| `meme` | The meme API's old address is gone |
| `covid` | The COVID-19 API it used shut down |
| `akinator` | Akinator blocks automated clients |
| `snipe` | Reading deleted messages needs the privileged Message Content intent |
| `prefix` | The bot uses slash commands only, so there is no prefix to change |
| `update`, `load`, `unload`, `reload` | They managed the scheduler and Python cogs, which no longer exist |
