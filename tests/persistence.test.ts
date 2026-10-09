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
test("workspace section reads match the selected snapshot sections", async () => {
  const { WorkspaceService } = await import("../apps/server/src/workspace.ts");
  const { Files } = await import("../apps/server/src/files.ts");
  const store = await createStore();
  try {
    const config = { mode: "sample" } as unknown as import("../apps/server/src/config.ts").Config;
    const workspace = new WorkspaceService(
      store,
      config,
      new Files(store, config, { sign: () => "sig" } as never),
      {} as never,
    );
    await store.put("owner", "settings", { id: "google", enabled: true });
    await store.put("owner", "mail", {
      id: "m1",
      sender: "a@example.com",
      subject: "Subject",
      body: "Body",
      date: "2026-01-02T00:00:00Z",
      label: "INBOX",
      threadId: "t1",
      attachments: [],
    });
    await store.put("owner", "events", {
      id: "e1",
      title: "Event",
      start: "2026-01-02T00:00:00Z",
      end: "2026-01-02T01:00:00Z",
    });
    const full = await workspace.snapshot("owner");

    const mail = await workspace.sectionSnapshot("owner", "mail");
    assert.deepEqual(mail.mail, full.mail);
    assert.equal(mail.events, undefined);
    assert.equal(mail.files, undefined);

    const calendar = await workspace.sectionSnapshot("owner", "calendar");
    assert.deepEqual(calendar.events, full.events);
    assert.equal(calendar.mail, undefined);

    const files = await workspace.sectionSnapshot("owner", "files");
    assert.deepEqual(
      files.files,
      full.files.map(({ url: _url, ...file }) => file),
    );
    assert.equal(files.mail, undefined);
    assert.equal(files.events, undefined);
  } finally {
    await store.close();
  }
});

test("listByGoalId matches list plus goalId filtering", async () => {
  const store = await createStore();
  try {
    await store.put("owner", "tasks", { id: "t0", goalId: "g1" });
    await store.put("owner", "tasks", { id: "t1", goalId: "g2" });
    await store.put("owner", "tasks", { id: "t2", goalId: "g1" });
    await store.put("owner", "tasks", { id: "t-none" });

    const scoped = await store.listByGoalId<{ id: string; goalId?: string }>(
      "owner",
      "tasks",
      "g1",
    );
    const expected = (await store.list<{ id: string; goalId?: string }>("owner", "tasks")).filter(
      (item) => item.goalId === "g1",
    );
    assert.deepEqual(scoped, expected);

    await store.put("other", "tasks", { id: "x", goalId: "g1" });
    await store.put("owner", "goals", { id: "g", goalId: "g1" });
    assert.equal((await store.listByGoalId("owner", "tasks", "g1")).length, 2);
    assert.equal((await store.listByGoalId("nobody", "tasks", "g1")).length, 0);
  } finally {
    await store.close();
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

test("listByTaskId matches list plus taskId filtering", async () => {
  const store = await createStore();
  try {
    // A gap between writes gives each row its own `updated_at`, so `list`'s newest-first order is
    // the reverse of the insertion order and a helper that forgot to order cannot pass by accident.
    const gap = () => new Promise((resolve) => setTimeout(resolve, 3));
    for (const id of ["e0", "e1", "e2"]) {
      await store.put("owner", "run-events", { id, taskId: "t1" });
      await gap();
    }
    await store.put("owner", "run-events", { id: "e-other", taskId: "t2" });
    await store.put("owner", "run-events", { id: "e-none" });

    const scoped = await store.listByTaskId<{ id: string; taskId?: string }>(
      "owner",
      "run-events",
      "t1",
    );
    const expected = (
      await store.list<{ id: string; taskId?: string }>("owner", "run-events")
    ).filter((item) => item.taskId === "t1");
    assert.deepEqual(scoped, expected);
    assert.deepEqual(
      scoped.map((item) => item.id),
      ["e2", "e1", "e0"],
    );

    await store.put("other", "run-events", { id: "x", taskId: "t1" });
    await store.put("owner", "goals", { id: "g", taskId: "t1" });
    assert.equal((await store.listByTaskId("owner", "run-events", "t1")).length, 3);
    assert.equal((await store.listByTaskId("nobody", "run-events", "t1")).length, 0);
  } finally {
    await store.close();
  }
});

test("listByIds matches list plus id filtering, and reads nothing for no ids", async () => {
  const store = await createStore();
  try {
    const gap = () => new Promise((resolve) => setTimeout(resolve, 3));
    for (const id of ["f0", "f1", "f2"]) {
      await store.put("owner", "files", { id, name: id });
      await gap();
    }
    await store.put("owner", "files", { id: "f-other", name: "other" });

    const ids = ["f0", "f2", "f-missing"];
    const scoped = await store.listByIds<{ id: string }>("owner", "files", ids);
    const expected = (await store.list<{ id: string }>("owner", "files")).filter((item) =>
      ids.includes(item.id),
    );
    assert.deepEqual(scoped, expected);
    assert.deepEqual(
      scoped.map((item) => item.id),
      ["f2", "f0"],
    );

    assert.deepEqual(await store.listByIds("owner", "files", []), []);
    await store.put("other", "files", { id: "f0" });
    assert.equal((await store.listByIds("owner", "files", ["f0"])).length, 1);
  } finally {
    await store.close();
  }
});
