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
