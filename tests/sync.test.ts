import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { foldChanges, type SyncChange } from "../packages/domain/src/sync.ts";

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string, token: string;
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

async function newTask(prompt: string): Promise<string> {
  const response = await server.app.request("/api/agent/tasks", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ prompt, kind: "plan" }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return ((await response.json()) as AgentTask).id;
}

type Page = { changes: SyncChange[]; cursor: number; hasMore: boolean };

async function sync(since?: number, limit?: number): Promise<Page> {
  const query = new URLSearchParams();
  if (since !== undefined) query.set("since", String(since));
  if (limit !== undefined) query.set("limit", String(limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const response = await server.app.request(`/api/agent/sync${suffix}`, { headers: headers() });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<Page>;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-sync-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    intelligenceApiKey: "test-key",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  server = await createApp(db, config);
  // clearAll resets the log too, so mint the session after it.
  await db.clearAll();
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  token = ((await session.json()) as { token: string }).token;
});

after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("a full pull from cursor 0 replays every change in order", async () => {
  const a = await newTask("first task");
  const b = await newTask("second task");
  const page = await sync(0);
  const taskPuts = page.changes.filter((c) => c.kind === "tasks" && c.op === "put");
  const ids = taskPuts.map((c) => c.recordId);
  assert.ok(ids.includes(a), "a newly created task reaches the log");
  assert.ok(ids.includes(b));
  const seqs = page.changes.map((c) => c.seq);
  assert.deepEqual(
    seqs,
    [...seqs].sort((x, y) => x - y),
    "seq is monotonic",
  );
});

test("the cursor advances only by what was actually delivered", async () => {
  await sync(0);
  const first = await sync(0, 2);
  assert.equal(first.changes.length, 2);
  assert.equal(first.cursor, first.changes[1]?.seq, "cursor is the last delivered seq");
  // The next page must resume exactly where this one stopped — not at the newest
  // change in the table, which would silently skip everything in between.
  const second = await sync(first.cursor, 2);
  assert.ok(
    (second.changes[0]?.seq ?? 0) > first.cursor,
    "the next page starts strictly after the cursor, skipping nothing",
  );
});

test("a device that falls behind pages forward to the same state", async () => {
  for (const n of [3, 4, 5]) await newTask(`paging task ${n}`);
  const oneShot = await sync(0, 1000);
  let cursor = 0;
  const collected: SyncChange[] = [];
  for (;;) {
    const page = await sync(cursor, 2);
    collected.push(...page.changes);
    cursor = page.cursor;
    if (!page.hasMore) break;
  }
  // Rebuilding from a full pull and from many small pulls must agree, or a device
  // that loses its cache and rebuilds could land somewhere different from one that
  // synced incrementally.
  assert.deepEqual(
    foldChanges({}, collected),
    foldChanges({}, oneShot.changes),
    "paged and full pulls fold to the same projection",
  );
});

test("deleting a record logs a delete so devices drop it", async () => {
  const id = await newTask("doomed task");
  await sync(0);
  // Exercised through the Store rather than the HTTP route: the route legitimately
  // refuses a non-terminal task with a 409, which would make this assertion
  // depend on the task's lifecycle rather than on sync behaviour. What matters is
  // that `remove` reaches the log at all -- if it does not, a record deleted on the
  // server reappears on every device on its next pull.
  await db.remove("local-user", "tasks", id);
  const page = await sync(0, 1000);
  const deletion = page.changes.find((c) => c.recordId === id && c.op === "delete");
  assert.ok(deletion, "the delete reached the log");
  assert.equal(deletion?.data, undefined, "a delete carries no body");

  // And a device folding the whole log must end up without the record.
  const projected = foldChanges({}, page.changes);
  assert.equal(projected[`tasks:${id}`], undefined);
});

test("a negative or non-integer cursor is a 400", async () => {
  for (const bad of ["-1", "1.5", "abc"]) {
    const response = await server.app.request(`/api/agent/sync?since=${bad}`, {
      headers: headers(),
    });
    assert.equal(response.status, 400, `since=${bad} should be rejected`);
  }
});

test("an out-of-range limit is a 400", async () => {
  for (const bad of ["0", "5000", "-3"]) {
    const response = await server.app.request(`/api/agent/sync?limit=${bad}`, {
      headers: headers(),
    });
    assert.equal(response.status, 400, `limit=${bad} should be rejected`);
  }
});

test("the log does not leak across owners", async () => {
  await db.appendChange("someone-else", {
    kind: "tasks",
    recordId: "not-yours",
    op: "put",
    data: { secret: true },
  });
  const page = await sync(0, 1000);
  assert.equal(
    page.changes.find((c) => c.recordId === "not-yours"),
    undefined,
    "another owner's writes must never appear in this owner's log",
  );
});

test("concurrent writers get distinct sequence numbers", async () => {
  // The seq counter is bumped with RETURNING rather than read-then-write. If it
  // were a read-then-write, two concurrent appends could share a seq and one
  // change would vanish from every device's cursor.
  const seqs = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      db.appendChange("local-user", {
        kind: "tasks",
        recordId: `concurrent-${i}`,
        op: "put",
        data: { n: i },
      }),
    ),
  );
  assert.equal(new Set(seqs).size, seqs.length, "every append got a unique seq");
});
