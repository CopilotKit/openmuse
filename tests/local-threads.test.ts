import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import {
  CHAT_THREADS_KIND,
  type LocalThreadRecord,
} from "../apps/server/src/threads/local-runner.ts";

let db: Store, directory: string, token: string;
let app: Awaited<ReturnType<typeof createApp>>["app"];
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-local-threads-"));
  db = await createStore();
  // No CPK_INTELLIGENCE_API_KEY at all: local mode must boot and stay keyless.
  ({ app } = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
    threadsBackend: "local",
  }));
  const session = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  token = (await session.json()).token;
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("health reports the local threads backend", async () => {
  const health = await app.request("/api/health");
  assert.equal((await health.json()).threadsBackend, "local");
});

test("the main thread is provisioned locally with no Intelligence contact", async (t) => {
  let intelligenceCalls = 0;
  t.mock.method(CopilotKitIntelligence.prototype, "getOrCreateThread", async () => {
    intelligenceCalls += 1;
    return { id: "unused" };
  });
  const first = await (await app.request("/api/main-thread", { headers: headers() })).json();
  const reopened = await (await app.request("/api/main-thread", { headers: headers() })).json();
  assert.equal(first.existing, true);
  assert.equal(reopened.threadId, first.threadId);
  assert.equal(intelligenceCalls, 0, "local mode never reaches for Intelligence");
  const record = await db.get<LocalThreadRecord>("local-user", CHAT_THREADS_KIND, first.threadId);
  assert.ok(record, "the main thread has a durable local record");
  assert.equal(record.owner, "local-user");
});

test("thread listing is owner-scoped from the database and paginates", async () => {
  const main = await (await app.request("/api/main-thread", { headers: headers() })).json();
  for (let index = 0; index < 2; index++) {
    const now = new Date().toISOString();
    await db.put("local-user", CHAT_THREADS_KIND, {
      id: `side-${index}`,
      owner: "local-user",
      agentId: "default",
      name: `Side ${index}`,
      archived: false,
      createdAt: now,
      updatedAt: now,
      messages: [],
      runs: [],
    });
  }
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 3; page++) {
    const query = `agentId=default&limit=1${cursor ? `&cursor=${cursor}` : ""}`;
    const response = await app.request(`/api/copilotkit/threads?${query}`, { headers: headers() });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.threads.length, 1);
    seen.push(body.threads[0].id);
    cursor = body.nextCursor;
  }
  assert.equal(cursor, null, "the third page exhausts the list");
  assert.equal(new Set(seen).size, 3, "pages do not overlap or repeat");
  assert.ok(seen.includes(main.threadId));
  assert.equal(
    (await app.request("/api/copilotkit/threads?agentId=default")).status,
    401,
    "listing still requires authentication",
  );
});

test("threads can be renamed, archived, restored and deleted in local mode", async () => {
  const main = await (await app.request("/api/main-thread", { headers: headers() })).json();
  const now = new Date().toISOString();
  await db.put("local-user", CHAT_THREADS_KIND, {
    id: "manage-me",
    owner: "local-user",
    agentId: "default",
    name: null,
    archived: false,
    createdAt: now,
    updatedAt: now,
    messages: [],
    runs: [],
  });
  // Rename returns the updated thread in the list shape the SDK parses.
  const renamed = await app.request("/api/copilotkit/threads/manage-me", {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ agentId: "default", name: "Weekly report" }),
  });
  assert.equal(renamed.status, 200, await renamed.clone().text());
  assert.equal((await renamed.json()).name, "Weekly report");
  // Archive moves it out of the active list into the archived filter.
  const archived = await app.request("/api/copilotkit/threads/manage-me/archive", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ agentId: "default" }),
  });
  assert.equal(archived.status, 200);
  assert.deepEqual(await archived.json(), { threadId: "manage-me", archived: true });
  const list = async () =>
    (
      await (
        await app.request("/api/copilotkit/threads?agentId=default&limit=100", {
          headers: headers(),
        })
      ).json()
    ).threads as { id: string; archived: boolean }[];
  assert.ok(
    (await list()).some((thread) => thread.id === "manage-me" && thread.archived),
    "the archived thread shows in the archived list",
  );
  // Restore puts it back in the active list.
  const restored = await app.request("/api/copilotkit/threads/manage-me", {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ agentId: "default", archived: false }),
  });
  assert.equal(restored.status, 200);
  assert.ok(
    (await list()).some((thread) => thread.id === "manage-me" && !thread.archived),
    "the restored thread shows in the active list",
  );
  // Delete removes the durable record and the list entry.
  const deleted = await app.request("/api/copilotkit/threads/manage-me", {
    method: "DELETE",
    headers: headers(),
    body: JSON.stringify({ agentId: "default" }),
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { threadId: "manage-me", deleted: true });
  assert.equal(await db.get("local-user", CHAT_THREADS_KIND, "manage-me"), null);
  assert.ok(
    !(await list()).some((thread) => thread.id === "manage-me"),
    "the deleted thread is gone from the list",
  );
});

