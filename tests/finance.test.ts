import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeSpending } from "../apps/server/src/engine/finance.ts";

test("transaction imports reject characters after a closing CSV quote", () => {
  for (const amount of ['"10"0', '""10', '"10".00', '"10" ']) {
    assert.throws(
      () => analyzeSpending(`date,description,amount,category\n2026-09-01,Coffee,${amount},Food`),
      /Invalid quoted CSV field/,
      `must not silently interpret ${amount} as a transaction amount`,
    );
  }
  assert.throws(
    () => analyzeSpending('date,description,amount,category\n2026-09-01,"Coffee"shop,10,Food'),
    /Invalid quoted CSV field/,
  );
});

test("transaction imports preserve valid quoted fields at CSV boundaries", () => {
  for (const ending of ["", "\n", "\r\n", "\r"]) {
    const report = analyzeSpending(
      '"date","description","amount","category"\r\n' +
        '"2026-09-01","Coffee, ""local""\nshop","10.10","Food"\r\n' +
        `"2026-09-02","","20.20",""${ending}`,
    );
    assert.equal(report.count, 2);
    assert.equal(report.spending, 30.3);
    assert.equal(report.transactions[0].description, 'Coffee, "local"\nshop');
    assert.equal(report.transactions[1].description, "");
    assert.equal(report.transactions[1].category, "Uncategorized");
  }
});
