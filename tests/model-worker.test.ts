import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { createDemoModel, demoModel } from "../apps/server/src/demo/model.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
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

test("read_web keeps distinct observations of one browser session across a restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-model-"));
  const dataDir = join(directory, "db");
  let db = await createStore({ dataDir });
  const url = "https://example.com/menu";
  const calls = [
    { name: "read_web", arguments: { url } },
    { name: "read_web", arguments: { url } },
    { name: "finish_task", arguments: { summary: "Read the menu twice." } },
  ];
  await modelFixture(t, (index) => calls[index]);
  const server = await createApp(db, {
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
  });
  const sessions: (string | undefined)[] = [];
  server.agent.browser.observe = async (_owner, observedUrl, existingId) => {
    sessions.push(existingId);
    return {
      sessionId: existingId ?? "browser-session-1",
      url: observedUrl,
      title: "Menu",
      text: "Tonight's specials",
      truncated: false,
    };
  };
  try {
    const task = await server.agent.createTask("owner", { prompt: "Read the menu", kind: "agent" });
    await server.agent.worker.tick();
    const finished = await server.agent.getTask("owner", task.id);
    assert.equal(finished.status, "succeeded", finished.error ?? finished.question);
    assert.deepEqual(sessions, [undefined, "browser-session-1"]);
    await db.put("owner", "tasks", {
      ...finished,
      evidence: [
        ...finished.evidence,
        {
          id: "search-result-1",
          kind: "web",
          title: "Menu",
          url,
          excerpt: "Tonight's specials",
          provenance: {
            acquisition: "search",
            observedAt: new Date().toISOString(),
            provider: "example-search",
          },
        },
      ],
    });
    await server.agent.stop();
    await db.close();
    db = await createStore({ dataDir });
    const evidence = (await db.get<AgentTask>("owner", "tasks", task.id))?.evidence ?? [];
    const reads = evidence.filter((item) => item.provenance?.acquisition === "browser");
    assert.equal(reads.length, 2);
    assert.notEqual(reads[0].id, reads[1].id);
    assert.ok(reads.every((item) => item.provenance?.sourceId === "browser-session-1"));
    assert.ok(reads.every((item) => item.id !== "browser-session-1"));
    assert.deepEqual(
      evidence.filter((item) => item.url === url).map((item) => item.provenance?.acquisition),
      ["browser", "browser", "search"],
    );
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("read_mail_thread records each read as its own observation of the message", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-model-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const calls = [
    { name: "read_mail_thread", arguments: { threadId: "trip-thread" } },
    { name: "read_mail_thread", arguments: { threadId: "trip-thread" } },
    { name: "finish_task", arguments: { summary: "Read the thread twice." } },
  ];
  await modelFixture(t, (index) => calls[index]);
  const server = await createApp(db, {
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
  });
  try {
    await server.workspace.ensureSample("owner", server.actions);
    const task = await server.agent.createTask("owner", { prompt: "Read the trip", kind: "agent" });
    await server.agent.worker.tick();
    const finished = await server.agent.getTask("owner", task.id);
    assert.equal(finished.status, "succeeded", finished.error ?? finished.question);
    const reads = finished.evidence.filter((item) => item.kind === "mail");
    assert.equal(reads.length, 2);
    assert.equal(new Set(reads.map((item) => item.id)).size, 2);
    assert.ok(reads.every((item) => item.provenance?.sourceId === "mail-fieldtrip"));
    assert.ok(reads.every((item) => item.id !== "mail-fieldtrip"));
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
