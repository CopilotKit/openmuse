import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countPageDiff,
  describePageDiff,
  diffPage,
  meaningfulPageDiff,
  pageLines,
} from "../apps/server/src/engine/page-diff.ts";

test("page lines are trimmed, collapsed, deduplicated and bounded", () => {
  assert.deepEqual(pageLines("  Jobs \n\n Siemens   AI\r\nSiemens AI\n"), ["Jobs", "Siemens AI"]);
  assert.equal(pageLines("a\nb\nc", 2).length, 2);
  assert.equal(pageLines("x".repeat(500))[0].length, 300);
});

test("new lines are separated from lines where a number changed", () => {
  const before = [
    "AI jobs in Munich",
    "Siemens · Werkstudent AI · 2 openings · posted 1 day ago",
    "BCG · Intern",
  ];
  const after = [
    "AI jobs in Munich",
    "SAP · Working Student AI Engineer",
    "Siemens · Werkstudent AI · 3 openings · posted 2 days ago",
  ];
  assert.deepEqual(diffPage(before, after), {
    added: ["SAP · Working Student AI Engineer"],
    updated: ["Siemens · Werkstudent AI · 3 openings · posted 2 days ago"],
    removed: ["BCG · Intern"],
  });
  assert.deepEqual(diffPage(before, before), { added: [], updated: [], removed: [] });
});

test("price, stock, count and version changes are meaningful updates", () => {
  for (const [before, after] of [
    ["Price: $399.99", "Price: $279.99"],
    ["Only 3 left", "Only 0 left"],
    ["Tickets available: 12", "Tickets available: 0"],
    ["Latest release 1.2.3", "Latest release 2.0.0"],
    ["1 comment", "2 comments"],
  ]) {
    const diff = diffPage(["Shop", before], ["Shop", after]);
    assert.deepEqual(diff, { added: [], updated: [after], removed: [] }, before);
    assert.equal(meaningfulPageDiff(diff), true, before);
  }
});

test("the change summary lists sections, clips long lists, and counts lines", () => {
  const diff = {
    added: Array.from({ length: 10 }, (_, i) => `Role ${i}`),
    updated: ["Price $12"],
    removed: [],
  };
  const text = describePageDiff(diff);
  assert.match(text, /^New:\n• Role 0\n/);
  assert.match(text, /\+2 more\nUpdated:\n• Price \$12$/);
  assert.doesNotMatch(text, /Removed/);
  assert.equal(countPageDiff(diff), "11 lines changed (10 new, 1 updated)");
  assert.equal(countPageDiff({ added: ["a"], updated: [], removed: [] }), "1 line changed (1 new)");
  assert.equal(describePageDiff({ added: [], updated: [], removed: [] }), "");
  assert.equal(countPageDiff({ added: [], updated: [], removed: [] }), "");
});

test("lines where only a relative time changed are left out and are not meaningful", () => {
  const before = [
    "3 points by ada 58 minutes ago | hide",
    "Vor 2 Stunden veröffentlicht",
    "Show HN: A new tool",
  ];
  const after = [
    "3 points by ada 1 hour ago | hide",
    "Vor einer Stunde veröffentlicht",
    "Show HN: A new tool",
  ];
  const timesOnly = diffPage(before, after);
  assert.deepEqual(timesOnly, { added: [], updated: [], removed: [] });
  assert.equal(meaningfulPageDiff(timesOnly), false);
  assert.deepEqual(diffPage(before, ["4 points by ada 1 hour ago | hide", ...after.slice(1)]), {
    added: [],
    updated: ["4 points by ada 1 hour ago | hide"],
    removed: [],
  });
  assert.equal(meaningfulPageDiff(diffPage(before, [...after, "Ask HN: Another post"])), true);
  assert.equal(meaningfulPageDiff(diffPage(before, after.slice(0, 2))), true);
});
