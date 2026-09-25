import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ActionService } from "../apps/server/src/actions.ts";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { AgentService } from "../apps/server/src/engine/service.ts";
import { WorkboardService } from "../apps/server/src/workboard/service.ts";
import { workboardTools } from "../apps/server/src/workboard/tools.ts";
import type { AgentTask, WorkboardCard, WorkboardStats } from "../packages/domain/src/agent.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";

const OWNER = "workboard-test-owner";
const OTHER = "workboard-test-other";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function fakeTask(overrides: Partial<AgentTask> & { id: string }): AgentTask {
  return {
    status: "queued",
    prompt: "do it",
    title: "task",
    kind: "agent",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    input: {},
    state: {},
    ...overrides,
  } as AgentTask;
}

/** Narrow a dispatched card's task id for assertions. */
function requireTaskId(card: WorkboardCard): string {
  assert.ok(card.taskId, "card has a linked task");
  return card.taskId;
}

/**
 * Minimal AgentService double mirroring the real idempotency semantics:
 * createTask keys task.id = hash("task:" + idempotencyKey); spawnSubagents
 * keys fanoutId = hash("fanout:" + idempotencyKey) and is idempotent per
 * fanout. Never runs anything.
 */
function spyAgent() {
  const tasks = new Map<string, AgentTask>();
  const calls = { createTask: 0, spawnSubagents: 0 };
  const summarize = (task: AgentTask) => ({ id: task.id, label: task.title, status: task.status });
  const agent = {
    async createTask(_owner: string, raw: unknown, idempotencyKey?: string) {
      calls.createTask++;
      const input = raw as {
        prompt: string;
        title?: string;
        kind?: string;
        goalId?: string;
        input?: Record<string, unknown>;
      };
      const id = idempotencyKey ? hash(`task:${idempotencyKey}`) : `task-${calls.createTask}`;
      const existing = tasks.get(id);
      if (existing) return existing;
      const task = fakeTask({
        id,
        title: input.title ?? input.prompt.slice(0, 90),
        prompt: input.prompt,
        kind: (input.kind ?? "agent") as AgentTask["kind"],
        goalId: input.goalId,
        input: input.input ?? {},
      });
      tasks.set(id, task);
      return task;
    },
    async spawnSubagents(
      _owner: string,
      raw: unknown,
      opts: { depth: number; idempotencyKey?: string },
    ) {
      calls.spawnSubagents++;
      if (opts.depth >= 1) throw new Error("Subagents cannot spawn further subagents");
      const input = raw as {
        purpose?: string;
        goalId?: string;
        subagents: { label: string; prompt: string }[];
      };
      const fanoutId = hash(`fanout:${opts.idempotencyKey ?? "test"}`);
      const existing = [...tasks.values()].filter(
        (task) => (task.input as Record<string, unknown>)?.fanoutId === fanoutId,
      );
      if (existing.length) return { fanoutId, spawned: existing.map(summarize) };
      const spawned = input.subagents.map((spec) => {
        const task = fakeTask({
          id: hash(`task:${fanoutId}:${spec.label}`),
          title: spec.label,
          prompt: spec.prompt,
          goalId: input.goalId,
          input: {
            fanoutId,
            subagent: true,
            depth: 1,
            ...(input.purpose ? { purpose: input.purpose } : {}),
          },
        });
        tasks.set(task.id, task);
        return task;
      });
      return { fanoutId, spawned: spawned.map(summarize) };
    },
    async getTask(_owner: string, id: string) {
      const task = tasks.get(id);
      if (!task) throw new Error("Task not found");
      return task;
    },
  };
  return { agent: agent as unknown as AgentService, tasks, calls };
}

let serviceDb: Store;
before(async () => {
  serviceDb = await createStore();
});
after(async () => {
  await serviceDb.close();
});

// ---------------------------------------------------------------------------
// Service-level: dispatch, fan-out, settle sync.
// ---------------------------------------------------------------------------

