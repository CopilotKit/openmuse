import assert from "node:assert/strict";
import { test } from "node:test";
import { t } from "../src/strings.ts";

test("t returns the Chinese text for a known key", () => {
  assert.equal(t("justNow"), "刚刚");
});

test("t fills placeholders", () => {
  assert.equal(t("minutesAgo", { n: 5 }), "5 分钟前");
});

test("t leaves unknown placeholders alone", () => {
  assert.equal(t("minutesAgo", { other: 1 }), "{n} 分钟前");
});

test("t falls back to the key itself when unknown", () => {
  assert.equal(t("no.such.key"), "no.such.key");
});
