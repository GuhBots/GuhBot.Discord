import assert from "node:assert/strict";
import { test } from "node:test";
import {
  archiveDay,
  calendarDay,
  isTimeZone,
  parseDateInput,
  timeZoneName,
} from "../../../src/archivist/dates.js";
import { ArchivistError } from "../../../src/archivist/errors.js";

const TORONTO = "America/Toronto";

function rejects(reason?: string) {
  return (error: unknown) =>
    error instanceof ArchivistError &&
    error.code === "invalid_input" &&
    (reason === undefined || error.details.reason === reason);
}

test("calendar days must be real dates", () => {
  assert.equal(calendarDay("day", "2020-02-29"), "2020-02-29");
  assert.throws(() => calendarDay("day", "2019-02-29"), rejects());
  assert.throws(() => calendarDay("day", "2019-13-01"), rejects());
  assert.throws(() => calendarDay("day", "15/07/2019"), rejects());
});

test("a date-only input stays a calendar day", () => {
  assert.deepEqual(parseDateInput("date", "2019-07-15", TORONTO), {
    kind: "day",
    originalText: "2019-07-15",
    calendarDay: "2019-07-15",
  });
});

test("a time without a zone uses the default timezone", () => {
  const value = parseDateInput("date", "2019-07-15 13:45", TORONTO);
  assert.equal(value.kind, "instant");
  assert.equal(value.kind === "instant" && value.instantMs, Date.UTC(2019, 6, 15, 17, 45));
  assert.equal(value.kind === "instant" && value.timezone, TORONTO);
});

test("an explicit offset or zone wins over the default", () => {
  const offset = parseDateInput("date", "2019-07-15T13:45:10+05:30", TORONTO);
  assert.equal(offset.kind === "instant" && offset.instantMs, Date.UTC(2019, 6, 15, 8, 15, 10));
  assert.equal(offset.kind === "instant" && offset.timezone, "+05:30");

  const utc = parseDateInput("date", "2019-07-15 13:45Z", TORONTO);
  assert.equal(utc.kind === "instant" && utc.instantMs, Date.UTC(2019, 6, 15, 13, 45));

  const named = parseDateInput("date", "2019-07-15 13:45 Europe/London", TORONTO);
  assert.equal(named.kind === "instant" && named.instantMs, Date.UTC(2019, 6, 15, 12, 45));
  assert.equal(named.kind === "instant" && named.timezone, "Europe/London");
});

test("a skipped daylight-saving time asks for a correction", () => {
  assert.throws(
    () => parseDateInput("date", "2019-03-10 02:30", TORONTO),
    rejects("nonexistent_time"),
  );
});

test("a repeated daylight-saving time asks for an offset", () => {
  assert.throws(
    () => parseDateInput("date", "2019-11-03 01:30", TORONTO),
    (error: unknown) =>
      rejects("ambiguous_time")(error) &&
      JSON.stringify((error as ArchivistError).details.offsets) === '["-04:00","-05:00"]',
  );
  const chosen = parseDateInput("date", "2019-11-03 01:30 -05:00", TORONTO);
  assert.equal(chosen.kind === "instant" && chosen.instantMs, Date.UTC(2019, 10, 3, 6, 30));
});

test("invalid timezones and times are rejected", () => {
  assert.throws(() => parseDateInput("date", "2019-07-15 13:45 Mars/Base", TORONTO), rejects());
  assert.throws(() => parseDateInput("date", "2019-07-15 24:00", TORONTO), rejects());
  assert.throws(() => parseDateInput("date", "July 15", TORONTO), rejects());
  assert.equal(isTimeZone("+05:00"), false);
  assert.equal(timeZoneName("timezone", "america/toronto"), TORONTO);
  assert.throws(() => timeZoneName("timezone", "EST5EDT nonsense"), rejects());
});

test("date-only values keep their day in every archive timezone", () => {
  const day = parseDateInput("date", "2019-07-15", TORONTO);
  assert.equal(archiveDay(day, "Pacific/Kiritimati"), "2019-07-15");
  assert.equal(archiveDay(day, "Pacific/Pago_Pago"), "2019-07-15");
});

test("instants fall on the archive timezone's day", () => {
  const late = parseDateInput("date", "2019-07-16 02:00Z", TORONTO);
  assert.equal(archiveDay(late, TORONTO), "2019-07-15");
  assert.equal(archiveDay(late, "Asia/Tokyo"), "2019-07-16");
});