test("task dispatch links the card, flips todo->doing, and is idempotent", async () => {
  const { agent, calls, tasks } = spyAgent();
  const service = new WorkboardService(serviceDb, agent);
  const card = await service.createCard(OWNER, { title: "Write the report", status: "todo" });
  const first = await service.dispatch(OWNER, card.id, { mode: "task" });
  assert.equal(first.status, "doing");
  const taskId = first.taskId;
  assert.ok(taskId, "card links the created task");
  assert.equal(calls.createTask, 1);
  const task = tasks.get(taskId);
  assert.ok(task, "the linked task exists");
  // The task carries the card linkage in its input.
  assert.deepEqual((task.input as Record<string, unknown>)?.workboard, { cardId: card.id });
  // Retrying a dispatch on an already-doing card returns the card unchanged.
  const second = await service.dispatch(OWNER, card.id, { mode: "task" });
  assert.equal(second.taskId, taskId);
  assert.equal(calls.createTask, 1);
});

test("task dispatch from the wrong column is rejected", async () => {
  const { agent } = spyAgent();
  const service = new WorkboardService(serviceDb, agent);
  const card = await service.createCard(OWNER, { title: "Done already", status: "done" });
  await assert.rejects(() => service.dispatch(OWNER, card.id, { mode: "task" }), /backlog or todo/);
});

test("a failed dispatch rolls the claim back", async () => {
  const { agent } = spyAgent();
  // Break task creation: every createTask throws the 100-task cap error.
  agent.createTask = async () => {
    throw new Error("Finish or cancel some tasks before adding more");
  };
  const service = new WorkboardService(serviceDb, agent);
  const card = await service.createCard(OWNER, { title: "Capped", status: "todo" });
  await assert.rejects(
    () => service.dispatch(OWNER, card.id, { mode: "task" }),
    /before adding more/,
  );
  const rolledBack = await service.getCard(OWNER, card.id);
  assert.equal(rolledBack.status, "todo");
  assert.equal(rolledBack.taskId, undefined);
});

test("fan-out dispatch creates one doing child card per subagent", async () => {
  const { agent, calls } = spyAgent();
  const service = new WorkboardService(serviceDb, agent);
  const before = (await service.listCards(OWNER)).length;
  const card = await service.createCard(OWNER, { title: "Research sprint", status: "todo" });
  const dispatchData = {
    cardId: card.id,
    cardTitle: card.title,
    mode: "fanout" as const,
    purpose: "Deep research",
    subagents: [
      { label: "Search A", prompt: "Search for A" },
      { label: "Search B", prompt: "Search for B" },
    ],
  };
  const updated = await service.executeApprovedDispatch(OWNER, dispatchData);
  assert.equal(updated.status, "doing");
  assert.ok(updated.fanoutId);
  assert.equal(calls.spawnSubagents, 1);
  assert.equal(updated.childCardIds.length, 2);
  const children = await Promise.all(updated.childCardIds.map((id) => service.getCard(OWNER, id)));
  for (const child of children) {
    // Child cards start in doing so settle sync manages them.
    assert.equal(child.status, "doing");
    assert.equal(child.parentCardId, card.id);
    assert.equal(child.fanoutId, updated.fanoutId);
    assert.ok(child.taskId);
  }
  // Retrying the approved dispatch never duplicates child cards.
  const retry = await service.executeApprovedDispatch(OWNER, dispatchData);
  assert.deepEqual(retry.childCardIds, updated.childCardIds);
  assert.equal(calls.spawnSubagents, 1);
  assert.equal((await service.listCards(OWNER)).length, before + 3);
});

