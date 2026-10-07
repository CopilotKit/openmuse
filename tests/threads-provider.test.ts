import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { EventType } from "@ag-ui/client";
import { VERSION, ɵGLOBAL_STORE } from "@copilotkit/runtime/v2";
import { firstValueFrom, toArray } from "rxjs";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import {
  CHAT_THREADS_KIND,
  type LocalThreadRecord,
  PersistentAgentRunner,
  THREADS_CONTRACT_REF,
} from "../apps/server/src/threads/local-runner.ts";
import { createThreadProvider } from "../apps/server/src/threads/provider.ts";

let db: Store, directory: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-threads-provider-"));
  db = await createStore();
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

/** A scripted agent: emits a couple of events, then resolves like a finished run. */
function fakeAgent(id: string, owner: string, owners: Map<unknown, string>) {
  const agent = {
    agentId: "default",
    messages: [
      { id: "user-1", role: "user", content: "Hello" },
      { id: "assistant-1", role: "assistant", content: "Hi there" },
    ],
    async runAgent(
      _input: unknown,
      callbacks: {
        onEvent: (payload: { event: unknown }) => void;
        onNewMessage: (payload: { message: unknown }) => void;
      },
    ) {
      callbacks.onEvent({ event: { type: EventType.RUN_STARTED, threadId: id, runId: "run-1" } });
      callbacks.onEvent({
        event: {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "assistant-1",
          delta: "Hi there",
        },
      });
      callbacks.onNewMessage({ message: { id: "assistant-1" } });
      callbacks.onEvent({ event: { type: EventType.RUN_FINISHED } });
    },
  };
  owners.set(agent, owner);
  return agent as never;
}

function runnerFor(owners: Map<unknown, string>) {
  return new PersistentAgentRunner(db, (agent) => owners.get(agent));
}

async function runOnce(runner: PersistentAgentRunner, threadId: string, agent: never) {
  return firstValueFrom(
    runner
      .run({ threadId, agent, input: { threadId, runId: "run-1", messages: [] } } as never)
      .pipe(toArray()),
  );
}

test("the pinned runtime version still matches the store contract this runner relies on", () => {
  assert.ok(THREADS_CONTRACT_REF.includes(VERSION));
});

test("RUN_FINISHED is held until the snapshot write completes", async () => {
  const owners = new Map<unknown, string>();
  const order: string[] = [];
  const original = db.put.bind(db);
  db.put = ((owner: string, kind: string, value: { id: string }) => {
    order.push("put");
    return new Promise((resolve) => setTimeout(resolve, 40)).then(() =>
      original(owner, kind, value),
    );
  }) as Store["put"];
  try {
    const events = await runOnce(
      runnerFor(owners),
      "thread-gated",
      fakeAgent("thread-gated", "owner-1", owners),
    );
    order.push(...events.map((event) => (event as { type: string }).type));
    const putAt = order.indexOf("put");
    const finishedAt = order.indexOf(EventType.RUN_FINISHED);
    assert.notEqual(putAt, -1, "the snapshot was written");
    assert.notEqual(finishedAt, -1, "the run finished");
    assert.ok(putAt < finishedAt, "persistence lands before the client sees completion");
    assert.equal(finishedAt, order.length - 1, "RUN_FINISHED is still the terminal event");
  } finally {
    db.put = original;
  }
});

test("a failed snapshot write is a visible RUN_ERROR, not a silent loss", async () => {
  const owners = new Map<unknown, string>();
  const original = db.put.bind(db);
  db.put = (() => Promise.reject(new Error("disk full"))) as Store["put"];
  try {
    const events = await runOnce(
      runnerFor(owners),
      "thread-failing",
      fakeAgent("thread-failing", "owner-1", owners),
    );
    const types = events.map((event) => (event as { type: string }).type);
    assert.ok(types.includes(EventType.RUN_ERROR), "the failure reaches the client");
    assert.ok(
      types.every((type) => type !== EventType.RUN_FINISHED),
      "no completion is reported for a run that was not saved",
    );
    const saved = await db.get<LocalThreadRecord>("owner-1", CHAT_THREADS_KIND, "thread-failing");
    assert.equal(saved, null);
  } finally {
    db.put = original;
  }
});

