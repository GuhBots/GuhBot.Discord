/**
 * Errors that Archivist operations report to their callers. The Discord and
 * web adapters turn each code into their own reply, so every rule that can
 * fail reports the same code from either interface.
 */

/** Every error code, with the HTTP status the web adapter uses for it. */
export const ERROR_STATUS = {
  invalid_input: 400,
  no_session: 401,
  forbidden: 403,
  archive_not_found: 404,
  not_found: 404,
  stale_version: 409,
  reference_blocked: 409,
  name_taken: 409,
  unsupported_schema: 409,
  media_too_large: 413,
  unsupported_media_type: 415,
  upstream_rate_limited: 429,
  dependency_unavailable: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/**
 * An expected failure with a stable code and a message safe to show users.
 * Messages and details never include credentials or filesystem paths.
 */
export class ArchivistError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ArchivistError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }

  /** The `{code, message, details}` body the web adapter returns. */
  toJSON(): { code: ErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}
