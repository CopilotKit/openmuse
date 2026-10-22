import assert from "node:assert/strict";
import test from "node:test";
import { relativeDate } from "../src/relative-date.ts";

const now = Date.parse("2026-09-30T12:00:00Z");

test("recent past timestamps keep their buckets", () => {
  assert.equal(relativeDate("2026-09-30T11:59:30Z", now), "刚刚");
  assert.equal(relativeDate("2026-09-30T11:30:00Z", now), "30 分钟前");
  assert.equal(relativeDate("2026-09-30T09:00:00Z", now), "3 小时前");
});

test("future timestamps beyond clock skew show a date instead of just now", () => {
  assert.equal(relativeDate("2026-09-30T12:00:10Z", now), "刚刚");
  const expected = new Date(Date.parse("2026-10-05T12:00:00Z")).toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
  });
  assert.equal(relativeDate("2026-10-05T12:00:00Z", now), expected);
});

test("an unparseable timestamp is returned unchanged", () => {
  assert.equal(relativeDate("not-a-date", now), "not-a-date");
});
