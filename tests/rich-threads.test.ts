import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

let db: Store, directory: string, token: string;
let app: Awaited<ReturnType<typeof createApp>>["app"];
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-rich-threads-"));
  db = await createStore();
  ({ app } = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceUserId: "local-user",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
    intelligenceApiKey: "test-project-key-never-sent",
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

test("main chat is provisioned for the authenticated owner before the first run", async (t) => {
  const calls: Parameters<CopilotKitIntelligence["getOrCreateThread"]>[0][] = [];
  t.mock.method(
    CopilotKitIntelligence.prototype,
    "getOrCreateThread",
    async (input: Parameters<CopilotKitIntelligence["getOrCreateThread"]>[0]) => {
      calls.push(input);
      return { id: input.threadId };
    },
  );
  const first = await (await app.request("/api/main-thread", { headers: headers() })).json();
  const reopened = await (await app.request("/api/main-thread", { headers: headers() })).json();
  assert.equal(first.existing, true);
  assert.equal(reopened.threadId, first.threadId);
  assert.ok(
    calls.every(
      (call) =>
        call.userId === "local-user" &&
        call.agentId === "default" &&
        call.threadId === first.threadId,
    ),
  );
  assert.equal(calls.length, 2);
});

test("a failed main-thread connection remains an error and does not create another id", async (t) => {
  const before = await db.get("local-user", "conversation-settings", "main");
  t.mock.method(CopilotKitIntelligence.prototype, "getOrCreateThread", async () => {
    throw new Error("Platform unavailable");
  });
  assert.equal((await app.request("/api/main-thread", { headers: headers() })).status, 502);
  assert.deepEqual(await db.get("local-user", "conversation-settings", "main"), before);
});

test("Rich Threads lists through CopilotKit, scopes by authenticated owner and preserves pagination", async (t) => {
  const calls: Parameters<CopilotKitIntelligence["listThreads"]>[0][] = [];
  t.mock.method(
    CopilotKitIntelligence.prototype,
    "listThreads",
    async (input: Parameters<CopilotKitIntelligence["listThreads"]>[0]) => {
      calls.push(input);
      return {
        threads: [{ id: "thread-1", name: "Trip planning" }],
        joinCode: "test",
        nextCursor: "page-2",
      };
    },
  );
  assert.equal((await app.request("/api/copilotkit/threads?agentId=default")).status, 401);
  assert.equal(calls.length, 0);
  const result = await app.request(
    "/api/copilotkit/threads?agentId=default&userId=forged&includeArchived=true&limit=20&cursor=page-1",
    { headers: headers() },
  );
  assert.equal(result.status, 200, await result.clone().text());
  assert.deepEqual(calls, [
    {
      userId: "local-user",
      agentId: "default",
      includeArchived: true,
      limit: 20,
      cursor: "page-1",
    },
  ]);
  assert.equal((await result.json()).nextCursor, "page-2");
});

test("native and web thread rename reaches the SDK without accepting a forged owner", async (t) => {
  const calls: Parameters<CopilotKitIntelligence["updateThread"]>[0][] = [];
  t.mock.method(
    CopilotKitIntelligence.prototype,
    "updateThread",
    async (input: Parameters<CopilotKitIntelligence["updateThread"]>[0]) => {
      calls.push(input);
      return { id: input.threadId, name: input.updates.name ?? null };
    },
  );
  const preflight = await app.request("/api/copilotkit/threads/thread-1", {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:8081",
      "Access-Control-Request-Method": "PATCH",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  });
  assert.match(preflight.headers.get("Access-Control-Allow-Methods") || "", /PATCH/);
  const response = await app.request("/api/copilotkit/threads/thread-1", {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ agentId: "default", userId: "forged", name: "Weekend plans" }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(calls, [
    {
      threadId: "thread-1",
      userId: "local-user",
      agentId: "default",
      updates: { name: "Weekend plans" },
    },
  ]);
});

test("archive is authenticated and routed to CopilotKit", async (t) => {
  const calls: Parameters<CopilotKitIntelligence["archiveThread"]>[0][] = [];
  t.mock.method(
    CopilotKitIntelligence.prototype,
    "archiveThread",
    async (input: Parameters<CopilotKitIntelligence["archiveThread"]>[0]) => {
      calls.push(input);
    },
  );
  const response = await app.request("/api/copilotkit/threads/thread-1/archive", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ agentId: "default" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ threadId: "thread-1", userId: "local-user", agentId: "default" }]);
});

test("history retains rich tool messages and provider failures remain errors", async (t) => {
  const messages = [
    {
      id: "assistant-1",
      role: "assistant",
      content: "Working on the form",
      toolCalls: [
        { id: "call-1", type: "function", function: { name: "delegate_task", arguments: "{}" } },
      ],
    },
    { id: "tool-1", role: "tool", toolCallId: "call-1", content: '{"taskId":"task-1"}' },
  ];
  const calls: Parameters<CopilotKitIntelligence["getThreadMessages"]>[0][] = [];
  t.mock.method(
    CopilotKitIntelligence.prototype,
    "getThreadMessages",
    async (input: Parameters<CopilotKitIntelligence["getThreadMessages"]>[0]) => {
      calls.push(input);
      return { messages };
    },
  );
  const history = await app.request("/api/copilotkit/threads/thread-1/messages?userId=forged", {
    headers: headers(),
  });
  assert.equal(history.status, 200);
  assert.deepEqual((await history.json()).messages, messages);
  assert.deepEqual(calls, [{ threadId: "thread-1", userId: "local-user" }]);
  t.mock.method(CopilotKitIntelligence.prototype, "listThreads", async () => {
    throw new Error("Platform unavailable");
  });
  assert.equal(
    (await app.request("/api/copilotkit/threads?agentId=default", { headers: headers() })).status,
    500,
  );
});

test("workspace reports Rich Threads configuration without disclosing the project key", async () => {
  const response = await app.request("/api/workspace", { headers: headers() });
  const body = await response.text();
  assert.equal(JSON.parse(body).runtime.richThreads, true);
  assert.ok(!body.includes("test-project-key-never-sent"));
});
