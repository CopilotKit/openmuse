import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarInterval,
  calendarOverlap,
  isCompleteInstant,
  localDateTime,
  zonedInstant,
} from "../src/date-time.ts";

test("calendar time is rendered and entered in the selected named zone", () => {
  assert.deepEqual(localDateTime("2026-09-15T17:30:00Z", "America/Los_Angeles"), {
    date: "2026-09-15",
    time: "10:30",
  });
  assert.equal(
    zonedInstant("2026-09-15", "10:30", "America/Los_Angeles"),
    "2026-09-15T17:30:00.000Z",
  );
});
test("a zone crossing the UTC date boundary preserves the selected day", () => {
  assert.equal(zonedInstant("2026-09-15", "08:00", "Asia/Tokyo"), "2026-09-14T23:00:00.000Z");
});
test("invalid calendar dates and out-of-range times do not normalize silently", () => {
  assert.throws(() => zonedInstant("2026-02-31", "09:00", "UTC"));
  assert.throws(() => zonedInstant("2026-09-15", "25:00", "UTC"));
});
test("a daylight-saving gap cannot become a different appointment time", () => {
  assert.throws(() => zonedInstant("2026-03-08", "02:30", "America/Los_Angeles"), /does not exist/);
  assert.equal(
    zonedInstant("2026-03-08", "03:30", "America/Los_Angeles"),
    "2026-03-08T10:30:00.000Z",
  );
});

test("partial native date edits never normalize from Date.parse", () => {
  for (const value of [
    "2026-09-1 09:00",
    "2026-09-15 09:0",
    "2026-09-15 09:00",
    "2026-09-15T09:00",
  ])
    assert.equal(isCompleteInstant(value), false);
  assert.equal(isCompleteInstant("2026-09-15T17:30:00.000Z"), true);
  assert.equal(isCompleteInstant("2026-09-15T10:30:00-07:00"), true);
});

const allDay = (start: string, end: string, timeZone = "America/Los_Angeles") => ({
  start,
  end,
  allDay: true,
  timeZone,
});
const timed = (start: string, end: string, timeZone = "America/Los_Angeles") => ({
  start,
  end,
  allDay: false,
  timeZone,
});

test("an all-day event covers its date in its own time zone, not UTC", () => {
  assert.deepEqual(calendarInterval(allDay("2026-09-30", "2026-10-01")), {
    start: Date.parse("2026-09-30T00:00:00-07:00"),
    end: Date.parse("2026-10-01T00:00:00-07:00"),
  });
  const tokyo = calendarInterval(allDay("2026-09-30", "2026-10-01", "Asia/Tokyo"));
  assert.deepEqual(tokyo, {
    start: Date.parse("2026-09-30T00:00:00+09:00"),
    end: Date.parse("2026-10-01T00:00:00+09:00"),
  });
});

test("a timed evening event overlaps the all-day event on the same local day", () => {
  assert.equal(
    calendarOverlap(
      timed("2026-09-30T20:00:00-07:00", "2026-09-30T21:00:00-07:00"),
      allDay("2026-09-30", "2026-10-01"),
    ),
    true,
  );
  assert.equal(
    calendarOverlap(
      timed("2026-09-29T22:00:00-07:00", "2026-09-29T23:00:00-07:00"),
      allDay("2026-09-30", "2026-10-01"),
    ),
    false,
  );
});

test("all-day overlap follows the calendar's zone across the UTC date boundary", () => {
  assert.equal(
    calendarOverlap(
      allDay("2026-09-30", "2026-10-01", "Asia/Tokyo"),
      timed("2026-09-29T23:00:00Z", "2026-09-30T00:00:00Z", "UTC"),
    ),
    true,
  );
});

test("events that only touch at a boundary do not conflict", () => {
  assert.equal(
    calendarOverlap(
      allDay("2026-09-30", "2026-10-01"),
      timed("2026-10-01T00:00:00-07:00", "2026-10-01T01:00:00-07:00"),
    ),
    false,
  );
});

test("unparseable ranges never report a conflict", () => {
  assert.equal(calendarInterval(allDay("not-a-date", "2026-10-01")), null);
  assert.equal(calendarInterval(allDay("2026-09-30", "2026-10-01", "Not/AZone")), null);
  assert.equal(
    calendarOverlap(allDay("garbage", "garbage"), allDay("2026-09-30", "2026-10-01")),
    false,
  );
});
