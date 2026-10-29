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

test("transaction imports accept a UTF-8 byte order mark before the header", () => {
  for (const header of [
    "date,description,amount,category",
    '"date","description","amount","category"',
  ]) {
    const report = analyzeSpending(`\uFEFF${header}\n2026-09-01,Coffee,10.10,Food`);
    assert.equal(report.count, 1);
    assert.equal(report.spending, 10.1);
  }
});

test("transaction imports accept CR, LF and CRLF record separators", () => {
  for (const newline of ["\r", "\n", "\r\n"]) {
    const report = analyzeSpending(
      [
        '"date","description","amount","category"',
        '2026-09-01,"Coffee, local",10.10,Food',
        '2026-09-02,"Salary",-100.00,Income',
        "",
      ].join(newline),
    );
    assert.equal(report.count, 2);
    assert.equal(report.spending, 10.1);
    assert.equal(report.income, 100);
    assert.equal(report.transactions[0].description, "Coffee, local");
  }
});

test("CR record separators do not split quoted multiline transaction text", () => {
  const report = analyzeSpending(
    'date,description,amount,category\r2026-09-01,"Coffee\rshop\r\nreceipt",10,Food\r',
  );
  assert.equal(report.count, 1);
  assert.equal(report.transactions[0].description, "Coffee\rshop\r\nreceipt");
  assert.equal(report.spending, 10);
  assert.throws(
    () => analyzeSpending('date,description,amount,category\r2026-09-01,"Coffee"shop,10,Food'),
    /Invalid quoted CSV field/,
  );
});
