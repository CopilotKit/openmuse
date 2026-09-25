import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

let db: Store, app: Awaited<ReturnType<typeof createApp>>["app"], directory: string;
const headers = { Authorization: "Bearer placeholder", "Content-Type": "application/json" };

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-chat-history-"));
  db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  ({ app } = await createApp(db, config));
  const response = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  const session = (await response.json()) as { token: string };
  headers.Authorization = `Bearer ${session.token}`;
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

async function seedHistory() {
  // In sample mode the session owner is "local-user" (see Auth.session).
  await db.put("local-user", "conversations", {
    id: "default",
    messages: [{ id: "m1", role: "user", content: "hello" }],
  });
  await db.put("local-user", "conversation-settings", {
    id: "main",
    threadId: "thread-1",
    existing: false,
  });
  await db.put("local-user", "files", {
    id: "file-with-bytes",
    name: "notes.pdf",
    mimeType: "application/pdf",
  });
  await db.put("local-user", "files", {
    id: "file-without-bytes",
    name: "photo.pdf",
    mimeType: "application/pdf",
  });
  await mkdir(join(directory, "files"), { recursive: true });
  await writeFile(join(directory, "files", "file-with-bytes.pdf"), new Uint8Array([1, 2, 3]));
}

test("DELETE /api/chat/history requires authentication", async () => {
  assert.equal((await app.request("/api/chat/history", { method: "DELETE" })).status, 401);
});

test("DELETE /api/chat/history removes messages, files, bytes and thread settings", async () => {
  await seedHistory();
  const response = await app.request("/api/chat/history", { method: "DELETE", headers });
  assert.equal(response.status, 200);
  const result = (await response.json()) as {
    ok: boolean;
    filesDeleted: number;
    threadsDeleted: number;
  };
  assert.equal(result.ok, true);
  // Sample mode pre-seeds demo files, so only assert our two seeded records are gone.
  assert.ok(result.filesDeleted >= 2);
  assert.equal(result.threadsDeleted, 0);
  assert.equal(await db.get("local-user", "conversations", "default"), null);
  assert.equal(await db.get("local-user", "files", "file-with-bytes"), null);
  assert.equal(await db.get("local-user", "files", "file-without-bytes"), null);
  assert.equal(await db.get("local-user", "conversation-settings", "main"), null);
  await assert.rejects(access(join(directory, "files", "file-with-bytes.pdf")));
});

test("DELETE /api/chat/history is idempotent on empty history", async () => {
  const response = await app.request("/api/chat/history", { method: "DELETE", headers });
  assert.equal(response.status, 200);
  const result = (await response.json()) as { ok: boolean; filesDeleted: number };
  assert.equal(result.ok, true);
  assert.equal(result.filesDeleted, 0);
});

test("DELETE /api/chat/history pages through all cloud threads", async (t) => {
  const total = 250,
    pageSize = 100;
  const allIds = Array.from({ length: total }, (_, i) => `thread-${i}`);
  const deleted: string[] = [];
  const listCalls: Parameters<CopilotKitIntelligence["listThreads"]>[0][] = [];
  t.mock.method(
    CopilotKitIntelligence.prototype,
    "listThreads",
    async (input: Parameters<CopilotKitIntelligence["listThreads"]>[0]) => {
      listCalls.push(input);
      const start = input.cursor ? Number(input.cursor) : 0;
      const ids = allIds.slice(start, start + pageSize);
      return {
        threads: ids.map((id) => ({ id, name: id })),
        joinCode: "test",
        nextCursor: start + pageSize < total ? String(start + pageSize) : null,
      };
    },
  );
  t.mock.method(
    CopilotKitIntelligence.prototype,
    "deleteThread",
    async (input: Parameters<CopilotKitIntelligence["deleteThread"]>[0]) => {
      deleted.push(input.threadId);
    },
  );
  const richDirectory = await mkdtemp(join(tmpdir(), "openmuse-chat-history-rich-"));
  const richDb = await createStore();
  const { app: richApp } = await createApp(richDb, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: richDirectory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
    intelligenceApiKey: "test-project-key-never-sent",
  });
  try {
    const session = await richApp.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(session.status, 200);
    const { token } = (await session.json()) as { token: string };
    const response = await richApp.request("/api/chat/history", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      ok: boolean;
      threadsDeleted: number;
      threadsError?: string;
    };
    assert.equal(result.ok, true);
    assert.equal(result.threadsDeleted, 250);
    assert.equal(result.threadsError, undefined);
    assert.equal(deleted.length, 250);
    assert.deepEqual([...deleted].sort(), [...allIds].sort());
    // 100 + 100 + 50, with the cursor advancing each page.
    assert.equal(listCalls.length, 3);
    assert.deepEqual(
      listCalls.map((call) => call.cursor),
      [undefined, "100", "200"],
    );
    assert.ok(listCalls.every((call) => call.limit === 100 && call.userId === "local-user"));
  } finally {
    await richDb.close();
    await rm(richDirectory, { recursive: true, force: true });
  }
});
