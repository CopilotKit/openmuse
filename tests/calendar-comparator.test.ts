import assert from "node:assert/strict";
import { test } from "node:test";
import { compareEventStart, type EventStartLike } from "../packages/domain/src/date-time.ts";

function permutations<T>(values: T[]): T[][] {
  if (values.length === 0) return [[]];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, i) => i !== index)).map((rest) => [value, ...rest]),
  );
}

test("mixed invalid dates cannot reorder valid instants across input permutations", () => {
  const later = { start: "2026-10-10T09:00:00-07:00" };
  const invalid = { start: "2026-10-10T12:bad" };
  const earlier = { start: "2026-10-10T14:00:00+00:00" };
  for (const input of permutations([later, invalid, earlier])) {
    assert.deepEqual([...input].sort(compareEventStart), [earlier, later, invalid]);
  }
});

test("event start ordering is antisymmetric and transitive across valid and invalid groups", () => {
  const values: EventStartLike[] = [
    { start: "2026-10-10T09:00:00-07:00" },
    { start: "2026-10-10T12:bad" },
    { start: "2026-10-10T14:00:00+00:00" },
    { start: "", allDay: true },
    { start: "2026-10-10", allDay: true, timeZone: "Pacific/Auckland" },
    { start: "2026-10-10", allDay: true, timeZone: "invalid-zone" },
    { start: "not a date" },
  ];
  const sign = (value: number) => (value < 0 ? -1 : value > 0 ? 1 : 0);
  for (const a of values) {
    assert.equal(compareEventStart(a, a), 0);
    for (const b of values) {
      assert.equal(sign(compareEventStart(a, b)) + sign(compareEventStart(b, a)), 0);
      for (const c of values) {
        if (compareEventStart(a, b) <= 0 && compareEventStart(b, c) <= 0) {
          assert.ok(compareEventStart(a, c) <= 0);
        }
      }
    }
  }
});

test("invalid starts retain a deterministic text order after valid events", () => {
  const valid = { start: "2026-10-10T14:00:00Z" };
  const invalid = [{ start: "!invalid" }, { start: "" }, { start: "garbage" }];
  const expected = [valid, ...[...invalid].sort((a, b) => a.start.localeCompare(b.start))];
  for (const input of permutations([valid, ...invalid])) {
    assert.deepEqual([...input].sort(compareEventStart), expected);
  }
});
