import assert from "node:assert/strict";
import { test } from "node:test";
import { applyChange, changeKey, foldChanges, type SyncChange } from "../src/sync.ts";

const put = (seq: number, recordId: string, data: Record<string, unknown>): SyncChange => ({
  seq,
  kind: "tasks",
  recordId,
  op: "put",
  data,
  at: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
});
const del = (seq: number, recordId: string): SyncChange => ({
  seq,
  kind: "tasks",
  recordId,
  op: "delete",
  at: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
});

test("a put carries the whole record and a delete removes it", () => {
  assert.deepEqual(applyChange(put(1, "a", { title: "one" })), { title: "one" });
  assert.equal(applyChange(del(2, "a")), null);
});

test("changeKey namespaces by kind so ids cannot collide across collections", () => {
  assert.notEqual(changeKey(put(1, "x", {})), changeKey({ ...put(1, "x", {}), kind: "notes" }));
});

test("folding an empty page keeps the contents but returns a fresh object", () => {
  // A new object even with nothing to apply: device caches are React state, and
  // returning the same reference would skip a render when the pull found no news.
  const before = { "tasks:a": { title: "one" } };
  const after = foldChanges(before, []);
  assert.deepEqual(after, before);
  assert.notEqual(after, before);
});

test("a later change to the same record wins, by log order", () => {
  // Same record written twice. The fold is by seq, not by the `at` timestamp, so
  // a device cannot win by claiming a later time.
  const folded = foldChanges({}, [
    put(1, "a", { title: "first" }),
    put(2, "a", { title: "second" }),
  ]);
  assert.deepEqual(folded["tasks:a"], { title: "second" });
});

test("out-of-order timestamps do not change the outcome", () => {
  // The second change carries an EARLIER timestamp but a LATER seq. Log order
  // wins; wall-clock time is not consulted.
  const folded = foldChanges({}, [
    { ...put(1, "a", { title: "first" }), at: "2026-10-04T12:00:00.000Z" },
    { ...put(2, "a", { title: "second" }), at: "2020-01-01T00:00:00.000Z" },
  ]);
  assert.deepEqual(folded["tasks:a"], { title: "second" });
});

test("a put replaces rather than merges, so cleared fields stay cleared", () => {
  // The failure this prevents: merging would leave `secret` in place after a
  // newer write removed it, leaking it to every device forever.
  const folded = foldChanges({}, [
    put(1, "a", { title: "one", secret: "hunter2" }),
    put(2, "a", { title: "one (edited)" }),
  ]);
  assert.deepEqual(folded["tasks:a"], { title: "one (edited)" });
  assert.equal("secret" in (folded["tasks:a"] ?? {}), false);
});

test("a delete after a put removes the record entirely", () => {
  const folded = foldChanges({}, [put(1, "a", { title: "one" }), del(2, "a")]);
  assert.equal(folded["tasks:a"], undefined);
});

test("a put after a delete resurrects the record", () => {
  const folded = foldChanges({}, [del(1, "a"), put(2, "a", { title: "back" })]);
  assert.deepEqual(folded["tasks:a"], { title: "back" });
});

test("folding does not mutate the projection it was given", () => {
  // Device caches are React state; mutating in place would skip re-renders and
  // make a stale projection impossible to reason about.
  const before = { "tasks:a": { title: "one" } };
  const after = foldChanges(before, [put(1, "a", { title: "two" })]);
  assert.deepEqual(before["tasks:a"], { title: "one" });
  assert.notEqual(after, before);
});

test("folding the whole log from zero reaches the same state as a partial pull", () => {
  // This is the property that makes device state disposable: a device that lost
  // its cache and rebuilt from 0 must land where an incrementally-synced device is.
  const log = [
    put(1, "a", { title: "one" }),
    put(2, "b", { title: "two" }),
    put(3, "a", { title: "one revised" }),
    del(4, "b"),
    put(5, "c", { title: "three" }),
  ];
  const rebuilt = foldChanges({}, log);
  // Pull in two pages instead of one.
  const paged = foldChanges(foldChanges({}, log.slice(0, 2)), log.slice(2));
  assert.deepEqual(rebuilt, paged);
  assert.deepEqual(Object.keys(rebuilt).sort(), ["tasks:a", "tasks:c"]);
});

test("changes for one kind do not disturb another", () => {
  const folded = foldChanges({}, [
    { ...put(1, "shared-id", { title: "task" }), kind: "tasks" },
    { ...put(2, "shared-id", { body: "note" }), kind: "notes" },
  ]);
  assert.deepEqual(folded["tasks:shared-id"], { title: "task" });
  assert.deepEqual(folded["notes:shared-id"], { body: "note" });
});
