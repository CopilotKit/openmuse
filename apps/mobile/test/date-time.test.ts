import assert from "node:assert/strict";
import test from "node:test";
import {
  isCompleteInstant,
  localDateTime,
  startOfZonedDay,
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

test("a day boundary clamps to the first existing local time instead of failing", () => {
  // America/Santiago springs forward 00:00→01:00 on 2026-09-06.
  assert.equal(startOfZonedDay("2026-09-06", "America/Santiago"), "2026-09-06T04:00:00.000Z");
  // Ordinary days still start exactly at midnight (Santiago is UTC-3 after the transition).
  assert.equal(startOfZonedDay("2026-09-07", "America/Santiago"), "2026-09-07T03:00:00.000Z");
  assert.equal(startOfZonedDay("2026-09-15", "UTC"), "2026-09-15T00:00:00.000Z");
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
