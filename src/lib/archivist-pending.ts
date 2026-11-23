import { randomBytes } from "node:crypto";
import { ArchivistError } from "../archivist/errors.js";

/**
 * Pending Discord confirmations and reviews, such as "unregister this
 * archive?" or a duplicate review. Each is bound to the person who started
 * it and expires after 15 minutes. They live in memory, so a bot restart
 * cancels them without touching saved archive data.
 */

export const PENDING_LIFETIME_MS = 15 * 60_000;

interface Pending {
  userId: string;
  expiresAt: number;
  data: unknown;
}

const pending = new Map<string, Pending>();

function sweep(now: number): void {
  for (const [token, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(token);
  }
}

/** Stores data for a later button or menu, returning the token to put in its custom ID. */
export function remember(userId: string, data: unknown): string {
  const now = Date.now();
  sweep(now);
  const token = randomBytes(12).toString("base64url");
  pending.set(token, { userId, expiresAt: now + PENDING_LIFETIME_MS, data });
  return token;
}

/**
 * Returns the data for a token if it belongs to `userId` and has not expired.
 * With `consume`, the token can not be used again.
 */
export function recall<T>(token: string, userId: string, consume = true): T {
  const now = Date.now();
  const entry = pending.get(token);
  if (!entry || entry.expiresAt <= now) {
    pending.delete(token);
    throw new ArchivistError(
      "invalid_input",
      "This form has expired or was already used. Run the command again.",
      { reason: "expired" },
    );
  }
  if (entry.userId !== userId) {
    throw new ArchivistError("forbidden", "Only the person who started this can use it.");
  }
  if (consume) pending.delete(token);
  return entry.data as T;
}
