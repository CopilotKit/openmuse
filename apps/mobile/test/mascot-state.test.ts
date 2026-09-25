import assert from "node:assert/strict";
import test from "node:test";
import {
  getMascotSnapshot,
  MASCOT_STATUSES,
  mascotLabel,
  setMascotSource,
} from "../src/mascot-state.ts";

test("MASCOT_STATUSES covers every mascot state with a label and animation", () => {
  const states = [
    "idle",
    "listening",
    "thinking",
    "searching",
    "reading",
    "pdf_review",
    "writing",
    "coding",
    "uploading",
    "dispatching",
    "delegating",
    "awaiting_approval",
    "restarting_browser",
    "clearing_history",
    "success",
    "error",
  ] as const;
  for (const state of states) {
    const info = MASCOT_STATUSES[state];
    assert.ok(info, `missing registry entry for ${state}`);
    assert.ok(info.label.length > 0, `empty label for ${state}`);
    assert.ok(info.animation.length > 0, `empty animation for ${state}`);
  }
  assert.equal(MASCOT_STATUSES.dispatching.label, "Dispatching team");
  assert.equal(MASCOT_STATUSES.delegating.label, "Delegating work");
  assert.equal(MASCOT_STATUSES.awaiting_approval.label, "Waiting for approval");
  assert.equal(MASCOT_STATUSES.restarting_browser.label, "Restarting browser");
  assert.equal(MASCOT_STATUSES.clearing_history.label, "Clearing history");
});

test("mascotLabel resolves display text", () => {
  assert.equal(mascotLabel("idle"), "Ready");
  assert.equal(mascotLabel("coding"), "Coding");
  assert.equal(mascotLabel("awaiting_approval"), "Waiting for approval");
});

test("highest-priority active source wins; idle clears a source", () => {
  setMascotSource("chat", "thinking");
  assert.equal(getMascotSnapshot(), "thinking");
  setMascotSource("agent", "dispatching");
  // dispatching outranks thinking in the priority list
  assert.equal(getMascotSnapshot(), "dispatching");
  setMascotSource("maintenance", "awaiting_approval");
  // awaiting_approval outranks dispatching
  assert.equal(getMascotSnapshot(), "awaiting_approval");
  setMascotSource("maintenance", "idle");
  assert.equal(getMascotSnapshot(), "dispatching");
  setMascotSource("agent", "idle");
  assert.equal(getMascotSnapshot(), "thinking");
  setMascotSource("chat", "idle");
  assert.equal(getMascotSnapshot(), "idle");
});

test("pdf_review participates in priority ordering", () => {
  setMascotSource("chat", "pdf_review");
  setMascotSource("terminal", "thinking");
  // reading-family states outrank thinking
  assert.equal(getMascotSnapshot(), "pdf_review");
  setMascotSource("chat", "idle");
  setMascotSource("terminal", "idle");
  assert.equal(getMascotSnapshot(), "idle");
});
