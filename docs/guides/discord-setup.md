# Discord Setup

This guide connects the bot to a Discord application and fills in its settings. Do it once for the test bot on your own computer and once for the production bot on the server.

GuhBot has two applications. The production bot's application ID is `624754986248831017` and the test bot's is `707321853198467163`. Develop with the test bot, so that nothing you run while developing affects production.

## Prerequisites

* Access to the application in the [Discord Developer Portal](https://discord.com/developers/applications). The application's owners can also run the owner commands.
* A test server where you can add bots, for development.
* Developer Mode in Discord, under **User Settings** > **Advanced**, so that you can copy server and channel IDs with a right-click.

## Get the Token

1. Open the application in the Developer Portal and select **Bot**.
2. Select **Reset Token** and copy the token. Discord shows it only once.
3. Put it in `.env` as `DISCORD_TOKEN`, or in the stack's environment variables in Portainer. Never commit it or paste it in chat. If a token leaks, reset it.

The bot needs no privileged gateway intents. Leave **Presence Intent**, **Server Members Intent**, and **Message Content Intent** turned off.

## Invite the Bot

Run `/support` or `/stats` and use the **Bot Invite** link, which includes the permissions and scopes the bot needs. Before the bot is running, build the link by hand, replacing `<application-id>` with the application ID.

```text
https://discord.com/oauth2/authorize?client_id=<application-id>&scope=bot+applications.commands&permissions=536210679
```

The `applications.commands` scope lets the bot register slash commands. A server that added the bot before slash commands existed must reinvite it with this link before the commands appear.

## Fill In the Settings

`.env.example` lists every setting with an explanation. Copy it to `.env` and fill it in.

| Setting | Development | Production |
| --- | --- | --- |
| `DISCORD_TOKEN` | The test bot's token | The production bot's token |
| `DEV_GUILD_ID` | Your test server's ID | Empty |
| `OWNER_GUILD_ID` | Your test server's ID, to try owner commands | The server where you run owner commands |
| `MODULES` | Empty, or only the modules you are testing | Empty for every module, or the modules to turn on |
| `ARCHIVIST_GUILD_IDS` | Your test server's ID, to try the Archivist module | The servers that use the Archivist module |
| `GOOGLE_DRIVE_API_KEY` | Empty | Empty, or a key restricted to the Drive API. Public Drive links work without it. With a key, Archivist uses Google's official Drive API instead |
| `STATUS_CHANNEL_ID` | Empty, or a test channel | The channel for startup and shutdown messages |
| `SUPPORT_URL`, `WEBSITE_URL`, `TOPGG_URL`, `DISCORDBOTLIST_URL` | Optional | The links to show. Leave one empty to hide it |

## How Commands Are Registered

The code is the only source of the application's commands. Each time the bot logs in, it registers the commands in the code and deletes every other command registered for the application, globally and in every server it is in. When it joins a server, it syncs that server's commands.

* **With `DEV_GUILD_ID`:** Commands are registered in that server only and update at once. No commands are registered globally. Use this while developing.
* **Without it:** Commands are registered globally, in every server. Discord can take up to an hour to show changes everywhere.
* **Owner commands:** These are registered only in `OWNER_GUILD_ID`, in either mode.
* **Modules limited to some servers:** Their commands are registered only in the servers their setting lists, such as `ARCHIVIST_GUILD_IDS`, in either mode.
* **Modules that are off:** Their commands are not registered, so turning a module off and restarting the bot removes its commands.

The sync keeps the application's Activity entry point command, named `launch`, because Discord does not let a bot remove it this way. Servers that invited the bot without the `applications.commands` scope cannot hold server commands, so the bot skips them and reports how many there are.

Because the sync deletes commands it does not know, only one program may register commands for an application. Two codebases sharing a token would delete each other's commands.

## Expected Result

The bot logs `Logged in as <bot name>, version <version>`, shows a status such as "Watching /help", and its commands appear when you type `/` in the server.
