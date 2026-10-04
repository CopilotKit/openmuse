import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { BoardState } from "../packages/domain/src/board.ts";

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string, token: string;
/** Owner the sample-mode session is issued under. */
const OWNER = "local-user";
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

/** Create a task and return its id, so each test owns its own board graph. */
async function newTask(prompt: string): Promise<string> {
  const response = await server.app.request("/api/agent/tasks", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ prompt, kind: "plan" }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const task = (await response.json()) as AgentTask;
  return task.id;
}

async function read<T>(path: string, init?: RequestInit, status = 200): Promise<T> {
  const response = await server.app.request(`/api/agent${path}`, { headers: headers(), ...init });
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

/** Assert a status only; used for 204s, which carry no body to parse. */
async function expectStatus(path: string, init: RequestInit, status: number): Promise<void> {
  const response = await server.app.request(`/api/agent${path}`, { headers: headers(), ...init });
  assert.equal(response.status, status, await response.clone().text());
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-board-api-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    intelligenceApiKey: "test-intelligence-key",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  server = await createApp(db, config);
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(session.status, 200);
  token = (await session.json()).token as string;
});
after(async () => {
  await server?.agent?.stop();
  await db.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("a new task starts on the board in Backlog", async () => {
  const id = await newTask("Draft the launch note");
  const detail = await read<{
    board: { boardState: BoardState; allowedTransitions: BoardState[] };
  }>(`/tasks/${id}`);
  assert.equal(detail.board.boardState, "Backlog");
  assert.deepEqual(detail.board.allowedTransitions, ["InProgress", "Cancelled"]);
});

test("a legal move persists and reports the new legal moves", async () => {
  const id = await newTask("Move me along");
  const moved = await read<{ boardState: BoardState; allowedTransitions: BoardState[] }>(
    `/tasks/${id}/board`,
    post({ to: "InProgress" }),
  );
  assert.equal(moved.boardState, "InProgress");
  assert.deepEqual(moved.allowedTransitions, ["Review", "Blocked", "Cancelled"]);
  const reread = await read<{ task: AgentTask }>(`/tasks/${id}`);
  assert.equal(reread.task.boardState, "InProgress");
});

test("an illegal move is a 409 that carries the legal alternatives", async () => {
  const id = await newTask("Cannot skip ahead");
  const body = await read<{ error: string; allowedTransitions: BoardState[] }>(
    `/tasks/${id}/board`,
    post({ to: "Done" }),
    409,
  );
  assert.match(body.error, /Invalid transition from Backlog to Done/);
  // Recoverable in one round-trip rather than by trial and error.
  assert.deepEqual(body.allowedTransitions, ["InProgress", "Cancelled"]);
  const task = await read<{ task: AgentTask }>(`/tasks/${id}`);
  assert.equal(task.task.boardState, "Backlog", "a rejected move must not persist");
});

test("an unknown board state is a 400, not a 409", async () => {
  const id = await newTask("Nonsense state");
  const body = await read<{ error: string }>(`/tasks/${id}/board`, post({ to: "Sideways" }), 400);
  assert.match(body.error, /Unknown board state/);
});

test("a finished task is not re-opened; the 409 says to create a new one", async () => {
  const id = await newTask("Finish and lock");
  await read(`/tasks/${id}/board`, post({ to: "InProgress" }));
  await read(`/tasks/${id}/board`, post({ to: "Review" }));
  await read(`/tasks/${id}/board`, post({ to: "Done" }));
  const body = await read<{ error: string }>(`/tasks/${id}/board`, post({ to: "InProgress" }), 409);
  assert.match(body.error, /terminal state Done/);
});

test("a failed validation gate lands in InProgress even when Done was requested", async () => {
  const id = await newTask("Gate this one");
  await read(`/tasks/${id}/board`, post({ to: "InProgress" }));
  await read(`/tasks/${id}/board`, post({ to: "Review" }));
  const moved = await read<{ boardState: BoardState }>(
    `/tasks/${id}/board`,
    post({ to: "Done", validationPassed: false }),
  );
  assert.equal(moved.boardState, "InProgress");
});

test("board state moves for a task that never had one set still work", async () => {
  // Simulates a row written before the board layer existed: no boardState at all.
  const id = await newTask("Legacy row");
  const stored = await db.get<AgentTask>(OWNER, "tasks", id);
  assert.ok(stored);
  const { boardState: _omitted, ...legacy } = stored;
  await db.put(OWNER, "tasks", legacy as AgentTask);
  assert.equal((await db.get<AgentTask>(OWNER, "tasks", id))?.boardState, undefined);
  const moved = await read<{ boardState: BoardState }>(
    `/tasks/${id}/board`,
    post({ to: "InProgress" }),
  );
  assert.equal(moved.boardState, "InProgress");
});

test("a dependency edge is created, reported, and removable", async () => {
  const upstream = await newTask("Research the vendor");
  const downstream = await newTask("Write the recommendation");
  const graph = await read<{ dependsOn: string[]; dependents: string[]; unmet: string[] }>(
    `/tasks/${downstream}/dependencies`,
    post({ dependsOnId: upstream }),
    201,
  );
  assert.deepEqual(graph.dependsOn, [upstream]);
  assert.deepEqual(graph.unmet, [upstream], "an unfinished prerequisite is unmet");
  const reverse = await read<{ dependents: string[] }>(`/tasks/${upstream}/dependencies`);
  assert.deepEqual(reverse.dependents, [downstream]);

  const removed = await read<{ dependsOn: string[] }>(
    `/tasks/${downstream}/dependencies/${upstream}`,
    { method: "DELETE" },
  );
  assert.deepEqual(removed.dependsOn, []);
});

test("a finished prerequisite stops being unmet", async () => {
  const upstream = await newTask("Finish first");
  const downstream = await newTask("Then this");
  await read(`/tasks/${downstream}/dependencies`, post({ dependsOnId: upstream }), 201);
  const stored = await db.get<AgentTask>(OWNER, "tasks", upstream);
  assert.ok(stored);
  await db.put(OWNER, "tasks", { ...stored, status: "succeeded" });
  const graph = await read<{ unmet: string[] }>(`/tasks/${downstream}/dependencies`);
  assert.deepEqual(graph.unmet, []);
});

test("a dependency on a task that does not exist is a 404, not a silent block", async () => {
  const id = await newTask("No dangling edges");
  await read(`/tasks/${id}/dependencies`, post({ dependsOnId: "does-not-exist" }), 404);
});

test("an edge that would close a cycle is refused with a 409", async () => {
  const a = await newTask("A");
  const b = await newTask("B");
  await read(`/tasks/${b}/dependencies`, post({ dependsOnId: a }), 201);
  const body = await read<{ error: string }>(
    `/tasks/${a}/dependencies`,
    post({ dependsOnId: b }),
    409,
  );
  assert.match(body.error, /already exists or would create a cycle/);
  const graph = await read<{ dependsOn: string[] }>(`/tasks/${a}/dependencies`);
  assert.deepEqual(graph.dependsOn, [], "the cycle was never written");
});

test("a duplicate edge is refused rather than silently doubling up", async () => {
  const a = await newTask("Dup source");
  const b = await newTask("Dup target");
  await read(`/tasks/${b}/dependencies`, post({ dependsOnId: a }), 201);
  await read(`/tasks/${b}/dependencies`, post({ dependsOnId: a }), 409);
  const graph = await read<{ dependsOn: string[] }>(`/tasks/${b}/dependencies`);
  assert.deepEqual(graph.dependsOn, [a]);
});

/** Settle a task so it becomes deletable, mirroring what a worker would write. */
async function settle(id: string, status: "succeeded" | "failed" | "cancelled"): Promise<void> {
  const stored = await db.get<AgentTask>(OWNER, "tasks", id);
  assert.ok(stored);
  await db.put(OWNER, "tasks", { ...stored, status });
}

test("a task that is still running cannot be deleted", async () => {
  const id = await newTask("Still working");
  const body = await read<{ error: string; status?: string }>(
    `/tasks/${id}`,
    { method: "DELETE" },
    409,
  );
  assert.match(body.error, /Cancel the task before deleting/);
  // details are spread flat into the body, matching the board-move convention.
  assert.equal(body.status, "queued", "the conflict reports why it was refused");
  assert.ok(await db.get<AgentTask>(OWNER, "tasks", id), "the task is still there");
});

test("deleting a task removes it and clears its dependency edges both ways", async () => {
  const upstream = await newTask("Delete me upstream");
  const downstream = await newTask("Depends on the deleted task");
  await read(`/tasks/${downstream}/dependencies`, post({ dependsOnId: upstream }), 201);
  await settle(upstream, "cancelled");

  await expectStatus(`/tasks/${upstream}`, { method: "DELETE" }, 204);
  assert.equal(await db.get<AgentTask>(OWNER, "tasks", upstream), null);
  assert.deepEqual(
    await db.dependencies(OWNER, downstream),
    [],
    "no dangling edge into a deleted task",
  );
  assert.deepEqual(await db.dependents(OWNER, upstream), [], "no dangling edge out of it");

  // The dependent must be runnable again: a deleted prerequisite counts as
  // unmet forever otherwise, so it would be blocked for good.
  const graph = await read<{ dependsOn: string[]; unmet: string[] }>(
    `/tasks/${downstream}/dependencies`,
  );
  assert.deepEqual(graph.dependsOn, []);
  assert.deepEqual(graph.unmet, []);
});

test("deleting a task takes its run history with it", async () => {
  const id = await newTask("Delete with history");
  await db.put(OWNER, "run-events", {
    id: "event-for-deleted-task",
    taskId: id,
    date: new Date().toISOString(),
    kind: "status",
    title: "Something happened",
    detail: "",
  });
  await settle(id, "succeeded");
  await expectStatus(`/tasks/${id}`, { method: "DELETE" }, 204);
  const remaining = (await db.list<{ id: string; taskId?: string }>(OWNER, "run-events")).filter(
    (event) => event.taskId === id,
  );
  assert.deepEqual(remaining, []);
});

test("deleting an unknown task is a 404", async () => {
  await expectStatus("/tasks/does-not-exist", { method: "DELETE" }, 404);
});

type BoardTask = {
  id: string;
  title: string;
  status: string;
  blocked: boolean;
  dependsOn: number;
  allowedTransitions: BoardState[];
};
const board = () =>
  read<{ columns: { boardState: BoardState; tasks: BoardTask[] }[] }>("/tasks/board");

test("the board lists every column, including empty ones", async () => {
  const { columns } = await board();
  assert.deepEqual(
    columns.map((column) => column.boardState),
    ["Backlog", "InProgress", "Review", "Blocked", "Done", "Cancelled"],
    "all six states are present so the columns do not jump around as work moves",
  );
});

test("the board offers only the transitions the server will accept", async () => {
  const id = await newTask("Board move source");
  await read(`/tasks/${id}/board`, post({ to: "InProgress" }));
  const { columns } = await board();
  const column = columns.find((entry) => entry.boardState === "InProgress");
  const card = column?.tasks.find((task) => task.id === id);
  assert.ok(card, "the task appears in the column it was moved to");
  // Mirrors ALLOWED_TRANSITIONS. If this drifts, the UI offers a move that 409s.
  assert.deepEqual(card.allowedTransitions, ["Review", "Blocked", "Cancelled"]);
});

test("a task with an unfinished prerequisite is on the board as blocked", async () => {
  const upstream = await newTask("Still to do");
  const downstream = await newTask("Waiting upstream");
  await read(`/tasks/${downstream}/dependencies`, post({ dependsOnId: upstream }), 201);
  const blocked = (await board()).columns
    .flatMap((column) => column.tasks)
    .find((task) => task.id === downstream);
  assert.ok(blocked);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.dependsOn, 1);
  const upstreamCard = (await board()).columns
    .flatMap((column) => column.tasks)
    .find((task) => task.id === upstream);
  assert.equal(upstreamCard?.blocked, false, "a task with no prerequisites is not blocked");
});

test("a task that predates the board layer still appears, in Backlog", async () => {
  const id = await newTask("Legacy row");
  const stored = await db.get<AgentTask>(OWNER, "tasks", id);
  assert.ok(stored);
  const { boardState: _omitted, ...legacy } = stored;
  await db.put(OWNER, "tasks", legacy as AgentTask);
  const backlog = (await board()).columns.find((column) => column.boardState === "Backlog");
  assert.ok(
    backlog?.tasks.some((task) => task.id === id),
    "a row with no boardState falls back to Backlog rather than vanishing",
  );
});
