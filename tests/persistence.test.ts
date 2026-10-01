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
test("listByStatus matches list plus status filtering", async () => {
  const store = await createStore();
  try {
    for (const [id, status] of [
      ["i0", "new"],
      ["i1", "dismissed"],
      ["i2", "new"],
      ["i3", "accepted"],
    ] as const)
      await store.put("owner", "ideas", { id, status });
    await store.put("owner", "ideas", { id: "i-none" });

    const scoped = await store.listByStatus<{ id: string; status?: string }>(
      "owner",
      "ideas",
      "new",
    );
    const expected = (await store.list<{ id: string; status?: string }>("owner", "ideas")).filter(
      (item) => item.status === "new",
    );
    assert.deepEqual(scoped, expected);

    await store.put("other", "ideas", { id: "x", status: "new" });
    await store.put("owner", "goals", { id: "g", status: "new" });
    assert.equal((await store.listByStatus("owner", "ideas", "new")).length, 2);
    assert.equal((await store.listByStatus("nobody", "ideas", "new")).length, 0);
  } finally {
    await store.close();
  }
});
