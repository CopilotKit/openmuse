import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPool, createStore } from "../apps/server/src/db.ts";

test("fresh nested data directory starts and survives a database restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-db-"));
  try {
    const options = { dataDir: join(root, "new-install", "postgres") };
    const first = await createStore(options);
    await first.put("owner", "actions", { id: "action1", status: "executing" });
    await first.close();
    const second = await createStore(options);
    await second.recoverInterruptedActions();
    assert.equal((await second.get("owner", "actions", "action1"))?.status, "outcome_unknown");
    await second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("idle Postgres client errors are logged instead of crashing the process", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const pool = createPool("postgres://127.0.0.1:1/openmuse");
  try {
    assert.doesNotThrow(() => pool.emit("error", new Error("terminating connection")));
    assert.equal(logged.mock.callCount(), 1);
  } finally {
    await pool.end();
  }
});

test("countActiveTasks matches the createTask cap semantics", async () => {
  const store = await createStore();
  try {
    const terminal = ["succeeded", "failed", "cancelled"];
    const statuses = [
      "queued",
      "running",
      "scheduled",
      "waiting_input",
      "waiting_approval",
      "paused",
      "succeeded",
      "failed",
      "cancelled",
    ];
    for (let i = 0; i < statuses.length; i++)
      await store.put("owner", "tasks", { id: `t${i}`, status: statuses[i] });
    await store.put("owner", "tasks", { id: "t-none" });

    const expected = (await store.list<{ id: string; status?: string }>("owner", "tasks")).filter(
      (item) => !terminal.includes(item.status ?? ""),
    ).length;
    assert.equal(await store.countActiveTasks("owner", terminal), expected);
    assert.equal(expected, 7);

    await store.put("other", "tasks", { id: "x", status: "queued" });
    await store.put("owner", "goals", { id: "g", status: "queued" });
    assert.equal(await store.countActiveTasks("owner", terminal), 7);
    assert.equal(await store.countActiveTasks("nobody", terminal), 0);
  } finally {
    await store.close();
  }
});
