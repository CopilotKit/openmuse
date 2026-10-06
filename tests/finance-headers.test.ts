import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSpending } from "../apps/server/src/engine/finance.ts";

test("duplicate required CSV headers do not silently discard financial values", () => {
  for (const column of ["date", "description", "amount", "category"]) {
    assert.throws(
      () =>
        analyzeSpending(
          `date,description,amount,category,${column}\n2026-09-01,Purchase,10,Food,1000`,
        ),
      /duplicate.*column/i,
    );
  }
});
test("header uniqueness is checked after the same normalization used for lookup", () => {
  assert.throws(
    () =>
      analyzeSpending(
        "date,description,amount,category, Amount \n2026-09-01,Purchase,10,Food,1000",
      ),
    /duplicate.*column/i,
  );
});
test("distinct reordered and extra CSV columns still work", () => {
  const report = analyzeSpending(
    "note,category,amount,description,date\nIgnored,Food,10,Purchase,2026-09-01",
  );
  assert.equal(report.spending, 10);
  assert.equal(report.count, 1);
  assert.equal(report.transactions[0].description, "Purchase");
});

test("duplicate irrelevant CSV columns remain accepted", () => {
  const report = analyzeSpending(
    "note,date,description,amount,category,note\nFirst,2026-09-01,Purchase,10,Food,Second",
  );
  assert.equal(report.spending, 10);
  assert.equal(report.count, 1);
});
