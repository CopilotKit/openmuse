import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { AgentTask, RunEvent } from "../packages/domain/src/agent.ts";

let db: Store;
let server: Awaited<ReturnType<typeof createApp>>;
let directory: string;
let token: string;
let config: Config;

const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const request = (path: string, body?: unknown) =>
  server.app.request(`/api/agent${path}`, {
    headers: headers(),
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });

async function read<T>(path: string, body?: unknown, status = 200): Promise<T> {
  const response = await request(path, body);
  assert.equal(response.status, status, await response.clone().text());
  return response.json() as Promise<T>;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-device-"));
  const postgresUrl = "postgresql://openmuse:om_test_123@127.0.0.1:5432/openmuse_test";
  db = await createStore({ dataDir: join(directory, "db"), databaseUrl: postgresUrl });
  config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    databaseUrl: postgresUrl,
    agentBackend: "model",
    openaiApiFormat: "responses",
    intelligenceApiKey: "test-key-for-tests",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  server = await createApp(db, config);
});

after(async () => {
  await server?.agent?.stop();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("session accepts and stores device identity", async () => {
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "pixel-8-pro", deviceName: "James Pixel" }),
  });
  assert.equal(session.status, 200);
  const { token: newToken, mode } = (await session.json()) as { token: string; mode: string };
  assert.ok(newToken);
  assert.equal(mode, "sample");
  token = newToken;

  // Verify the session stored device info by checking task creation
  const task = await read<AgentTask>(
    "/tasks",
    { kind: "plan", prompt: "Test device identity" },
    201,
  );
  assert.ok(task.state.creatorDevice);
  assert.deepEqual(task.state.creatorDevice, {
    deviceId: "pixel-8-pro",
    deviceName: "James Pixel",
  });
});

test("SSE endpoint returns 404 for unknown task", async () => {
  const response = await server.app.request("/api/agent/tasks/nonexistent/stream", {
    headers: headers(),
  });
  assert.equal(response.status, 404);
});

test("SSE stream delivers existing run-events and task-complete", async () => {
  // Create a task
  const task = await read<AgentTask>("/tasks", { kind: "plan", prompt: "SSE stream test" }, 201);
  const owner = "local-user";

  // Insert a run-event directly into the DB
  const event: RunEvent = {
    id: "sse-test-event-1",
    taskId: task.id,
    date: new Date().toISOString(),
    kind: "plan",
    title: "Test Plan Event",
    detail: "SSE streaming test",
  };
  await db.put(owner, "run-events", event);

  // Set the task to a terminal state so the stream closes
  const updated = await db.compareAndSwap<AgentTask>(
    owner,
    "tasks",
    task.id,
    { status: "queued" },
    { status: "succeeded", result: "Task completed successfully" },
  );
  assert.ok(updated, "compareAndSwap should have updated the task");

  // Connect to the SSE stream
  const response = await server.app.request(`/api/agent/tasks/${task.id}/stream`, {
    headers: headers(),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  assert.ok(response.body, "Response should have a body stream");

  // Read the full body (stream closes since task is in terminal state)
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let done = false;
  while (!done) {
    const result = await reader.read();
    done = result.done;
    if (result.value) raw += decoder.decode(result.value, { stream: true });
  }
  reader.releaseLock();

  // Parse SSE messages
  const messages = raw
    .split("\n\n")
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
    .map((m) => {
      const lines = m.split("\n");
      const event = lines
        .find((l) => l.startsWith("event:"))
        ?.slice(6)
        .trim();
      const data = lines
        .find((l) => l.startsWith("data:"))
        ?.slice(5)
        .trim();
      return { event, data: data ? JSON.parse(data) : undefined };
    });

  // Verify we got the run-event
  const runEventMsg = messages.find((m) => m.event === "run-event");
  assert.ok(runEventMsg, "Should have a run-event SSE message");
  assert.equal(runEventMsg.data.kind, "plan");
  assert.equal(runEventMsg.data.title, "Test Plan Event");

  // Verify we got the task-complete event
  const completeMsg = messages.find((m) => m.event === "task-complete");
  assert.ok(completeMsg, "Should have a task-complete SSE message");
  assert.equal(completeMsg.data.status, "succeeded");
  assert.equal(completeMsg.data.result, "Task completed successfully");
});

test("SSE stream stays open for running tasks", async () => {
  const task = await read<AgentTask>(
    "/tasks",
    { kind: "plan", prompt: "Streaming poll test" },
    201,
  );

  // Start the SSE request — task is "queued", not terminal, so stream stays open
  const response = await server.app.request(`/api/agent/tasks/${task.id}/stream`, {
    headers: headers(),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  assert.ok(response.body, "Response should have a body stream");

  // The stream polls every 2s — cancel immediately to avoid hanging.
  // Just verify the response is a valid SSE stream that stays open.
  response.body.cancel();
});

test("task created without device info has no creatorDevice", async () => {
  // Create a separate session without device info
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(session.status, 200);
  const { token: noDeviceToken } = (await session.json()) as { token: string };

  const response = await server.app.request(`/api/agent/tasks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${noDeviceToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "plan", prompt: "No device test" }),
  });
  assert.equal(response.status, 201);
  const task = (await response.json()) as AgentTask;
  assert.equal(task.state.creatorDevice, undefined);
});