test("settle sync moves worker-managed cards and completes the parent", async () => {
  const { agent } = spyAgent();
  const service = new WorkboardService(serviceDb, agent);
  const card = await service.createCard(OWNER, { title: "Fan-out parent", status: "todo" });
  const parent = await service.executeApprovedDispatch(OWNER, {
    cardId: card.id,
    cardTitle: card.title,
    mode: "fanout",
    subagents: [
      { label: "Worker A", prompt: "Do A" },
      { label: "Worker B", prompt: "Do B" },
    ],
  });
  const [childA, childB] = parent.childCardIds;
  const childCardA = await service.getCard(OWNER, childA);
  const childCardB = await service.getCard(OWNER, childB);
  assert.ok(parent.fanoutId, "parent links the fan-out");
  const childTaskInput = { fanoutId: parent.fanoutId, subagent: true as const, depth: 1 };
  // Child task ids are deterministic: hash("task:" + fanoutId + ":" + label).
  await service.handleTaskSettled(
    OWNER,
    fakeTask({ id: requireTaskId(childCardA), status: "succeeded", input: childTaskInput }),
  );
  assert.equal((await service.getCard(OWNER, childA)).status, "done");
  // A waiting task parks its card in review.
  await service.handleTaskSettled(
    OWNER,
    fakeTask({
      id: requireTaskId(childCardB),
      status: "waiting_approval",
      input: childTaskInput,
    }),
  );
  assert.equal((await service.getCard(OWNER, childB)).status, "review");
  // A cancelled run fails the card (never completes it), and the failed
  // child fails the parent — the parent must never wedge.
  await service.handleTaskSettled(
    OWNER,
    fakeTask({ id: requireTaskId(childCardB), status: "cancelled", input: childTaskInput }),
  );
  assert.equal((await service.getCard(OWNER, childB)).status, "failed");
  assert.equal((await service.getCard(OWNER, card.id)).status, "failed");
});

test("a user-moved card is no longer touched by settle sync", async () => {
  const { agent } = spyAgent();
  const service = new WorkboardService(serviceDb, agent);
  const card = await service.createCard(OWNER, { title: "User-owned now", status: "todo" });
  const dispatched = await service.dispatch(OWNER, card.id, { mode: "task" });
  // The user moves the card out of the worker-managed columns ("I'll take it
  // from here") — the later task outcome must not move it back.
  const moved = await service.moveCard(OWNER, card.id, {
    status: "done",
    updatedAt: dispatched.updatedAt,
  });
  assert.equal(moved.status, "done");
  await service.handleTaskSettled(
    OWNER,
    fakeTask({
      id: requireTaskId(dispatched),
      status: "succeeded",
      input: { workboard: { cardId: card.id } },
    }),
  );
  assert.equal((await service.getCard(OWNER, card.id)).status, "done");
});

test("task-mode settle flips the card to done on success", async () => {
  const { agent } = spyAgent();
  const service = new WorkboardService(serviceDb, agent);
  const card = await service.createCard(OWNER, { title: "Solo task", status: "todo" });
  const dispatched = await service.dispatch(OWNER, card.id, { mode: "task" });
  await service.handleTaskSettled(
    OWNER,
    fakeTask({
      id: requireTaskId(dispatched),
      status: "succeeded",
      input: { workboard: { cardId: card.id } },
    }),
  );
  assert.equal((await service.getCard(OWNER, card.id)).status, "done");
});

test("cards are isolated per owner", async () => {
  const { agent } = spyAgent();
  const service = new WorkboardService(serviceDb, agent);
  const card = await service.createCard(OWNER, { title: "Mine" });
  assert.equal((await service.listCards(OTHER)).length, 0);
  await assert.rejects(() => service.getCard(OTHER, card.id), /not found/i);
  await assert.rejects(
    () => service.moveCard(OTHER, card.id, { status: "todo", updatedAt: card.updatedAt }),
    /not found/i,
  );
});

test("fan-out from the chat tool proposes a reviewed action instead of spending runs", async () => {
  const { agent, calls } = spyAgent();
  const service = new WorkboardService(serviceDb, agent);
  const executed: string[] = [];
  const actions = new ActionService(serviceDb, {
    connected: async () => true,
    execute: async (owner, input) => {
      assert.equal(input.kind, "workboard.dispatch");
      executed.push(input.kind);
      await service.executeApprovedDispatch(owner, input.data);
      return "dispatched";
    },
  });
  const tools = workboardTools(service, actions, OWNER, "chat:test");
  const dispatchTool = tools.find((t) => t.name === "workboard_dispatch");
  assert.ok(dispatchTool);
  const execute = dispatchTool.execute as (args: unknown) => Promise<unknown>;
  const card = await service.createCard(OWNER, { title: "Chat fan-out", status: "todo" });
  const result = (await execute({
    mode: "fanout",
    id: card.id,
    subagents: [
      { label: "Alpha", prompt: "Do alpha" },
      { label: "Beta", prompt: "Do beta" },
    ],
  })) as { proposed: boolean; actionId: string };
  assert.equal(result.proposed, true);
  assert.equal(calls.spawnSubagents, 0, "no model runs before approval");
  // Approving the reviewed action dispatches exactly once.
  const proposal = await serviceDb.get<ActionProposal>(OWNER, "actions", result.actionId);
  assert.ok(proposal);
  assert.equal(proposal.status, "awaiting_review");
  const decided = await actions.decide(OWNER, proposal.id, proposal.hash, "approve");
  assert.equal(decided.status, "succeeded");
  assert.deepEqual(executed, ["workboard.dispatch"]);
  assert.equal(calls.spawnSubagents, 1);
  const updated = await service.getCard(OWNER, card.id);
  assert.equal(updated.childCardIds.length, 2);
});

