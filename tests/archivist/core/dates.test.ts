import assert from "node:assert/strict";
import { test } from "node:test";
import {
  archiveDay,
  calendarDay,
  dayText,
  isTimeZone,
  localText,
  needsZoneConfirmation,
  parseDateInput,
  parseDayInput,
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

test("typed dates are read in many common forms", () => {
  const forms = [
    "2019-07-15",
    "2019/7/15",
    "2019.07.15",
    "20190715",
    "Jul 15 2019",
    "jul 15, 2019",
    "July 15th, 2019",
    "15 July 2019",
    "15th of July 2019",
    "july, 2019, 15",
    "Monday, July 15, 2019",
    "2019 jul 15",
    "Sept. 15 2019",
  ];
  for (const form of forms) {
    const expected = form.toLowerCase().startsWith("sept") ? "2019-09-15" : "2019-07-15";
    assert.equal(parseDayInput("day", form), expected, form);
  }
  assert.equal(parseDayInput("day", "jun 14 2026"), "2026-06-14");
  assert.equal(parseDayInput("day", "june, 2026, 19"), "2026-06-19");
});

test("all-number dates follow the contributor's date order, defaulting to year first", () => {
  assert.equal(parseDayInput("day", "2019-03-04", "dmy"), "2019-03-04");
  assert.equal(parseDayInput("day", "03/04/2019", "mdy"), "2019-03-04");
  assert.equal(parseDayInput("day", "03/04/2019", "dmy"), "2019-04-03");
  // Year-first readers get the only real reading, and are asked when both are real.
  assert.equal(parseDayInput("day", "15/07/2019"), "2019-07-15");
  assert.equal(parseDayInput("day", "07/15/2019"), "2019-07-15");
  assert.equal(parseDayInput("day", "07/07/2019"), "2019-07-07");
  assert.throws(() => parseDayInput("day", "03/04/2019"), rejects());
  assert.throws(() => parseDayInput("day", "15/07/2019", "mdy"), rejects());
});

test("unclear or partial dates are refused with a reason", () => {
  for (const text of [
    "June 2026",
    "June 14",
    "03/04/19",
    "14 June 26",
    "June July 2026",
    "someday 2026",
    "",
    "2019-02-29",
  ]) {
    assert.throws(() => parseDayInput("day", text), rejects(), text);
  }
  assert.throws(() => parseDayInput("day", "Jul 15 2019 6pm"), rejects());
});

test("12-hour and 24-hour times are read, with an optional zone after them", () => {
  const instant = (text: string) => {
    const value = parseDateInput("date", text, TORONTO);
    assert.equal(value.kind, "instant", text);
    return value.kind === "instant" ? value : null;
  };
  const evening = Date.UTC(2019, 6, 15, 22, 30);
  assert.equal(instant("Jul 15 2019 6:30pm")?.instantMs, evening);
  assert.equal(instant("Jul 15 2019 6:30 p.m.")?.instantMs, evening);
  assert.equal(instant("July 15, 2019 at 18:30")?.instantMs, evening);
  assert.equal(instant("15 July 2019 6:30 PM")?.instantMs, evening);
  assert.equal(instant("2019-07-15 12am")?.instantMs, Date.UTC(2019, 6, 15, 4));
  assert.equal(instant("2019-07-15 12pm")?.instantMs, Date.UTC(2019, 6, 15, 16));
  assert.equal(instant("Jul 15 2019 6pm UTC")?.instantMs, Date.UTC(2019, 6, 15, 18));
  assert.equal(instant("Jul 15 2019 6pm Europe/London")?.timezone, "Europe/London");
  assert.equal(instant("Jul 15 2019 18:30 -04:00")?.timezone, "-04:00");
  assert.throws(() => parseDateInput("date", "2019-07-15 13pm", TORONTO), rejects());
  assert.throws(() => parseDateInput("date", "2019-07-15 6:75pm", TORONTO), rejects());
});

test("only a time without its own zone needs the reader to confirm it", () => {
  assert.equal(needsZoneConfirmation("Jul 15 2019 6:30pm"), true);
  assert.equal(needsZoneConfirmation("2019-07-15 18:30"), true);
  assert.equal(needsZoneConfirmation("Jul 15 2019 6:30pm -04:00"), false);
  assert.equal(needsZoneConfirmation("Jul 15 2019"), false);
  assert.equal(needsZoneConfirmation("not a date"), false);
  assert.equal(needsZoneConfirmation("03/04/2019 18:30", "dmy"), true);
});

test("dates are shown with the month's name", () => {
  assert.equal(dayText("2019-07-05"), "Jul 5, 2019");
  assert.equal(localText("2019-12-31T23:59:00"), "Dec 31, 2019, 23:59");
});
