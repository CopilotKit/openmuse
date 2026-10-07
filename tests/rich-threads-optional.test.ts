import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

// These tests prove the server is self-contained when CPK_INTELLIGENCE_API_KEY
// is absent: it boots on CopilotKit's base SSE mode, Rich Threads is disabled,
// and /api/main-thread (the only route that needs Intelligence) returns 503.
let db: Store, directory: string, token: string;
let app: Awaited<ReturnType<typeof createApp>>["app"];
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-no-intel-"));
  db = await createStore({ dataDir: join(directory, "db") });
  ({ app } = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
    // No intelligenceApiKey: the API must start and fall back to SSE mode.
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

test("server starts without CPK_INTELLIGENCE_API_KEY and disables Rich Threads", async () => {
  const res = await app.request("/api/workspace", { headers: headers() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.runtime.richThreads, false);
  assert.equal(body.runtime.configured, true);
});

test("/api/main-thread is unavailable without Intelligence (503)", async () => {
  const res = await app.request("/api/main-thread", { headers: headers() });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /CPK_INTELLIGENCE_API_KEY|Rich Threads|not configured/i);
});

test("/api/conversation (local store) still works without Intelligence", async () => {
  const written = await app.request("/api/conversation", {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ messages: [{ id: "1", role: "user", content: "hello" }] }),
  });
  assert.equal(written.status, 200);
  const read = await app.request("/api/conversation", { headers: headers() });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), {
    id: "default",
    messages: [{ id: "1", role: "user", content: "hello" }],
  });
});