test("a subagent cannot launder task delegation through workboard_dispatch", async () => {
  const { agent } = spyAgent();
  const service = new WorkboardService(serviceDb, agent);
  const actions = new ActionService(serviceDb, {
    connected: async () => true,
    execute: async () => "never",
  });
  // Register the tools in a worker-task context for a depth-1 subagent.
  const subagentTask = await agent.createTask(
    OWNER,
    { prompt: "piece work", input: { subagent: true, depth: 1, fanoutId: "f" } },
    "subagent-task",
  );
  const tools = workboardTools(service, actions, OWNER, `task:${subagentTask.id}`, {
    policy: { taskId: subagentTask.id },
  });
  const dispatchTool = tools.find((t) => t.name === "workboard_dispatch");
  assert.ok(dispatchTool);
  const execute = dispatchTool.execute as (args: unknown) => Promise<unknown>;
  const card = await service.createCard(OWNER, { title: "Sneaky", status: "todo" });
  const result = (await execute({ mode: "task", id: card.id })) as {
    error?: string;
  };
  assert.match(result.error ?? "", /depth is capped at 1/);
  assert.equal((await service.getCard(OWNER, card.id)).status, "todo");
});

// ---------------------------------------------------------------------------
// Route-level: full HTTP surface against the real app.
// ---------------------------------------------------------------------------

