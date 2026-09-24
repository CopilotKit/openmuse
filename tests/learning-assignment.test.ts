import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { browserFixture } from "./helpers/browser.ts";
import { modelFixture } from "./helpers/model.ts";

type ThreadRequest = Parameters<CopilotKitIntelligence["getOrCreateThread"]>[0];

async function liveApp(t: TestContext, overrides: Partial<Config> = {}) {
  await modelFixture(t, () => undefined);
  const fixture = await browserFixture(t, () => ({ data: {} }));
  const server = await createApp(fixture.db, {
    ...fixture.config,
    mode: "live",
    agentBackend: "model",
    model: "openai/fixture",
    accessKey: "test-access-key",
    intelligenceApiKey: "test-project-key-never-sent",
    intelligenceLearningContainerId: "openmuse-assistant",
    ...overrides,
  });
  t.after(() => server.agent.stop());
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey: "test-access-key" }),
  });
  assert.equal(session.status, 200, await session.clone().text());
  const { token } = await session.json();
  return {
    app: server.app,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  };
}

function recordThreadRequests(t: TestContext) {
  const calls: ThreadRequest[] = [];
  t.mock.method(
    CopilotKitIntelligence.prototype,
    "getOrCreateThread",
    async (input: ThreadRequest) => {
      calls.push(input);
      throw new Error("Stop after recording the thread request");
    },
  );
  return calls;
}

test("live default-agent runs assign new Threads to the configured Learning container", async (t) => {
  const calls = recordThreadRequests(t);
  const { app, headers } = await liveApp(t);

  const response = await app.request("/api/copilotkit/agent/default/run", {
    method: "POST",
    headers,
    body: JSON.stringify({
      threadId: "side-chat",
      runId: randomUUID(),
      messages: [{ id: randomUUID(), role: "user", content: "Summarize a page" }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });

  assert.equal(response.status, 502);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, "default");
  assert.equal(calls[0].learningContainerId, "openmuse-assistant");
});

// getOrCreateThread returns an existing Thread unchanged, so the main conversation must be
// assigned when /api/main-thread provisions it, before the run handler ever sees it.
test("live main-thread provisioning assigns the main conversation to the Learning container", async (t) => {
  const calls = recordThreadRequests(t);
  const { app, headers } = await liveApp(t);

  const response = await app.request("/api/main-thread", { headers });

  assert.equal(response.status, 502);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, "default");
  assert.equal(calls[0].learningContainerId, "openmuse-assistant");
});

test("main-thread provisioning skips Learning when it is not configured", async (t) => {
  const calls = recordThreadRequests(t);
  const { app, headers } = await liveApp(t, { intelligenceLearningContainerId: undefined });

  assert.equal((await app.request("/api/main-thread", { headers })).status, 502);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].learningContainerId, undefined);
});

test("external AG-UI Threads are not collected as Learning evidence", async (t) => {
  const calls = recordThreadRequests(t);
  const { app, headers } = await liveApp(t, {
    agentBackend: "agui",
    agentUrl: "http://127.0.0.1:1/unused",
  });

  assert.equal((await app.request("/api/main-thread", { headers })).status, 502);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].learningContainerId, undefined);
});
