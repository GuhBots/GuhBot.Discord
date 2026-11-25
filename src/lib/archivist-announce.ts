import { AttachmentBuilder, type Client, DiscordAPIError } from "discord.js";
import { type ArchivistApi, archivistApi } from "./archivist-api.js";
import { artifactEmbed, PREVIEW_ATTACHMENT } from "./archivist-format.js";
import type { AnnouncementItem } from "./archivist-types.js";

/**
 * Upload announcements. The Archivist service queues a post for every new
 * artifact in an archive with a logs channel, whether it came from Discord
 * or the website. The bot claims posts, sends each one, and reports how it
 * went under the claim's ID. A post whose outcome is unknown, such as a
 * timeout after sending, is reported as indeterminate and never sent again,
 * because it may already be in the channel.
 */

/** What happened to an artifact's announcement, for the contributor's reply. */
export type AnnouncementOutcome =
  | { status: "not_configured" | "sent" | "queued" | "already_handled" }
  | { status: "failed" | "indeterminate"; reason: string };

type Result =
  { state: "sent"; messageId: string } | { state: "failed" | "indeterminate"; reason: string };

/** Claims are handed out in batches of at most this many. */
const CLAIM_BATCH = 10;

function resultPath(item: AnnouncementItem): string {
  return `/api/service/announcements/${encodeURIComponent(item.archiveId)}/${encodeURIComponent(item.artifactId)}/result`;
}

/** Sends one claimed post. Discord failures become a result rather than an error. */
async function deliver(
  client: Client<true>,
  item: AnnouncementItem,
  api: ArchivistApi,
): Promise<Result> {
  let target;
  try {
    target = await client.channels.fetch(item.channel.channelId);
  } catch {
    return {
      state: "failed",
      reason: "The announcement channel no longer exists or the bot cannot see it.",
    };
  }
  if (!target?.isSendable() || target.isDMBased()) {
    return { state: "failed", reason: "The bot cannot post in the announcement channel." };
  }
  let preview: AttachmentBuilder | null = null;
  if (item.previewPath) {
    // A missing preview is not worth losing the post over.
    preview = await api
      .bytes(null, item.previewPath)
      .then((bytes) => new AttachmentBuilder(bytes, { name: PREVIEW_ATTACHMENT }))
      .catch(() => null);
  }
  const embed = artifactEmbed(item.artifact, {
    archiveName: item.archiveName,
    archiveTimeZone: item.archiveTimeZone,
    characterNames: item.characterNames,
    hasPreviewAttachment: preview !== null,
    addedBy: item.artifact.createdBy,
  });
  try {
    const message = await target.send({
      embeds: [embed],
      files: preview ? [preview] : [],
      allowedMentions: { parse: [] },
    });
    return { state: "sent", messageId: message.id };
  } catch (error) {
    // Discord refused the request, so nothing was posted. Anything else, such
    // as a timeout, may have posted, so it is never retried.
    if (error instanceof DiscordAPIError && error.status < 500) {
      return { state: "failed", reason: `Discord refused the post (${error.code}).` };
    }
    return {
      state: "indeterminate",
      reason: "The post may or may not have gone through, so it was not repeated.",
    };
  }
}

/** Sends a claimed post and reports its result to Archivist. */
export async function postAnnouncement(
  client: Client<true>,
  item: AnnouncementItem,
  api: ArchivistApi = archivistApi(),
): Promise<AnnouncementOutcome> {
  const result = await deliver(client, item, api);
  try {
    await api.service("POST", resultPath(item), { claimId: item.claimId, ...result });
  } catch (error) {
    // The service settles an unreported claim as indeterminate after its lease.
    console.error("Archivist: could not report an announcement's result:", error);
  }
  return result.state === "sent"
    ? { status: "sent" }
    : { status: result.state, reason: result.reason };
}

/** Claims queued posts, optionally only one artifact's, and sends each one. */
export async function claimAndPost(
  client: Client<true>,
  scope: { archiveId?: string; artifactId?: string } = {},
  api: ArchivistApi = archivistApi(),
): Promise<{ item: AnnouncementItem; outcome: AnnouncementOutcome }[]> {
  const { items } = await api.service<{ items: AnnouncementItem[] }>(
    "POST",
    "/api/service/announcements/claim",
    { ...scope, limit: CLAIM_BATCH },
  );
  const outcomes: { item: AnnouncementItem; outcome: AnnouncementOutcome }[] = [];
  for (const item of items) {
    outcomes.push({ item, outcome: await postAnnouncement(client, item, api) });
  }
  return outcomes;
}

/**
 * Posts a just-saved artifact's announcement right away, so the reply can
 * say whether it went out. When the poller got to it first, or Archivist
 * cannot be reached, the post stays queued and goes out shortly.
 */
export async function announceNow(
  client: Client<true>,
  archiveId: string,
  artifactId: string,
  status: string,
): Promise<AnnouncementOutcome> {
  if (status === "not_configured") return { status: "not_configured" };
  if (status !== "queued") return { status: "already_handled" };
  try {
    const [first] = await claimAndPost(client, { archiveId, artifactId });
    return first?.outcome ?? { status: "queued" };
  } catch {
    return { status: "queued" };
  }
}

/** A line for the contributor's reply when the announcement did not go out. */
export function announcementNote(outcome: AnnouncementOutcome): string | null {
  if (outcome.status === "failed" || outcome.status === "indeterminate") {
    return `Saved, but not announced. ${outcome.reason}`;
  }
  if (outcome.status === "queued") return "It will be announced in the logs channel shortly.";
  return null;
}

/* Polling */

/** How often the queue is checked. */
export const POLL_INTERVAL_MS = 10_000;

export interface Poller {
  /** Runs one round now, unless one is already running. */
  tick(): Promise<void>;
  stop(): void;
}

/** Calls `round` every `intervalMs`, never twice at once, logging the first failure of a streak. */
export function startPoller(
  round: () => Promise<unknown>,
  intervalMs = POLL_INTERVAL_MS,
  log: (message: string, error: unknown) => void = (message, error) =>
    console.error(message, error),
): Poller {
  let running = false;
  let failing = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await round();
      if (failing) console.log("Archivist announcements: the queue answers again.");
      failing = false;
    } catch (error) {
      if (!failing) log("Archivist announcements: could not check the queue:", error);
      failing = true;
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
