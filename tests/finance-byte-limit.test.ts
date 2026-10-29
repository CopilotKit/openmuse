import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSpending } from "../apps/server/src/engine/finance.ts";

const header = "date,description,amount,category\n2026-09-01,";
const suffix = ",10,Food";

test("transaction CSV size limits count UTF-8 bytes rather than UTF-16 units", () => {
  const csv = `${header}${"中".repeat(167000)}${suffix}`;
  assert.ok(csv.length < 500000);
  assert.ok(Buffer.byteLength(csv) > 500000);
  assert.throws(() => analyzeSpending(csv), /at most 500 KB/);
});

test("transaction CSV byte limit accepts the exact boundary for ASCII and Unicode", () => {
  const available = 500000 - Buffer.byteLength(header + suffix);
  for (const character of ["x", "中", "😀"]) {
    const width = Buffer.byteLength(character);
    const description =
      character.repeat(Math.floor(available / width)) + "x".repeat(available % width);
    const csv = `${header}${description}${suffix}`;
    assert.equal(Buffer.byteLength(csv), 500000);
    const report = analyzeSpending(csv);
    assert.equal(report.count, 1);
    assert.equal(report.spending, 10);
    assert.equal(report.transactions[0].description, description);
    assert.throws(() => analyzeSpending(`${csv}\n`), /at most 500 KB/);
  }
});
