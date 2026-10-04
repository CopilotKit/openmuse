import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceStatusLine, visibleError } from "../src/device-work-copy.ts";

/**
 * The wording on the device-work card.
 *
 * Pure functions, and the only part of the card a test can reach. Kept out of the
 * component for the same reason as `board-model.ts`: wording that is only ever
 * visible on a device is wording nobody reviews.
 */

const idle = {
  phase: "idle",
  enabled: false,
  task: null,
  unpaired: false,
  completed: 0,
  error: "",
};

test("an unpaired device is pointed at the code field, not told to wait", () => {
  // Pairing outranks every other state: it is the one thing that unblocks the
  // card, so it must be the line shown even while the loop is otherwise idle.
  assert.match(deviceStatusLine({ ...idle, unpaired: true }), /enter the code/i);
  assert.match(
    deviceStatusLine({ ...idle, unpaired: true, enabled: true, phase: "waiting" }),
    /enter the code/i,
  );
  // It must NOT also claim to be working: an unpaired device cannot claim, so
  // showing a task title here would be a lie about what this device is doing.
  assert.doesNotMatch(
    deviceStatusLine({ ...idle, unpaired: true, task: { id: "t1", title: "Anything" } }),
    /working on/i,
  );
});

test("the card names the task in hand", () => {
  assert.equal(
    deviceStatusLine({
      ...idle,
      enabled: true,
      phase: "running",
      task: { id: "t1", title: "File the receipts" },
    }),
    "Working on File the receipts",
  );
});

test("an off device says so plainly instead of implying it is waiting", () => {
  assert.match(deviceStatusLine(idle), /^Off\./);
});

test("a running device without a task in hand is finishing up", () => {
  // Reachable in the window between reporting and clearing the active run; it
  // should not read as "waiting for work" while work is still being closed out.
  assert.match(deviceStatusLine({ ...idle, enabled: true, phase: "running" }), /finishing up/i);
  assert.match(
    deviceStatusLine({ ...idle, enabled: true, phase: "claiming" }),
    /looking for work/i,
  );
  assert.match(deviceStatusLine({ ...idle, enabled: true, phase: "waiting" }), /waiting for work/i);
});

test("an empty queue is not surfaced as an error", () => {
  // `no-eligible-work` arrives several times an hour. Showing it would train the
  // user to ignore the card, which is how a real notice stops being read.
  assert.equal(visibleError("no-eligible-work"), "");
  assert.equal(visibleError("No eligible work"), "");
  assert.equal(visibleError(""), "");
});

test("a real notice is surfaced", () => {
  assert.equal(
    visibleError("This task moved to another device."),
    "This task moved to another device.",
  );
  assert.equal(
    visibleError("Lost contact with your workspace; still holding the task."),
    "Lost contact with your workspace; still holding the task.",
  );
});