let server: Awaited<ReturnType<typeof createApp>>;
let db: Store;
let directory: string;
let token: string;
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const request = (path: string, method: string, body?: unknown) =>
  server.app.request(`/api/workboard${path}`, {
    method,
    headers: headers(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function read<T>(path: string, method = "GET", body?: unknown, status = 200): Promise<T> {
  const response = await request(path, method, body);
  assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-workboard-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    model: "openai/fixture",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  server = await createApp(db, config);
  // Keep the worker loop stopped: dispatch only needs to enqueue, and no
  // model (not even the fixture) should run during these tests.
  await server.agent.stop();
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(session.status, 200);
  token = (await session.json()).token;
});
after(async () => {
  await server?.agent?.stop();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("workboard routes require a session", async () => {
  assert.equal((await server.app.request("/api/workboard")).status, 401);
  assert.equal((await server.app.request("/api/workboard/cards", { method: "POST" })).status, 401);
});

test("card CRUD and the board binding shape", async () => {
  const board = await read<{ cards: WorkboardCard[]; stats: WorkboardStats }>("", "GET");
  assert.ok(Array.isArray(board.cards));
  assert.equal(typeof board.stats.total, "number");
  assert.equal(typeof board.stats.byStatus.backlog, "number");

  const created = await read<WorkboardCard>("/cards", "POST", { title: "  Ship it  " }, 201);
  assert.equal(created.title, "Ship it");
  assert.equal(created.status, "backlog");
  assert.equal(created.priority, "medium");

  const fetched = await read<WorkboardCard>(`/cards/${created.id}`);
  assert.equal(fetched.id, created.id);

  const renamed = await read<WorkboardCard>(
    `/cards/${created.id}`,
    "PATCH",
    { title: "Ship it now", priority: "high" },
    200,
  );
  assert.equal(renamed.title, "Ship it now");
  assert.equal(renamed.priority, "high");

  const moved = await read<WorkboardCard>(
    `/cards/${created.id}/move`,
    "POST",
    { status: "todo", updatedAt: renamed.updatedAt },
    200,
  );
  assert.equal(moved.status, "todo");

  const boardAfter = await read<{ cards: WorkboardCard[]; stats: WorkboardStats }>("", "GET");
  assert.equal(boardAfter.stats.total, board.stats.total + 1);
  assert.equal(boardAfter.stats.active, board.stats.active + 1);
});

test("stale updatedAt moves are rejected with 409", async () => {
  const created = await read<WorkboardCard>("/cards", "POST", { title: "Race card" }, 201);
  const first = await read<WorkboardCard>(
    `/cards/${created.id}/move`,
    "POST",
    { status: "todo", updatedAt: created.updatedAt },
    200,
  );
  assert.equal(first.status, "todo");
  const stale = await request(`/cards/${created.id}/move`, "POST", {
    status: "doing",
    updatedAt: created.updatedAt,
  });
  assert.equal(stale.status, 409);
  assert.match(await stale.text(), /changed/i);
  assert.equal((await read<WorkboardCard>(`/cards/${created.id}`)).status, "todo");
});

test("validation errors surface cleanly", async () => {
  // Schema validation follows the app-wide convention (422, like the zod
  // error handler in app.ts); semantic errors keep their own codes.
  await read("/cards", "POST", { title: "" }, 422);
  await read("/cards", "POST", { title: "x".repeat(161) }, 422);
  await read("/cards", "POST", { title: "Goal card", goalId: "no-such-goal" }, 404);
  await read("/cards/no-such-card", "GET", undefined, 404);
});

test("task dispatch links the card and is idempotent over HTTP", async () => {
  const created = await read<WorkboardCard>("/cards", "POST", { title: "HTTP task" }, 201);
  await read(`/cards/${created.id}/move`, "POST", {
    status: "todo",
    updatedAt: created.updatedAt,
  });
  const dispatched = await read<WorkboardCard>(
    `/cards/${created.id}/dispatch`,
    "POST",
    { mode: "task" },
    200,
  );
  assert.equal(dispatched.status, "doing");
  assert.ok(dispatched.taskId, "card links the created task");
  // Re-dispatch returns the card unchanged, no duplicate task.
  const again = await read<WorkboardCard>(
    `/cards/${created.id}/dispatch`,
    "POST",
    { mode: "task" },
    200,
  );
  assert.equal(again.taskId, dispatched.taskId);
  assert.equal(again.status, "doing");
  // Dispatch from the wrong column is rejected for a never-dispatched card.
  const doneCard = await read<WorkboardCard>("/cards", "POST", { title: "Already done" }, 201);
  const doneMoved = await read<WorkboardCard>(
    `/cards/${doneCard.id}/move`,
    "POST",
    { status: "done", updatedAt: doneCard.updatedAt },
    200,
  );
  assert.equal(doneMoved.status, "done");
  await read(`/cards/${doneCard.id}/dispatch`, "POST", { mode: "task" }, 409);
});

test("fan-out dispatch creates child cards over HTTP", async () => {
  const created = await read<WorkboardCard>("/cards", "POST", { title: "HTTP fan-out" }, 201);
  await read(`/cards/${created.id}/move`, "POST", {
    status: "todo",
    updatedAt: created.updatedAt,
  });
  const dispatched = await read<WorkboardCard>(
    `/cards/${created.id}/dispatch`,
    "POST",
    {
      mode: "fanout",
      purpose: "Split research",
      subagents: [
        { label: "Part one", prompt: "Research part one" },
        { label: "Part two", prompt: "Research part two" },
        { label: "Part three", prompt: "Research part three" },
      ],
    },
    200,
  );
  assert.equal(dispatched.status, "doing");
  assert.ok(dispatched.fanoutId);
  assert.equal(dispatched.childCardIds.length, 3);
  const child = await read<WorkboardCard>(`/cards/${dispatched.childCardIds[0]}`);
  assert.equal(child.status, "doing");
  assert.equal(child.parentCardId, created.id);
});

test("goals can be attached to cards", async () => {
  const goal = await server.app.request("/api/agent/goals", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ title: "Launch" }),
  });
  assert.equal(goal.status, 201, await goal.clone().text());
  const { id: goalId } = (await goal.json()) as { id: string };
  const created = await read<WorkboardCard>("/cards", "POST", { title: "Goal card", goalId }, 201);
  assert.equal(created.goalId, goalId);
});
