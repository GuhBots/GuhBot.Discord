/**
 * Archivist failures as the bot reports them. The service answers errors as
 * `{code, message, details}` with these codes, and the bot raises the same
 * error for its own input checks, so every reply reads the same way.
 */

export const ERROR_CODES = [
  "invalid_input",
  "no_session",
  "forbidden",
  "archive_not_found",
  "not_found",
  "stale_version",
  "reference_blocked",
  "name_taken",
  "unsupported_schema",
  "media_too_large",
  "unsupported_media_type",
  "upstream_rate_limited",
  "dependency_unavailable",
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return ERROR_CODES.includes(value as ErrorCode);
}

/** An expected failure with a stable code and a message safe to show the contributor. */
export class ArchivistError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  /** The service's HTTP status, when the error came from the service. */
  readonly status: number | null;

  constructor(
    code: ErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    status: number | null = null,
  ) {
    super(message);
    this.name = "ArchivistError";
    this.code = code;
    this.details = details;
    this.status = status;
  }
}
