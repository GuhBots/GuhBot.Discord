import { ArchivistError } from "./errors.js";

/** Validates the version a contributor last saw. */
export function expectedVersionValue(value: unknown): number {
  const version = typeof value === "string" ? Number(value) : value;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new ArchivistError("invalid_input", "expectedVersion must be a positive whole number.", {
      field: "expectedVersion",
    });
  }
  return version;
}

/**
 * Reports that someone else changed a record since the contributor loaded
 * it. The details carry the current version and the current values of the
 * fields the contributor tried to change, so they can review and choose again.
 */
export function staleVersion(
  record: string,
  id: string,
  currentVersion: number,
  current: Record<string, unknown>,
): ArchivistError {
  return new ArchivistError(
    "stale_version",
    "Someone else changed this since you loaded it. Review the current values and try again.",
    { record, id, currentVersion, current },
  );
}
