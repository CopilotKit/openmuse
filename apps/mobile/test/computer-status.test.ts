import assert from "node:assert/strict";
import test from "node:test";
import { computerStatus } from "../src/computer-status.ts";

test("the computer status says offline before anything else", () => {
  assert.equal(computerStatus(false, 0), "offline");
  assert.equal(computerStatus(false, 2), "offline");
  assert.equal(computerStatus(true, 0), "ready");
  assert.equal(computerStatus(true, 1), "take control");
});