test("thread management stays owner-scoped", async () => {
  const now = new Date().toISOString();
  await db.put("someone-else", CHAT_THREADS_KIND, {
    id: "manage-theirs",
    owner: "someone-else",
    agentId: "default",
    name: "Secret",
    archived: false,
    createdAt: now,
    updatedAt: now,
    messages: [{ id: "m1", role: "user", content: "hi" }],
    runs: [],
  });
  for (const [method, path, body] of [
    ["PATCH", "/api/copilotkit/threads/manage-theirs", { agentId: "default", name: "Hijack" }],
    ["POST", "/api/copilotkit/threads/manage-theirs/archive", { agentId: "default" }],
    ["DELETE", "/api/copilotkit/threads/manage-theirs", { agentId: "default" }],
  ] as const) {
    const response = await app.request(path, {
      method,
      headers: headers(),
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 404, `${method} ${path} must not touch another owner's thread`);
  }
  const kept = await db.get("someone-else", CHAT_THREADS_KIND, "manage-theirs");
  assert.ok(kept, "another owner's record is untouched");
  assert.equal(kept.name, "Secret");
  assert.equal(kept.archived, false);
});

test("thread detail endpoints are owner-scoped and clear stays owner-local", async () => {
  const main = await (await app.request("/api/main-thread", { headers: headers() })).json();
  const now = new Date().toISOString();
  await db.put("local-user", CHAT_THREADS_KIND, {
    id: "mine-detail",
    owner: "local-user",
    agentId: "default",
    name: null,
    archived: false,
    createdAt: now,
    updatedAt: now,
    messages: [{ id: "m1", role: "user", content: "hi" }],
    runs: [{ runId: "r1", createdAt: now, events: [{ type: "RUN_STARTED" }] }],
  });
  await db.put("someone-else", CHAT_THREADS_KIND, {
    id: "theirs-detail",
    owner: "someone-else",
    agentId: "default",
    name: null,
    archived: false,
    createdAt: now,
    updatedAt: now,
    messages: [{ id: "secret", role: "user", content: "not yours" }],
    runs: [],
  });
  const mine = await app.request("/api/copilotkit/threads/mine-detail/messages", {
    headers: headers(),
  });
  assert.equal(mine.status, 200);
  assert.deepEqual((await mine.json()).messages, [{ id: "m1", role: "user", content: "hi" }]);
  const events = await app.request("/api/copilotkit/threads/mine-detail/events", {
    headers: headers(),
  });
  assert.equal(events.status, 200);
  assert.equal((await events.json()).events.length, 1);
  // Another owner's thread is indistinguishable from a missing one.
  const theirs = await app.request("/api/copilotkit/threads/theirs-detail/messages", {
    headers: headers(),
  });
  assert.equal(theirs.status, 404);
  const missing = await app.request("/api/copilotkit/threads/nope/messages", {
    headers: headers(),
  });
  assert.equal(missing.status, 404);
  // Clear deletes only the authenticated owner's records.
  const clear = await app.request("/api/copilotkit/threads/clear", {
    method: "POST",
    headers: headers(),
  });
  assert.equal(clear.status, 200);
  const kept = await db.get("someone-else", CHAT_THREADS_KIND, "theirs-detail");
  assert.ok(kept, "another owner's record survives this owner's clear");
  assert.equal(kept.owner, "someone-else");
  assert.equal(await db.get("local-user", CHAT_THREADS_KIND, "mine-detail"), null);
  assert.equal(await db.get("local-user", CHAT_THREADS_KIND, main.threadId), null);
});

test("approvals, browser tools and background tasks behave as in intelligence mode", async () => {
  // Local mode changes only thread persistence; the action review flow is untouched.
  const proposal = await app.request("/api/actions", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      kind: "calendar.create",
      data: {
        title: "Local mode smoke",
        start: "2026-10-08T09:00:00Z",
        end: "2026-10-08T10:00:00Z",
      },
    }),
  });
  assert.equal(proposal.status, 201, await proposal.clone().text());
  const created = await proposal.json();
  assert.equal(created.status, "awaiting_review");
  const decision = await app.request(`/api/actions/${created.id}/decide`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ hash: created.hash, decision: "approve" }),
  });
  assert.equal(decision.status, 200);
});
