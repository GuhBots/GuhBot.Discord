# Archivist Plan

The Archivist plan moved to the service's repository on 2026-11-24: [GuhBot.Archivist's Archivist plan](https://github.com/GuhBots/GuhBot.Archivist/blob/main/docs/proposals/ARCHIVIST-PLAN.md). It is the canonical specification for Archivist, including the commands this bot keeps. Do not keep a competing copy here.

## Discord Integration

Archivist is a separate service, GuhBot.Archivist, that holds the archives, their media, and their rules, and serves the website. This bot keeps no archive data. Its Archivist commands are clients of the service's JSON API, whose contract is the service's [Bot API](https://github.com/GuhBots/GuhBot.Archivist/blob/main/docs/design/bot-api.md).

* **Commands.** Contributors use `/archive` and `/a`, and owners use `/archivist-admin` in the owner server. The logs-channel commands set where new artifacts are announced. [Commands](../commands.md#archivist) lists them.
* **Connection.** `ARCHIVIST_API_URL` and `ARCHIVIST_SERVICE_TOKEN` connect the bot to the service, as [Discord Setup](../guides/discord-setup.md#connecting-to-archivist) explains. Every request sends the token and the Discord user who ran the command, and the service checks that user's access itself.
* **Servers.** The servers where `/archive` and `/a` work are kept in the bot's `guhbot.db`. Archivist's owners change them with `/archivist-admin server`. Member whitelists stay in the service, which checks them at website sign-in.
* **Announcements.** New artifacts from the website or Discord are queued by the service. The bot claims queued posts, posts them in the archive's logs channel, and reports how each went.
* **Code.** `src/commands/archivist.ts`, `src/commands/archivist-admin.ts`, `src/lib/archivist-*.ts`, and `src/events/archivist-announcements.ts`, with tests in `tests/archivist/discord/`.
