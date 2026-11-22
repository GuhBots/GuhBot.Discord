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
| `STATUS_CHANNEL_ID` | Empty, or a test channel | The channel for startup and shutdown messages |
| `SUPPORT_URL`, `WEBSITE_URL`, `TOPGG_URL`, `DISCORDBOTLIST_URL` | Optional | The links to show. Leave one empty to hide it |

## How Commands Are Registered

When the bot logs in, and again whenever it joins a server, it sends its commands to Discord.

* **With `DEV_GUILD_ID`:** Commands are registered in that server only and update at once. Use this while developing.
* **Without it:** Commands are registered globally, in every server. Discord can take up to an hour to show changes everywhere.

The bot replaces any commands that Discord has registered for it in the same place, so removed commands disappear on the next start. Commands registered in a development server stay there after `DEV_GUILD_ID` is cleared, so a server that has both shows each command twice. Keep development servers separate from the servers the production bot serves.

## Expected Result

The bot logs `Logged in as <bot name>, version <version>`, shows a status such as "Watching /help", and its commands appear when you type `/` in the server.
