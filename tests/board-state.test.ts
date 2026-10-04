import assert from "node:assert/strict";
import test from "node:test";
import {
  BOARD_STATES,
  canBoardTransition,
  checkBoardTransition,
  computeEffectiveBoardState,
  isBoardClosed,
  isBoardState,
  isBoardTerminal,
  validBoardTransitionsFor,
} from "../packages/domain/src/index.ts";

test("every board state is recognised and nothing else is", () => {
  assert.equal(BOARD_STATES.length, 6);
  for (const state of BOARD_STATES) assert.equal(isBoardState(state), true);
  assert.equal(isBoardState("inprogress"), false);
  assert.equal(isBoardState("queued"), false);
  assert.equal(isBoardState(undefined), false);
});

test("transitions that are not in the table are rejected", () => {
  // The point of the table: Backlog cannot jump straight to Done.
  assert.equal(canBoardTransition("Backlog", "InProgress"), true);
  assert.equal(canBoardTransition("Backlog", "Done"), false);
  assert.equal(canBoardTransition("InProgress", "Review"), true);
  assert.equal(canBoardTransition("Review", "InProgress"), true);
  assert.equal(canBoardTransition("Blocked", "Backlog"), true);
});

test("Done and Cancelled are terminal, so finished work is never re-opened", () => {
  assert.equal(isBoardTerminal("Done"), true);
  assert.equal(isBoardTerminal("Cancelled"), true);
  assert.equal(isBoardTerminal("InProgress"), false);
  assert.deepEqual(validBoardTransitionsFor("Done"), []);
  assert.deepEqual(validBoardTransitionsFor("Cancelled"), []);
  assert.equal(isBoardClosed("Done"), true);
  assert.equal(isBoardClosed("Review"), false);
});

test("a task can be cancelled from any non-terminal state", () => {
  for (const state of BOARD_STATES) {
    if (isBoardTerminal(state)) continue;
    assert.equal(canBoardTransition(state, "Cancelled"), true, `expected ${state} -> Cancelled`);
  }
});

test("valid transitions expose exactly the legal next actions for the UI", () => {
  assert.deepEqual(validBoardTransitionsFor("Backlog"), ["InProgress", "Cancelled"]);
  assert.deepEqual(validBoardTransitionsFor("InProgress"), ["Review", "Blocked", "Cancelled"]);
  assert.deepEqual(validBoardTransitionsFor("Blocked"), ["Backlog", "Cancelled"]);
  assert.deepEqual(validBoardTransitionsFor("Review"), ["Done", "InProgress", "Cancelled"]);
});

test("checkTransition carries the legal alternatives so the API can answer in one round-trip", () => {
  const ok = checkBoardTransition("InProgress", "Review");
  assert.equal(ok.ok, true);
  const rejected = checkBoardTransition("Backlog", "Done");
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.equal(rejected.currentState, "Backlog");
  assert.equal(rejected.attemptedTransition, "Done");
  assert.deepEqual(rejected.allowedTransitions, ["InProgress", "Cancelled"]);
  assert.match(rejected.message, /Invalid transition/);
});

test("a terminal task is reported as needing a new task, not a transition", () => {
  const rejected = checkBoardTransition("Done", "InProgress");
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.match(rejected.message, /terminal state Done/);
  assert.match(rejected.message, /create a new task/);
});

test("a failed validation gate forces InProgress whatever was requested", () => {
  // The gate is binary, not advisory: it cannot be outvoted by the requested state.
  assert.equal(computeEffectiveBoardState("Done", false), "InProgress");
  assert.equal(computeEffectiveBoardState("Blocked", false), "InProgress");
  assert.equal(computeEffectiveBoardState("Done", true), "Done");
  assert.equal(computeEffectiveBoardState("Done", undefined), "Done");
});
