import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { createDemoModel, demoModel } from "../apps/server/src/demo/model.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import { browserFixture } from "./helpers/browser.ts";
import { fixture as computerFixture } from "./helpers/computer.ts";
import { modelFixture } from "./helpers/model.ts";

test("CopilotKit model worker executes server tools and persists the confirmed outcome", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-model-"));
  const db = await createStore();
  const calls: { name: string; arguments: object }[] = [
    {
      name: "set_plan",
      arguments: { steps: ["Inspect available sources", "Save a practical plan"] },
    },
    { name: "read_workspace", arguments: { section: "files" } },
    {
      name: "run_computer_command",
      arguments: { operationId: "check-working-directory", command: "pwd", cwd: "/workspace" },
    },
    {
      name: "save_artifact",
      arguments: {
        kind: "plan",
        title: "Weekend plan",
        summary: "A walk and time to read",
        data: { steps: ["Take a walk", "Read for 30 minutes"] },
      },
    },
    { name: "finish_task", arguments: { summary: "Saved your weekend plan with two steps." } },
  ];
  const { requests } = await modelFixture(t, (index) => calls[index]);
  const server = await createApp(
    db,
    {
      mode: "sample",
      port: 8787,
      host: "127.0.0.1",
      publicUrl: "http://localhost:8787",
      dataDir: directory,
      agentBackend: "model",
      intelligenceApiKey: "test-project-key-never-sent",
      model: "openai/fixture",
      googleRedirectUri: "http://localhost:8787/api/google/callback",
      allowedOrigins: [],
      computerEnabled: true,
    },
    { docker: computerFixture().runner },
  );
  try {
    const task = await server.agent.createTask("owner", {
      prompt: "Make a weekend plan",
      kind: "plan",
    });
    await server.agent.worker.tick();
    const result = await server.agent.detail("owner", task.id);
    assert.equal(result.task.status, "succeeded", result.task.error ?? result.task.question);
    assert.equal(result.task.result, "Saved your weekend plan with two steps.");
    assert.ok(result.artifacts.some((a) => a.title === "Weekend plan"));
    assert.ok(
      result.events.some((event) => event.title === "Read the authorized workspace sources"),
    );
    assert.ok(requests.length >= 4 && requests.length <= 6);
    assert.ok(requests.every((request) => request.path === "/v1/responses"));
    assert.ok(requests[0].body.includes('"name":"prepare_email"'));
    assert.ok(requests[0].body.includes('"name":"run_computer_command"'));
    assert.ok(
      requests.some(
        (request) => request.body.includes("succeeded") && request.body.includes("hello"),
      ),
    );
    assert.equal((await server.computer.snapshot("owner")).commands[0]?.status, "succeeded");
    assert.ok(!requests[0].body.includes('"name":"approve"'));
    requests.length = 0;
    calls.splice(0, calls.length, {
      name: "prepare_event",
      arguments: {
        title: "Sample walk",
        start: "2026-10-10T10:00:00-07:00",
        end: "2026-10-10T11:00:00-07:00",
      },
    });
    const appointment = await server.agent.createTask("owner", {
      prompt: "Prepare a sample walk on my calendar",
    });
    await server.agent.worker.tick();
    const pending = await server.agent.getTask("owner", appointment.id);
    assert.equal(pending.status, "waiting_approval", pending.error ?? pending.question);
    assert.ok(pending.actionId);
    const proposal = await db.get<ActionProposal>("owner", "actions", pending.actionId);
    assert.ok(proposal);
    await server.actions.decide("owner", proposal.id, proposal.hash, "approve");
    requests.length = 0;
    calls.splice(0, calls.length, {
      name: "finish_task",
      arguments: { summary: "The reviewed sample event is on the calendar." },
    });
    await server.agent.worker.tick();
    const finished = await server.agent.getTask("owner", appointment.id);
    assert.equal(finished.status, "succeeded", finished.error ?? finished.question);
    assert.equal(finished.actionId, null);
    assert.ok(requests[0].body.includes("approvalResult"));
    assert.equal(
      (await db.list<ActionProposal>("owner", "actions")).filter((a) => a.taskId === appointment.id)
        .length,
      1,
    );
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the model worker keeps the text a model replies with when it calls no tool", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-model-text-"));
  const db = await createStore();
  const mock = createDemoModel({ latency: 0, firstByteDelay: 0 });
  await mock.start();
  const previousBase = process.env.OPENAI_BASE_URL;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_BASE_URL = `${mock.url}/v1`;
  process.env.OPENAI_API_KEY = "local-demo-test";
  t.after(async () => {
    if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    await mock.stop();
  });
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    intelligenceApiKey: "test-project-key-never-sent",
    model: demoModel,
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  try {
    const task = await server.agent.createTask("owner", { prompt: "Plan my week" });
    await server.agent.worker.tick();
    const result = await server.agent.detail("owner", task.id);
    assert.equal(result.task.status, "waiting_input");
    assert.match(String(result.task.state.lastUpdate), /Find cool stuff on Hacker News/);
    assert.ok(
      result.events.some(
        (event) =>
          event.title === "Agent update" && /Find cool stuff on Hacker News/.test(event.detail),
      ),
      "the reply is recorded in the task timeline",
    );
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser reads keep observation identity distinct while reusing one session", async (t) => {
  let currentUrl = "https://example.com/one";
  const sessionIds = new Set<string>();
  const browser = await browserFixture(t, (path, body) => {
    if (path === "/sessions") {
      const id = String(body.id);
      currentUrl = String(body.url);
      sessionIds.add(id);
      return {
        data: {
          id,
          title: currentUrl,
          url: currentUrl,
          status: "active",
          updatedAt: new Date().toISOString(),
        },
      };
    }
    if (path.endsWith("/read")) {
      return {
        data: {
          url: currentUrl,
          title: currentUrl.endsWith("/one") ? "Source one" : "Source two",
          text: `Evidence from ${currentUrl}`,
          truncated: false,
        },
      };
    }
    throw new Error(`Unexpected browser path: ${path}`);
  });
  const calls: { name: string; arguments: object }[] = [
    { name: "read_web", arguments: { url: "https://example.com/one" } },
    { name: "read_web", arguments: { url: "https://example.com/two" } },
    { name: "finish_task", arguments: { summary: "Compared both public sources." } },
  ];
  await modelFixture(t, (index) => calls[index]);
  const app = await createApp(browser.db, {
    ...browser.config,
    agentBackend: "model",
    model: "openai/fixture",
  });
  t.after(() => app.agent.stop());

  const task = await app.agent.createTask("owner", {
    prompt: "Read both public sources and compare them.",
  });
  await app.agent.worker.tick();

  const saved = await app.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
  const webEvidence = saved.evidence.filter((item) => item.kind === "web");
  assert.equal(webEvidence.length, 2);
  assert.deepEqual(
    webEvidence.map((item) => item.url),
    ["https://example.com/one", "https://example.com/two"],
  );
  assert.equal(sessionIds.size, 1, "both reads should reuse the same browser session");
  assert.equal(new Set(webEvidence.map((item) => item.id)).size, 2);
});
