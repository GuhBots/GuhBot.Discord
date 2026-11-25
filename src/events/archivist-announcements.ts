import type { Client } from "discord.js";
import { type ArgsOf, Discord, Once } from "discordx";
import { claimAndPost, type Poller, startPoller } from "../lib/archivist-announce.js";
import { onShutdown } from "../lib/lifecycle.js";

/**
 * Posts upload announcements that wait in Archivist's queue, such as those
 * for artifacts added on the website, every few seconds while the bot is
 * connected. `startPoller` in the announcement module runs the rounds.
 */

@Discord()
export class ArchivistAnnouncements {
  private poller: Poller | undefined;

  @Once({ event: "clientReady" })
  start([client]: ArgsOf<"clientReady">): void {
    if (this.poller) return;
    const ready = client as Client<true>;
    this.poller = startPoller(() => claimAndPost(ready));
    void this.poller.tick();
    onShutdown(() => this.poller?.stop());
  }
}
