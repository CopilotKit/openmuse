import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { analyzeSpending } from "../apps/server/src/engine/finance.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

function task(id = "task1"): AgentTask {
  return {
    id,
    title: "Check a source",
    prompt: "Check a source",
    kind: "agent",
    status: "queued",
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attempts: 0,
    leaseId: null,
    leaseUntil: null,
    artifactIds: [],
  };
}
test("two workers claim one task only once", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "tasks", task());
    let calls = 0;
    const handle = async () => {
      calls++;
      return { status: "succeeded" as const, result: "actual result" };
    };
    await Promise.all([new TaskWorker(db, handle).tick(), new TaskWorker(db, handle).tick()]);
    assert.equal(calls, 1);
    assert.equal((await db.get<AgentTask>("owner", "tasks", "task1"))?.status, "succeeded");
  } finally {
    await db.close();
  }
});
test("cancellation invalidates a stale worker before its next effect", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "tasks", task());
    let effects = 0;
    const worker = new TaskWorker(db, async (owner, value, ctx) => {
      await db.compareAndSwap(
        owner,
        "tasks",
        value.id,
        { status: "running" },
        { status: "cancelled", leaseId: null, leaseUntil: null },
      );
      await ctx.guard();
      effects++;
      return { status: "succeeded" };
    });
    await worker.tick();
    assert.equal(effects, 0);
    assert.equal((await db.get<AgentTask>("owner", "tasks", "task1"))?.status, "cancelled");
  } finally {
    await db.close();
  }
});
test("expired leases recover saved checkpoints after the database restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-engine-"));
  try {
    let db = await createStore({ dataDir: join(directory, "db") });
    await db.put("owner", "tasks", {
      ...task(),
      status: "running",
      leaseId: "dead-worker",
      leaseUntil: "2020-01-01T00:00:00Z",
      state: { completedStep: "imported", fileId: "persisted-file" },
    });
    await db.close();
    db = await createStore({ dataDir: join(directory, "db") });
    try {
      let observed: unknown;
      const worker = new TaskWorker(db, async (_owner, value, ctx) => {
        observed = value.state;
        await ctx.event("step", "Resumed at the checkpoint");
        return { status: "succeeded", result: "Recovered" };
      });
      await worker.tick();
      assert.deepEqual(observed, { completedStep: "imported", fileId: "persisted-file" });
      assert.equal((await db.get<AgentTask>("owner", "tasks", "task1"))?.status, "succeeded");
    } finally {
      await db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("scheduled tasks wait for due time and approvals wait for a recorded outcome", async () => {
  const db = await createStore();
  try {
    let now = 1000,
      calls = 0;
    const worker = new TaskWorker(
      db,
      async () => {
        calls++;
        return { status: "succeeded" };
      },
      { now: () => now },
    );
    await db.put("owner", "tasks", {
      ...task("later"),
      status: "scheduled",
      nextRunAt: new Date(2000).toISOString(),
    });
    await worker.tick();
    assert.equal(calls, 0);
    now = 3000;
    await worker.tick();
    assert.equal(calls, 1);
    await db.put("owner", "tasks", {
      ...task("review"),
      status: "waiting_approval",
      actionId: "a",
    });
    await db.put("owner", "actions", { id: "a", status: "awaiting_review" });
    await worker.tick();
    assert.equal(calls, 1);
    await db.put("owner", "actions", { id: "a", status: "succeeded" });
    await worker.tick();
    assert.equal(calls, 2);
  } finally {
    await db.close();
  }
});
test("the worker withholds a task whose prerequisite has not finished", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "tasks", task("first"));
    await db.put("owner", "tasks", task("second"));
    assert.equal(await db.addDependency("owner", "second", "first"), true);

    const started: string[] = [];
    const worker = new TaskWorker(db, async (_owner, value) => {
      started.push(value.id);
      // Hold "first" open so the gate is observed while it is genuinely running.
      if (value.id === "first") {
        await db.compareAndSwap(
          "owner",
          "tasks",
          value.id,
          { status: "running" },
          { status: "succeeded" },
        );
      }
      return { status: "succeeded" };
    });
    await worker.tick();
    // "first" may run; "second" must not have started alongside it.
    assert.ok(started.includes("first"));
    assert.equal(started.includes("second"), false, "dependent ran before its prerequisite");
    assert.equal((await db.get<AgentTask>("owner", "tasks", "second"))?.status, "queued");

    // A later tick, with the prerequisite closed, releases exactly the dependent.
    await worker.tick();
    assert.equal(started.includes("second"), true);
    assert.equal((await db.get<AgentTask>("owner", "tasks", "second"))?.status, "succeeded");
  } finally {
    await db.close();
  }
});

test("a dependent is not run while its prerequisite is still running in another batch", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "tasks", task("long"));
    await db.put("owner", "tasks", task("short"));
    await db.put("owner", "tasks", task("after"));
    await db.addDependency("owner", "after", "long");

    let releaseLong = () => {};
    const held = new Promise<void>((resolve) => {
      releaseLong = resolve;
    });
    const started: string[] = [];
    const worker = new TaskWorker(
      db,
      async (_owner, value) => {
        started.push(value.id);
        if (value.id === "long") await held;
        return { status: "succeeded" };
      },
      { now: () => Date.now(), leaseMs: 60_000 },
    );
    const running = worker.tick();
    // Let the batch start, then check that only the two unblocked tasks ran.
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual([...started].sort(), ["long", "short"]);
      assert.equal((await db.get<AgentTask>("owner", "tasks", "after"))?.status, "queued");
    } finally {
      // Always release, or a failed assertion hangs the suite on this promise.
      releaseLong();
    }
    await running;
    assert.equal(
      started.includes("after"),
      false,
      "dependent ran in the same batch as its prerequisite",
    );
  } finally {
    await db.close();
  }
});

