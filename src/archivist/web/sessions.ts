import { createHash, randomBytes } from "node:crypto";
import type { ArchivistContext } from "../context.js";

/**
 * Website sessions and sign-in states in the bot's operational database.
 * Only a SHA-256 hash of each token is stored, so a copy of the database
 * cannot be used to sign in. Sessions last seven days from sign-in and are
 * never extended. Discord sign-in alone grants no archive access: every
 * archive request checks the current whitelist.
 */

export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60_000;
/** A sign-in started in the browser must come back from Discord within this time. */
export const AUTH_STATE_LIFETIME_MS = 10 * 60_000;
/** Owner status is asked again after this long, so a change applies within five minutes. */
export const OWNER_RECHECK_MS = 5 * 60_000;

export interface Session {
  tokenHash: string;
  userId: string;
  createdMs: number;
  expiresMs: number;
  ownerCheckedMs: number | null;
  isOwner: boolean;
  displayName: string | null;
  avatarUrl: string | null;
}

interface SessionRow {
  token_hash: string;
  discord_user_id: string;
  created_ms: number;
  expires_ms: number;
  owner_checked_ms: number | null;
  is_owner: number;
  display_name: string | null;
  avatar_url: string | null;
}

/** An unpredictable token for a cookie or a sign-in state. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function nowMs(context: ArchivistContext): number {
  return context.now().getTime();
}

/** Removes expired sessions and sign-in states. */
export function purgeExpired(context: ArchivistContext): void {
  const now = nowMs(context);
  context.botDb.prepare("DELETE FROM archivist_sessions WHERE expires_ms <= ?").run(now);
  context.botDb.prepare("DELETE FROM archivist_auth_states WHERE expires_ms <= ?").run(now);
}

/** Starts a sign-in. The returned state goes to Discord and comes back once. */
export function createAuthState(context: ArchivistContext): string {
  purgeExpired(context);
  const state = newToken();
  context.botDb
    .prepare("INSERT INTO archivist_auth_states (token_hash, expires_ms) VALUES (?, ?)")
    .run(hashToken(state), nowMs(context) + AUTH_STATE_LIFETIME_MS);
  return state;
}

/** Uses up a sign-in state. False when it is unknown, used already, or expired. */
export function consumeAuthState(context: ArchivistContext, state: string): boolean {
  const hash = hashToken(state);
  const row = context.botDb
    .prepare("DELETE FROM archivist_auth_states WHERE token_hash = ? RETURNING expires_ms")
    .get(hash) as { expires_ms: number } | undefined;
  return row !== undefined && row.expires_ms > nowMs(context);
}

export interface NewSession {
  userId: string;
  isOwner: boolean;
  displayName: string | null;
  avatarUrl: string | null;
}

/** Creates a session and returns its token, which only the browser's cookie holds. */
export function createSession(context: ArchivistContext, input: NewSession): string {
  purgeExpired(context);
  const token = newToken();
  const now = nowMs(context);
  context.botDb
    .prepare(
      `INSERT INTO archivist_sessions (token_hash, discord_user_id, created_ms, expires_ms, owner_checked_ms, is_owner, display_name, avatar_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      hashToken(token),
      input.userId,
      now,
      now + SESSION_LIFETIME_MS,
      now,
      input.isOwner ? 1 : 0,
      input.displayName,
      input.avatarUrl,
    );
  return token;
}

/** The session behind a token, or null when it is unknown or expired. */
export function readSession(context: ArchivistContext, token: string): Session | null {
  const row = context.botDb
    .prepare("SELECT * FROM archivist_sessions WHERE token_hash = ?")
    .get(hashToken(token)) as SessionRow | undefined;
  if (!row) return null;
  if (row.expires_ms <= nowMs(context)) {
    context.botDb
      .prepare("DELETE FROM archivist_sessions WHERE token_hash = ?")
      .run(row.token_hash);
    return null;
  }
  return {
    tokenHash: row.token_hash,
    userId: row.discord_user_id,
    createdMs: row.created_ms,
    expiresMs: row.expires_ms,
    ownerCheckedMs: row.owner_checked_ms,
    isOwner: row.is_owner === 1,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  };
}

/** Whether the session's owner status is old enough to ask Discord again. */
export function ownerCheckDue(context: ArchivistContext, session: Session): boolean {
  return (
    session.ownerCheckedMs === null || nowMs(context) - session.ownerCheckedMs >= OWNER_RECHECK_MS
  );
}

export function recordOwnerCheck(
  context: ArchivistContext,
  session: Session,
  isOwner: boolean,
): Session {
  const now = nowMs(context);
  context.botDb
    .prepare(
      "UPDATE archivist_sessions SET is_owner = ?, owner_checked_ms = ? WHERE token_hash = ?",
    )
    .run(isOwner ? 1 : 0, now, session.tokenHash);
  return { ...session, isOwner, ownerCheckedMs: now };
}

/** Ends a session. Unknown tokens are ignored, so signing out twice is harmless. */
export function deleteSession(context: ArchivistContext, token: string): void {
  context.botDb
    .prepare("DELETE FROM archivist_sessions WHERE token_hash = ?")
    .run(hashToken(token));
}
