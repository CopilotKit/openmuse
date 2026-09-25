import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EventSchemas, EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import type { AgentNotification, AgentTask } from "../packages/domain/src/agent.ts";
import { modelFixture } from "./helpers/model.ts";

const OWNER = "owner";

async function appFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-subagents-"));
  const db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    model: "openai/fixture",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
  const server = await createApp(db, config);
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { db, server, config };
}

// Variant of the model fixture that streams a text delta, then completes late,
// so timeout behavior can be exercised against real streamed output.
async function textModelFixture(t: TestContext, opts: { delayMs: number; text: string }) {
  const requests: { path: string; body: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url ?? "", body });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (type: string, value: object) =>
      response.write(`data: ${JSON.stringify({ type, ...value })}\n\n`);
    const base = { id: "response-text", created_at: 1000, model: "fixture" };
    emit("response.created", { response: { ...base, status: "in_progress" } });
    emit("response.output_item.added", {
      output_index: 0,
      item: { id: "msg-1", type: "message", status: "in_progress", role: "assistant", content: [] },
    });
    emit("response.content_part.added", {
      item_id: "msg-1",
      output_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    emit("response.output_text.delta", {
      item_id: "msg-1",
      output_index: 0,
      content_index: 0,
      delta: opts.text,
    });
    emit("response.output_text.done", {
      item_id: "msg-1",
      output_index: 0,
      content_index: 0,
      text: opts.text,
    });
    emit("response.content_part.done", {
      item_id: "msg-1",
      output_index: 0,
      part: { type: "output_text", text: opts.text, annotations: [] },
    });
    emit("response.output_item.done", {
      output_index: 0,
      item: {
        id: "msg-1",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: opts.text, annotations: [] }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    emit("response.completed", {
      response: {
        ...base,
        status: "completed",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previousBase = process.env.OPENAI_BASE_URL;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.OPENAI_API_KEY = "fixture-key";
  t.after(async () => {
    if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { requests };
}

test("spawn_subagents creates linked child tasks with depth-1 guardrails", async (t) => {
  const { db, server } = await appFixture(t);
  const { fanoutId, spawned } = await server.agent.spawnSubagents(
    OWNER,
    {
      purpose: "Weekend research",
      subagents: [
        { label: "Alpha", prompt: "Research alpha thoroughly." },
        { label: "Beta", prompt: "Research beta thoroughly." },
      ],
    },
    { depth: 0, idempotencyKey: "fanout-1" },
  );
  assert.equal(spawned.length, 2);
  assert.deepEqual(
    spawned.map((s) => s.label),
    ["Alpha", "Beta"],
  );
  assert.ok(spawned.every((s) => s.status === "queued"));
  assert.ok(new Set(spawned.map((s) => s.id)).size === 2);
  const children = (await db.list<AgentTask>(OWNER, "tasks")).filter(
    (task) => task.input.fanoutId === fanoutId,
  );
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.equal(child.kind, "agent");
    assert.equal(child.input.subagent, true);
    assert.equal(child.input.depth, 1);
    assert.equal(child.input.partialOnTimeout, true);
    assert.equal(child.input.purpose, "Weekend research");
  }
});

test("spawn_subagents is idempotent per idempotency key", async (t) => {
  const { db, server } = await appFixture(t);
  const args = { subagents: [{ label: "Solo", prompt: "Do it." }] };
  const first = await server.agent.spawnSubagents(OWNER, args, {
    depth: 0,
    idempotencyKey: "dup",
  });
  const second = await server.agent.spawnSubagents(OWNER, args, {
    depth: 0,
    idempotencyKey: "dup",
  });
  assert.deepEqual(
    second.spawned.map((s) => s.id),
    first.spawned.map((s) => s.id),
  );
  assert.equal((await db.list(OWNER, "tasks")).length, 1);
});

test("spawn_subagents enforces the parallelism cap and depth 1", async (t) => {
  const { server } = await appFixture(t);
  const six = Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`, prompt: "p" }));
  await assert.rejects(
    server.agent.spawnSubagents(OWNER, { subagents: six }, { depth: 0 }),
    /<=\s?5/,
  );
  await assert.rejects(
    server.agent.spawnSubagents(OWNER, { subagents: [] }, { depth: 0 }),
    />=\s?1/,
  );
  await assert.rejects(
    server.agent.spawnSubagents(OWNER, { subagents: [{ label: "X", prompt: "p" }] }, { depth: 1 }),
    /cannot spawn further subagents/,
  );
});

test("collect_subagents is owner-scoped and truncates long results", async (t) => {
  const { db, server } = await appFixture(t);
  const { spawned } = await server.agent.spawnSubagents(
    OWNER,
    {
      subagents: [
        { label: "A", prompt: "pa" },
        { label: "B", prompt: "pb" },
      ],
    },
    { depth: 0, idempotencyKey: "collect-1" },
  );
  const done = await db.get<AgentTask>(OWNER, "tasks", spawned[0].id);
  assert.ok(done);
  await db.compareAndSwap<AgentTask>(
    OWNER,
    "tasks",
    done.id,
    { status: done.status },
    { status: "succeeded", result: "r".repeat(5000) },
  );
  const collected = await server.agent.collectSubagents(
    OWNER,
    spawned.map((s) => s.id),
  );
  assert.equal(collected[0].status, "succeeded");
  assert.equal(collected[0].label, "A");
  assert.equal(collected[0].result?.length, 2000);
  assert.equal(collected[1].status, "queued");
  assert.equal(collected[1].result, undefined);
  const foreign = await server.agent.collectSubagents(
    "intruder",
    spawned.map((s) => s.id),
  );
  assert.ok(foreign.every((entry) => entry.status === "missing"));
  assert.equal((await db.list("intruder", "tasks")).length, 0);
});

test("chat can fan out with spawn_subagents and gather with collect_subagents", async (t) => {
  const { db, server, config } = await appFixture(t);
  const { requests } = await modelFixture(t, async (index) => {
    if (index === 0)
      return {
        name: "spawn_subagents",
        arguments: {
          purpose: "Compare options",
          subagents: [
            { label: "Alpha", prompt: "Research alpha." },
            { label: "Beta", prompt: "Research beta." },
          ],
        },
      };
    if (index === 1) {
      const tasks = await db.list<AgentTask>("local-user", "tasks");
      return { name: "collect_subagents", arguments: { ids: tasks.map((x) => x.id) } };
    }
    return undefined;
  });
  const conversation = new ConversationAgent(config, server.agent, "local-user");
  const input: RunAgentInput = {
    threadId: "orchestra-chat",
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content: "Compare alpha and beta for me" }],
    tools: [],
    context: [],
    state: {},
  };
  const events = (await lastValueFrom(conversation.run(input).pipe(toArray()))).map((event) =>
    EventSchemas.parse(event),
  );
  const results = events.filter((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.equal(results.length, 2);
  const spawnResult = JSON.parse(results[0].content);
  assert.equal(spawnResult.spawned.length, 2);
  assert.deepEqual(
    spawnResult.spawned.map((s: { label: string }) => s.label),
    ["Alpha", "Beta"],
  );
  const collectResult = JSON.parse(results[1].content);
  assert.equal(collectResult.length, 2);
  assert.ok(collectResult.every((r: { status: string }) => r.status === "queued"));
  assert.match(requests[0].body, /spawn_subagents/);
  assert.match(requests[0].body, /Orchestra mode/);
});

test("subagent worker runs carry the subagent brief and no spawn tools", async (t) => {
  const { requests } = await modelFixture(t, (index) =>
    index === 0 ? { name: "finish_task", arguments: { summary: "Alpha done." } } : undefined,
  );
  const { server } = await appFixture(t);
  const { spawned } = await server.agent.spawnSubagents(
    OWNER,
    { subagents: [{ label: "Alpha", prompt: "Research alpha." }] },
    { depth: 0, idempotencyKey: "brief-1" },
  );
  await server.agent.worker.tick();
  const task = await server.agent.getTask(OWNER, spawned[0].id);
  assert.equal(task.status, "succeeded", task.error ?? task.question);
  assert.ok(requests.length >= 1);
  assert.ok(requests[0].body.includes("SUBAGENT"));
  assert.ok(!requests[0].body.includes('"name":"spawn_subagents"'));
  assert.ok(!requests[0].body.includes('"name":"delegate_task"'));
});

test("a subagent that hits its time limit reports a partial result", async (t) => {
  await textModelFixture(t, {
    delayMs: 2000,
    text: "Partial findings: alpha looks promising.",
  });
  const { server } = await appFixture(t);
  const task = await server.agent.createTask(OWNER, {
    kind: "agent",
    prompt: "Research alpha in depth.",
    input: { subagent: true, timeoutMs: 400, partialOnTimeout: true },
  });
  await server.agent.worker.tick();
  const finished = await server.agent.getTask(OWNER, task.id);
  assert.equal(finished.status, "succeeded", finished.error ?? finished.question);
  assert.match(finished.result ?? "", /Partial result/);
  assert.match(finished.result ?? "", /alpha looks promising/);
});

test("without partialOnTimeout a model timeout still fails the task", async (t) => {
  await textModelFixture(t, { delayMs: 2000, text: "Too slow." });
  const { server } = await appFixture(t);
  const task = await server.agent.createTask(OWNER, {
    kind: "agent",
    prompt: "Research beta in depth.",
    input: { timeoutMs: 400 },
  });
  await server.agent.worker.tick();
  const finished = await server.agent.getTask(OWNER, task.id);
  assert.equal(finished.status, "failed");
  assert.match(finished.error ?? "", /timed out/);
});

test("a finished fanout sends one aggregated notification, not one per helper", async (t) => {
  await modelFixture(t, () => ({
    name: "finish_task",
    arguments: { summary: "Piece complete." },
  }));
  const { db, server } = await appFixture(t);
  const { spawned } = await server.agent.spawnSubagents(
    OWNER,
    {
      purpose: "Compare options",
      subagents: [
        { label: "Alpha", prompt: "Research alpha." },
        { label: "Beta", prompt: "Research beta." },
      ],
    },
    { depth: 0, idempotencyKey: "notify-1" },
  );
  await server.agent.worker.tick();
  for (const s of spawned) {
    const task = await server.agent.getTask(OWNER, s.id);
    assert.equal(task.status, "succeeded", task.error ?? task.question);
  }
  const notifications = await db.list<AgentNotification>(OWNER, "notifications");
  const individual = notifications.filter((n) => spawned.some((s) => s.label === n.title));
  assert.equal(individual.length, 0);
  const aggregated = notifications.filter((n) => /Subagents finished/.test(n.title));
  assert.equal(aggregated.length, 1);
  assert.match(aggregated[0].title, /Subagents finished \(2\/2\): Compare options/);
  assert.match(aggregated[0].body, /Alpha/);
  assert.match(aggregated[0].body, /Beta/);
});
