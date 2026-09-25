import assert from "node:assert/strict";
import test from "node:test";
import { CLEAR_HISTORY_CONFIRMATION, isDeleteConfirmed } from "../src/clear-history-confirm.ts";

test("exactly DELETE confirms", () => {
  assert.equal(CLEAR_HISTORY_CONFIRMATION, "DELETE");
  assert.equal(isDeleteConfirmed("DELETE"), true);
});

test("near misses do not confirm", () => {
  for (const value of ["", "delete", "Delete", " DELETE", "DELETE ", "DEL", "DELETE\n"]) {
    assert.equal(isDeleteConfirmed(value), false, JSON.stringify(value));
  }
});
