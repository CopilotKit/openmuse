import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskStatus } from "../packages/domain/src/agent.ts";
import {
  dependenciesSatisfied,
  isDispatchable,
  selectRunnable,
  unmetDependencies,
} from "../packages/domain/src/scheduler.ts";

/** A candidate as the scheduler sees it; only the dispatchable fields matter here. */
const task = (id: string, status: TaskStatus = "queued") => ({ id, status });
const now = Date.parse("2026-10-04T12:00:00.000Z");

test("dispatchable covers queued, due scheduled, expired leases and approvals", () => {
  assert.equal(isDispatchable(task("a"), now), true);
  assert.equal(
    isDispatchable({ ...task("b", "scheduled"), nextRunAt: new Date(now - 1).toISOString() }, now),
    true,
  );
  assert.equal(
    isDispatchable(
      { ...task("c", "scheduled"), nextRunAt: new Date(now + 60_000).toISOString() },
      now,
    ),
    false,
  );
  // A live lease belongs to a worker that is still running it.
  assert.equal(
    isDispatchable(
      { ...task("d", "running"), leaseUntil: new Date(now + 60_000).toISOString() },
      now,
    ),
    false,
  );
  // An expired lease is the reclaim path for a worker that died mid-task.
  assert.equal(
    isDispatchable({ ...task("e", "running"), leaseUntil: new Date(now - 1).toISOString() }, now),
    true,
  );
  assert.equal(isDispatchable(task("f", "waiting_approval"), now), true);
  for (const status of ["succeeded", "failed", "cancelled", "paused", "waiting_input"] as const)
    assert.equal(isDispatchable(task("g", status), now), false, status);
});

test("a missing nextRunAt or leaseUntil reads as overdue, not as never", () => {
  // Date.parse("") is NaN, and NaN <= now is false, so an unset timestamp on a
  // scheduled or running task must not be treated as due. Guard the regression.
  assert.equal(isDispatchable({ ...task("a", "scheduled"), nextRunAt: null }, now), false);
  assert.equal(isDispatchable({ ...task("b", "running"), leaseUntil: null }, now), false);
});

test("a task is blocked until every prerequisite has closed", () => {
  const blocked = [{ id: "p1", status: "running" as TaskStatus }];
  assert.equal(dependenciesSatisfied(blocked), false);
  assert.deepEqual(unmetDependencies(blocked), ["p1"]);

  const settled = [
    { id: "p1", status: "succeeded" as TaskStatus },
    { id: "p2", status: "failed" as TaskStatus },
    { id: "p3", status: "cancelled" as TaskStatus },
  ];
  // A failed prerequisite still unblocks: it can never run again, and stalling
  // the dependent forever would be worse than letting it proceed.
  assert.equal(dependenciesSatisfied(settled), true);
  assert.deepEqual(unmetDependencies(settled), []);
});

test("a prerequisite that no longer exists is unmet, not silently satisfied", () => {
  const dangling = [{ id: "gone", status: undefined }];
  assert.equal(dependenciesSatisfied(dangling), false);
  assert.deepEqual(unmetDependencies(dangling), ["gone"]);
});

test("selectRunnable keeps unblocked work and holds back dependents", () => {
  const candidates = [task("independent"), task("dependent"), task("downstream")];
  const prerequisites = new Map<string, { id: string; status: TaskStatus | undefined }[]>([
    ["dependent", [{ id: "independent", status: "queued" }]],
    ["downstream", [{ id: "dependent", status: "queued" }]],
  ]);
  assert.deepEqual(
    selectRunnable(candidates, prerequisites, now).map((t) => t.id),
    ["independent"],
  );

  // Once the first task closes, only the direct dependent is released — the
  // downstream one still waits on it.
  prerequisites.set("independent", []);
  prerequisites.set("dependent", [{ id: "independent", status: "succeeded" }]);
  assert.deepEqual(
    selectRunnable(candidates, prerequisites, now).map((t) => t.id),
    ["independent", "dependent"],
  );

  prerequisites.set("dependent", [{ id: "independent", status: "succeeded" }]);
  prerequisites.set("downstream", [{ id: "dependent", status: "succeeded" }]);
  assert.deepEqual(
    selectRunnable(candidates, prerequisites, now).map((t) => t.id),
    ["independent", "dependent", "downstream"],
  );
});

test("a cycle left in the graph blocks every member rather than running them all", () => {
  // addDependency refuses cycles, but the scheduler must still not livelock or
  // dispatch a member if one is ever written by another path.
  const candidates = [task("x"), task("y")];
  const cycle = new Map<string, { id: string; status: TaskStatus | undefined }[]>([
    ["x", [{ id: "y", status: "queued" }]],
    ["y", [{ id: "x", status: "queued" }]],
  ]);
  assert.deepEqual(selectRunnable(candidates, cycle, now), []);
});
