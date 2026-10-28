import assert from "node:assert/strict";
import { test } from "node:test";
import { clipText } from "../apps/server/src/text.ts";

// The clip sites carry untrusted page and mail text into tool results, evidence
// and notifications. A UTF-16 cut can land between a surrogate pair's halves;
// the lone half that survives is not a character (it renders as U+FFFD and
// breaks consumers that encode the value to UTF-8).
test("keeps a short string unchanged", () => {
  assert.equal(clipText("hello", 10), "hello");
  assert.equal(clipText("hello", 5), "hello");
});

test("clips a BMP string at the limit", () => {
  assert.equal(clipText("hello world", 5), "hello");
});

test("does not split an astral character at the cut", () => {
  // U+1F44D (thumbs up) is the surrogate pair D83D DC4D in UTF-16.
  const text = "a".repeat(239) + "\u{1F44D}".repeat(3);
  const clipped = clipText(text, 240);
  assert.equal(clipped.length, 239);
  assert.ok(!/[\uD800-\uDBFF]$/.test(clipped), "must not end on a lone high surrogate");
  assert.ok(clipped.endsWith("a"));
});

test("keeps a pair that fits before the limit", () => {
  const text = "ab\u{1F44D}cd";
  assert.equal(clipText(text, 4), "ab\u{1F44D}");
});

test("clips exactly at a pair boundary without dropping a character", () => {
  const text = "\u{1F44D}\u{1F44E}";
  assert.equal(clipText(text, 2), "\u{1F44D}");
  assert.equal(clipText(text, 4), "\u{1F44D}\u{1F44E}");
});

test("does not trim when the string is exactly the limit", () => {
  const text = "\u{1F44D}".repeat(6); // 12 UTF-16 units
  assert.equal(clipText(text, 12), text);
});
