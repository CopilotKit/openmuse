import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { AgentTask, Note } from "../packages/domain/src/agent.ts";

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string, token: string;
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

interface NoteRow extends Note {
  /** Server-resolved so the UI cannot offer a promotion that would be refused. */
  promotable: boolean;
}

async function newNote(body: string, title?: string): Promise<Note> {
  const response = await server.app.request("/api/agent/notes", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ body, ...(title === undefined ? {} : { title }) }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as Note;
}

async function read<T>(path: string, init?: RequestInit, status = 200): Promise<T> {
  const response = await server.app.request(`/api/agent${path}`, { headers: headers(), ...init });
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

interface PromotionResult {
  note: Note;
  taskId: string | null;
  alreadyPromoted: boolean;
}

async function promote(id: string, kind?: string): Promise<PromotionResult> {
  return read<PromotionResult>(`/notes/${id}/promote`, post(kind ? { kind } : {}));
}

async function boardTitles(): Promise<string[]> {
  const board = await read<{ columns: { tasks: { title: string }[] }[] }>("/tasks/board");
  return (board.columns ?? []).flatMap((column) => column.tasks.map((task) => task.title));
}

/**
 * A task's record.
 *
 * `GET /tasks/:id` returns a detail *envelope* (`{task, board, dependencies,
 * …}`), not the bare task, so this unwraps it once rather than at every call
 * site.
 */
async function detail(id: string): Promise<AgentTask> {
  return (await read<{ task: AgentTask }>(`/tasks/${id}`)).task;
}

/** Every task on the board, across all columns. */
async function allTasks(): Promise<{ id: string; title: string }[]> {
  const board = await read<{ columns: { tasks: { id: string; title: string }[] }[] }>(
    "/tasks/board",
  );
  return (board.columns ?? []).flatMap((column) => column.tasks);
}

/** How many tasks on the board carry this exact prompt. */
async function countTasksWithPrompt(prompt: string): Promise<number> {
  const tasks = await allTasks();
  const details = await Promise.all(tasks.map((task) => detail(task.id)));
  return details.filter((task) => task.prompt === prompt).length;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-notes-api-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    intelligenceApiKey: "test-...key",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  server = await createApp(db, config);
  // Minted AFTER the store is built and any reset has run, or the token is
  // rejected as expired — which reads like an auth bug rather than test order.
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

test("a captured note is not work: it sits open, promotable, and off the board", async () => {
  const note = await newNote("Ask Bea whether the lease window is long enough.", "Lease window");
  assert.equal(note.status, "open");
  assert.equal(note.taskId, undefined);

  const listed = await read<NoteRow[]>("/notes");
  const found = listed.find((row) => row.id === note.id);
  assert.equal(found?.promotable, true);
  // The whole point of the note plane: capturing a thought starts no work.
  assert.equal((await boardTitles()).includes("Lease window"), false);
});

test("promotion creates exactly one task, carrying the note body as its prompt", async () => {
  const note = await newNote("Compare the two lease implementations.");
  const result = await promote(note.id);
  assert.equal(result.alreadyPromoted, false);
  assert.ok(result.taskId);

  const task = await detail(result.taskId!);
  assert.equal(task.prompt, "Compare the two lease implementations.");
  // An untitled note gets a title from its own first line, so the board shows
  // something readable rather than a blank card.
  assert.equal(task.title, "Compare the two lease implementations.");

  const listed = await read<NoteRow[]>("/notes");
  const promoted = listed.find((row) => row.id === note.id);
  assert.equal(promoted?.status, "promoted");
  assert.equal(promoted?.taskId, result.taskId);
  // A promoted note must not keep offering the action.
  assert.equal(promoted?.promotable, false);
});

test("promoting twice returns the same task rather than creating a second one", async () => {
  // The task id is derived from the note id, so a repeat promotion converges on
  // one row. Without that, a double tap on the phone is two board cards.
  const note = await newNote("Only ever one task for this.");
  const first = await promote(note.id);
  const second = await promote(note.id);
  assert.equal(second.alreadyPromoted, true);
  assert.equal(second.taskId, first.taskId);

  assert.equal(await countTasksWithPrompt("Only ever one task for this."), 1);
});

test("promoting the same note from two requests at once still yields one task", async () => {
  const note = await newNote("Race me.");
  const [a, b] = await Promise.all([promote(note.id), promote(note.id)]);
  assert.equal(a.taskId, b.taskId);

  assert.equal(await countTasksWithPrompt("Race me."), 1);
});

test("promotion honours the requested task kind", async () => {
  const note = await newNote("Draft the launch summary.");
  const result = await promote(note.id, "document");
  const task = await detail(result.taskId!);
  assert.equal(task.kind, "document");
});

test("an unknown task kind is refused rather than silently defaulted", async () => {
  // Defaulting would create work of a kind the caller did not ask for, under a
  // task id they believe they chose.
  const note = await newNote("What kind am I?");
  await read(`/notes/${note.id}/promote`, post({ kind: "sorcery" }), 422);
  const listed = await read<NoteRow[]>("/notes");
  assert.equal(listed.find((row) => row.id === note.id)?.status, "open");
});

test("an empty note cannot be created, so it can never be promoted either", async () => {
  // Zod rejects it, and the app maps a schema failure to 422 — the same status
  // an invalid promotion kind gets, so one rule covers both invalid bodies.
  await read("/notes", post({ body: "   " }), 422);
});

test("promoting a note that does not exist is a 404, not a silent success", async () => {
  await read("/notes/nope/promote", post({}), 404);
});

test("deleting an open note removes it and logs the deletion for devices", async () => {
  const note = await newNote("Temporary thought.");
  await read(`/notes/${note.id}`, { method: "DELETE" });
  const listed = await read<NoteRow[]>("/notes");
  assert.equal(
    listed.some((row) => row.id === note.id),
    false,
  );

  // A device that still holds the note must learn it is gone, or it reappears on
  // the phone every time it re-syncs.
  const changes = await read<{ changes: { kind: string; recordId: string; op: string }[] }>(
    "/sync?since=0",
  );
  // The LAST change for the record, not the first: creation logged a `put`, and
  // `find` would match that and report a healthy sync as broken. A device
  // applies changes in order, so only the final one decides the note's fate.
  const history = changes.changes.filter(
    (change) => change.kind === "notes" && change.recordId === note.id,
  );
  assert.equal(history.at(-1)?.op, "delete");
});

test("a promoted note cannot be deleted while its task is still open", async () => {
  // Deleting the note would not delete the task, so the board would keep a card
  // whose origin the user can no longer see. Cancelling the task is the honest
  // way to retire it.
  const note = await newNote("Keep the provenance.");
  const result = await promote(note.id);
  await read(`/notes/${note.id}`, { method: "DELETE" }, 409);

  const listed = await read<NoteRow[]>("/notes");
  const still = listed.find((row) => row.id === note.id);
  assert.equal(still?.taskId, result.taskId);
  // The task itself is untouched by the refused delete.
  assert.equal((await detail(result.taskId!)).id, result.taskId);
});

test("notes are owner-scoped: another owner's notes are not readable here", async () => {
  // A single-owner store would pass every test above while leaking on a real
  // deployment, so the owner is asserted rather than assumed.
  await db.put("someone-else", "notes", {
    id: "foreign",
    title: "",
    body: "Not yours.",
    status: "open",
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
  });
  const listed = await read<NoteRow[]>("/notes");
  assert.equal(
    listed.some((row) => row.id === "foreign"),
    false,
  );
});
