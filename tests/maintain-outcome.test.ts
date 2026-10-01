import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AgentService } from "../apps/server/src/engine/service.ts";
import type { AgentNotification, AgentTask } from "../packages/domain/src/agent.ts";

function task(id: string, status: AgentTask["status"], extra: Partial<AgentTask> = {}): AgentTask {
  return {
    id,
    title: `Task ${id}`,
    prompt: `Task ${id}`,
    kind: "agent",
    status,
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attempts: status === "failed" ? 3 : 1,
    error: status === "failed" ? "simulated failure" : null,
    leaseId: null,
    leaseUntil: null,
    artifactIds: [],
    ...extra,
  };
}

function serviceWith(db: Store) {
  const service = new AgentService(
    db,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return service as unknown as { maintain(): Promise<void> };
}

async function notifications(db: Store): Promise<AgentNotification[]> {
  return (await db.scan<AgentNotification>("notifications")).map(({ value }) => value);
}

test("maintenance recovers a lost publication once, then skips the marked row", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "tasks", task("task1", "succeeded", { result: "done" }));
    const service = serviceWith(db);

    await service.maintain();
    assert.equal((await notifications(db)).filter((n) => n.taskId === "task1").length, 1);
    assert.equal(
      (await db.get<AgentTask>("owner", "tasks", "task1"))?.state.publishedOutcome,
      "task-done:task1",
    );

    let taskGets = 0;
    const originalGet = db.get.bind(db);
    db.get = (async (owner: string, kind: string, id: string) => {
      if (kind === "tasks") taskGets++;
      return originalGet(owner, kind, id);
    }) as Store["get"];
    await service.maintain();
    db.get = originalGet;
    assert.equal(taskGets, 0);
    assert.equal((await notifications(db)).filter((n) => n.taskId === "task1").length, 1);
  } finally {
    await db.close();
  }
});

test("outcome marker preserves a concurrent sibling state write", async () => {
  const db = await createStore();
  try {
    await db.put(
      "owner",
      "tasks",
      task("task1", "succeeded", { result: "done", state: { existing: "value" } }),
    );
    const service = serviceWith(db);
    const originalInsert = db.insertIfAbsent.bind(db);
    let injected = false;
    db.insertIfAbsent = (async (owner: string, kind: string, value: { id: string }) => {
      if (kind === "notifications" && !injected) {
        injected = true;
        const latest = await db.get<AgentTask>("owner", "tasks", "task1");
        assert.ok(latest);
        await db.compareAndSwap(
          "owner",
          "tasks",
          "task1",
          { status: "succeeded" },
          { state: { ...latest.state, concurrent: "kept" } },
        );
      }
      return originalInsert(owner, kind, value);
    }) as Store["insertIfAbsent"];

    await service.maintain();
    const saved = await db.get<AgentTask>("owner", "tasks", "task1");
    assert.equal(saved?.state.existing, "value");
    assert.equal(saved?.state.concurrent, "kept");
    assert.equal(saved?.state.publishedOutcome, "task-done:task1");
  } finally {
    await db.close();
  }
});

test("a same-status outcome change is not hidden by a stale marker", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "tasks", task("task1", "waiting_input", { question: "Old question?" }));
    const service = serviceWith(db);
    const originalInsert = db.insertIfAbsent.bind(db);
    let changed = false;
    db.insertIfAbsent = (async (owner: string, kind: string, value: { id: string }) => {
      if (kind === "notifications" && !changed) {
        changed = true;
        await db.compareAndSwap(
          "owner",
          "tasks",
          "task1",
          { status: "waiting_input", question: "Old question?" },
          { question: "New question?" },
        );
      }
      return originalInsert(owner, kind, value);
    }) as Store["insertIfAbsent"];

    await service.maintain();
    let saved = await db.get<AgentTask>("owner", "tasks", "task1");
    assert.equal(saved?.question, "New question?");
    assert.equal(saved?.state.publishedOutcome, undefined);

    db.insertIfAbsent = originalInsert as Store["insertIfAbsent"];
    await service.maintain();
    saved = await db.get<AgentTask>("owner", "tasks", "task1");
    const expected = `input:task1:${createHash("sha256").update("New question?").digest("hex")}`;
    assert.equal(saved?.state.publishedOutcome, expected);
    assert.equal((await notifications(db)).filter((n) => n.taskId === "task1").length, 2);
  } finally {
    await db.close();
  }
});
