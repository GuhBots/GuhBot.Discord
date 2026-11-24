import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { ArchivistError } from "../errors.js";

/**
 * The one web listener in the bot process. Only the owner starts and stops
 * it, and a bot restart leaves it stopped, so nothing here persists. A
 * repeated start reports the running listener, and a repeated stop reports
 * that it is stopped. Starts and stops run one at a time, so they never
 * interleave. Stopping closes web access only. Discord contributions and
 * saved archive data are unaffected.
 */

export interface WebStatus {
  running: boolean;
  /** The address browsers use, from `ARCHIVIST_BASE_URL`. */
  url: string | null;
  /** Where the socket listens, which differs from `url` behind a proxy or with port 0. */
  listening: { host: string; port: number } | null;
  /** When the listener started. */
  since: Date | null;
}

export interface WebListenerOptions {
  host: string;
  port: number;
  url: string;
  /** Checks settings and builds the app. Called on every start, so a fixed setting takes effect. */
  build(): FastifyInstance | Promise<FastifyInstance>;
  now?: () => Date;
}

export class WebListener {
  private app: FastifyInstance | null = null;
  private since: Date | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: WebListenerOptions) {}

  status(): WebStatus {
    if (!this.app) return { running: false, url: null, listening: null, since: null };
    const address = this.app.server.address() as AddressInfo | null;
    return {
      running: true,
      url: this.options.url,
      listening: address ? { host: address.address, port: address.port } : null,
      since: this.since,
    };
  }

  start(): Promise<WebStatus> {
    return this.serial(async () => {
      if (this.app) return this.status();
      const app = await this.options.build();
      try {
        await app.listen({ host: this.options.host, port: this.options.port });
      } catch (error) {
        await app.close().catch(() => undefined);
        throw listenError(error, this.options.host, this.options.port);
      }
      this.app = app;
      this.since = (this.options.now ?? (() => new Date()))();
      return this.status();
    });
  }

  stop(): Promise<WebStatus> {
    return this.serial(async () => {
      const app = this.app;
      this.app = null;
      this.since = null;
      // Close waits for requests in progress, such as a download, to finish.
      if (app) await app.close();
      return this.status();
    });
  }

  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.queue.then(step, step);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** A start failure the owner can act on. The bot keeps running either way. */
function listenError(error: unknown, host: string, port: number): ArchivistError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const where = `${host}:${port}`;
  const message =
    code === "EADDRINUSE"
      ? `Something else is already using ${where}. Stop it, or set ARCHIVIST_PORT to a free port and restart the bot, then start the website again.`
      : code === "EACCES"
        ? `The bot is not allowed to listen on ${where}. Use a port above 1023, or set ARCHIVIST_HOST to an address it may use.`
        : code === "EADDRNOTAVAIL"
          ? `${host} is not an address of this machine. Set ARCHIVIST_HOST to 127.0.0.1, or to 0.0.0.0 in a container.`
          : `The website could not start on ${where}. The bot's log has the details.`;
  return new ArchivistError("dependency_unavailable", message, {
    reason: code === "EADDRINUSE" ? "port_in_use" : "listen_failed",
    host,
    port,
    cause: code ?? null,
  });
}
