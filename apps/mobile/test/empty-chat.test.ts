import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_CHAT_HEADING,
  EMPTY_CHAT_NO_SHORTCUTS_HINT,
  EMPTY_CHAT_SUBTITLE,
  emptyChatButtons,
} from "../src/empty-chat.ts";

test("empty chat keeps the product tagline heading", () => {
  assert.equal(EMPTY_CHAT_HEADING, "A little help. A lot more room for life.");
});

test("subtitle drops the stock examples and points to Settings", () => {
  assert.match(EMPTY_CHAT_SUBTITLE, /Settings/);
  assert.doesNotMatch(EMPTY_CHAT_SUBTITLE, /Hacker News/);
  assert.doesNotMatch(EMPTY_CHAT_SUBTITLE, /copilotkit/i);
});

test("shortcuts map to buttons labelled with the user text", () => {
  const buttons = emptyChatButtons([
    { id: "sc-1", label: "Morning briefing", instruction: "Summarize my inbox" },
    { id: "sc-2", label: "Plan my day", instruction: "What is on my calendar today?" },
  ]);
  assert.deepEqual(buttons, [
    { key: "sc-1", label: "Morning briefing", instruction: "Summarize my inbox" },
    { key: "sc-2", label: "Plan my day", instruction: "What is on my calendar today?" },
  ]);
});

test("no shortcuts yields no buttons and a hint pointing to Settings", () => {
  assert.deepEqual(emptyChatButtons([]), []);
  assert.match(EMPTY_CHAT_NO_SHORTCUTS_HINT, /Settings/);
});
