import assert from "node:assert/strict";
import test from "node:test";
import { relativeDate } from "../src/relative-date.ts";

const now = Date.parse("2026-09-30T12:00:00Z");

test("recent past timestamps keep their buckets", () => {
  assert.equal(relativeDate("2026-09-30T11:59:30Z", now), "Just now");
  assert.equal(relativeDate("2026-09-30T11:30:00Z", now), "30m ago");
  assert.equal(relativeDate("2026-09-30T09:00:00Z", now), "3h ago");
});

test("future timestamps beyond clock skew show a date instead of just now", () => {
  assert.equal(relativeDate("2026-09-30T12:00:10Z", now), "Just now");
  const expected = new Date(Date.parse("2026-10-05T12:00:00Z")).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  assert.equal(relativeDate("2026-10-05T12:00:00Z", now), expected);
});

test("an unparseable timestamp is returned unchanged", () => {
  assert.equal(relativeDate("not-a-date", now), "not-a-date");
});
