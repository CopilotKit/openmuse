import assert from "node:assert/strict";
import test from "node:test";
import { WEB_SCROLLBAR_CSS } from "../src/web-scrollbar-css.ts";

test("scrollbar css styles a slim website-like thumb", () => {
  assert.match(WEB_SCROLLBAR_CSS, /scrollbar-width:\s*thin/);
  assert.match(WEB_SCROLLBAR_CSS, /::-webkit-scrollbar/);
  assert.match(WEB_SCROLLBAR_CSS, /::-webkit-scrollbar-thumb/);
  assert.match(WEB_SCROLLBAR_CSS, /border-radius/);
});

test("scrollbar css never hides scroll indicators", () => {
  assert.doesNotMatch(WEB_SCROLLBAR_CSS, /scrollbar-width:\s*none/);
  assert.doesNotMatch(WEB_SCROLLBAR_CSS, /display:\s*none/);
  assert.doesNotMatch(WEB_SCROLLBAR_CSS, /visibility:\s*hidden/);
  assert.doesNotMatch(WEB_SCROLLBAR_CSS, /overflow:\s*hidden/);
});

test("scrollbar thumb is always visible on desktop pointers", () => {
  // The thumb must never fade to transparent until hover: always-visible.
  assert.doesNotMatch(WEB_SCROLLBAR_CSS, /scrollbar-thumb\{background-color:\s*transparent/);
  assert.doesNotMatch(WEB_SCROLLBAR_CSS, /@media\s*\(hover:\s*hover\)/);
  assert.match(
    WEB_SCROLLBAR_CSS,
    /::-webkit-scrollbar-thumb\{background-color:rgba\(60,60,67,\.32\)/,
  );
});