test("history survives a restart: a fresh runner replays the persisted thread", async () => {
  const owners = new Map<unknown, string>();
  await runOnce(
    runnerFor(owners),
    "thread-restart",
    fakeAgent("thread-restart", "owner-1", owners),
  );
  const record = await db.get<LocalThreadRecord>("owner-1", CHAT_THREADS_KIND, "thread-restart");
  assert.ok(record, "the thread was persisted");
  assert.equal(record.owner, "owner-1");
  assert.deepEqual(
    (record.messages as { id: string }[]).map((message) => message.id),
    ["user-1", "assistant-1"],
  );
  assert.ok((record.events as unknown[]).length > 0);
  // Simulate a process restart: same database, empty in-memory store, new runner.
  ɵGLOBAL_STORE.clear();
  const revived = runnerFor(new Map());
  const replayed = await firstValueFrom(
    revived.connect({ threadId: "thread-restart" }).pipe(toArray()),
  );
  const types = replayed.map((event) => (event as { type: string }).type);
  assert.ok(types.includes(EventType.RUN_STARTED));
  assert.ok(types.includes(EventType.TEXT_MESSAGE_CONTENT));
  assert.ok(types.includes(EventType.RUN_FINISHED));
  assert.deepEqual(
    revived.listThreads().map((thread) => thread.id),
    ["thread-restart"],
  );
});

test("threads are scoped and replayed per owner", async () => {
  const owners = new Map<unknown, string>();
  await runOnce(runnerFor(owners), "thread-a", fakeAgent("thread-a", "owner-a", owners));
  await runOnce(runnerFor(owners), "thread-b", fakeAgent("thread-b", "owner-b", owners));
  assert.equal((await db.list("owner-a", CHAT_THREADS_KIND)).length, 1);
  assert.equal((await db.list("owner-b", CHAT_THREADS_KIND)).length, 1);
  ɵGLOBAL_STORE.clear();
  const runner = runnerFor(new Map());
  const replayed = await firstValueFrom(runner.connect({ threadId: "thread-b" }).pipe(toArray()));
  assert.ok(
    replayed.some((event) => (event as { type: string }).type === EventType.TEXT_MESSAGE_CONTENT),
  );
});

test("clearThreads wipes the durable records as well as memory", async () => {
  const owners = new Map<unknown, string>();
  await runOnce(runnerFor(owners), "thread-clear", fakeAgent("thread-clear", "owner-1", owners));
  const runner = runnerFor(owners);
  await runner.clearThreads();
  assert.equal((await db.list("owner-1", CHAT_THREADS_KIND)).length, 0);
});

test("createThreadProvider selects the backend from config", async () => {
  const owners = new Map<unknown, string>();
  const ownerOf = (agent: unknown) => owners.get(agent);
  const base: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  const intelligence = createThreadProvider(
    { ...base, threadsBackend: "intelligence", intelligenceApiKey: "test-project-key-never-sent" },
    { db, ownerOf },
  );
  assert.equal(intelligence.backend, "intelligence");
  const local = createThreadProvider({ ...base, threadsBackend: "local" }, { db, ownerOf });
  assert.equal(local.backend, "local");
  if (local.backend !== "local") throw new Error("unreachable");
  assert.ok(local.runner instanceof PersistentAgentRunner);
  // A missing backend means the documented default, which still requires a key.
  const defaulted = createThreadProvider(
    { ...base, intelligenceApiKey: "test-project-key-never-sent" },
    { db, ownerOf },
  );
  assert.equal(defaulted.backend, "intelligence");
  assert.throws(
    () => createThreadProvider({ ...base }, { db, ownerOf }),
    /requires CPK_INTELLIGENCE_API_KEY/,
  );
});