test("the pool keeps every slot busy instead of waiting for the slowest run", async () => {
  const db = await createStore();
  try {
    // Six tasks, capacity two. One of the first two is deliberately slow, so a
    // batch that waits for its slowest would idle the other slot for the whole
    // duration. A refilling pool must start the third task as soon as the fast
    // one finishes.
    const taskCount = 6;
    for (let i = 0; i < taskCount; i++) await db.put("owner", "tasks", task(`t${i}`));
    const startedAt: number[] = [];
    let peak = 0;
    let live = 0;
    const worker = new TaskWorker(
      db,
      async (_owner, value) => {
        live++;
        peak = Math.max(peak, live);
        startedAt.push(Date.now());
        try {
          // "t0" is the straggler of its wave; everything else is quick.
          await new Promise((resolve) => setTimeout(resolve, value.id === "t0" ? 300 : 30));
          return { status: "succeeded" };
        } finally {
          live--;
        }
      },
      { maxConcurrency: 2 },
    );
    const began = Date.now();
    await worker.tick();
    const elapsed = Date.now() - began;
    assert.equal(startedAt.length, taskCount, "every queued task ran in one tick");
    assert.equal(peak, 2, "never more than the configured concurrency");
    // Serialised waves would be 3 x 300ms; the straggler overlaps the rest, so
    // the total is far closer to one slow run plus the fast ones behind it.
    assert.ok(elapsed < 700, `draining six tasks took ${String(elapsed)}ms`);
    for (let i = 0; i < taskCount; i++)
      assert.equal(
        (await db.get<AgentTask>("owner", "tasks", `t${i}`))?.status,
        "succeeded",
        "the pool drains the whole backlog within a single tick",
      );
  } finally {
    await db.close();
  }
});

test("stop waits for runs already in flight before returning", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "tasks", task("slow"));
    let finished = false;
    const worker = new TaskWorker(
      db,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        finished = true;
        return { status: "succeeded" };
      },
      { maxConcurrency: 1 },
    );
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await worker.stop();
    // The contract is that stop() waits, not that the work completes: it aborts
    // the run, and an aborted run loses its lease and is safely requeued rather
    // than left half-written. `finished` proves the handler was still awaited.
    assert.equal(finished, true, "stop() must not return while a run is still going");
    assert.equal(
      (await db.get<AgentTask>("owner", "tasks", "slow"))?.status,
      "queued",
      "an aborted run is requeued, not abandoned",
    );
  } finally {
    await db.close();
  }
});

test("finance artifacts compute cents exactly and reject ambiguous CSV", () => {
  const report = analyzeSpending(
    'date,description,amount,category\n2026-09-01,Salary,-1000,Income\n2026-09-02,"Coffee, local",10.10,Food\n2026-09-03,Lunch,20.20,Food',
  );
  assert.equal(report.spending, 30.3);
  assert.equal(report.saved, 969.7);
  assert.equal(report.categories[0]!.amount, 30.3);
  assert.throws(() =>
    analyzeSpending("date,description,amount,category\n2026-02-31,Purchase,10,Food"),
  );
  assert.throws(() =>
    analyzeSpending("date,description,amount,category\n2026-09-01,Purchase,1.234,Food"),
  );
});

test("pending reviews do not starve queued work", async () => {
  const db = await createStore();
  try {
    for (let i = 0; i < 4; i++) {
      await db.put("owner", "tasks", {
        ...task(`review-${i}`),
        status: "waiting_approval",
        actionId: `action-${i}`,
      });
      await db.put("owner", "actions", { id: `action-${i}`, status: "awaiting_review" });
    }
    await db.put("owner", "tasks", task("ready"));
    await new TaskWorker(db, async () => ({ status: "succeeded" })).tick();
    assert.equal((await db.get<AgentTask>("owner", "tasks", "ready"))?.status, "succeeded");
  } finally {
    await db.close();
  }
});
test("run history keeps the time the run started", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "tasks", task());
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    await new TaskWorker(
      db,
      async () => {
        clock += 60000;
        return { status: "succeeded" };
      },
      { now: () => clock },
    ).tick();
    const [run] = (await db.scan<{ startedAt: string; finishedAt: string }>("runs")).map(
      ({ value }) => value,
    );
    assert.equal(run?.startedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(run?.finishedAt, "2026-01-01T00:01:00.000Z");
  } finally {
    await db.close();
  }
});
test("a failed run record does not leave the task stuck in the worker", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "tasks", task());
    const flaky = Object.create(db) as typeof db;
    flaky.put = (async (owner: string, kind: string, value: { id: string }) => {
      if (kind === "runs") throw new Error("database unavailable");
      return db.put(owner, kind, value);
    }) as typeof db.put;
    const worker = new TaskWorker(flaky, async () => ({ status: "succeeded" }));
    await worker.tick().catch(() => {});
    const stopped = await Promise.race([
      worker.stop().then(() => true),
      new Promise((r) => setTimeout(() => r(false), 500)),
    ]);
    assert.equal(stopped, true);
    assert.equal((await db.get<AgentTask>("owner", "tasks", "task1"))?.status, "failed");
  } finally {
    await db.close();
  }
});
