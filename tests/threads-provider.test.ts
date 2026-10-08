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

/**
 * A scripted agent that mimics the runtime's per-request cloning: `clone()`
 * returns a NEW object, so owner lookups keyed on the original instance miss.
 * Mirrors ConversationAgent, which carries its owner and preserves it in clone().
 */
function fakeAgent(
  threadId: string,
  owner: string,
  options: { fail?: boolean; runId?: string } = {},
) {
  const agent = {
    agentId: "default",
    owner,
    messages: [
      { id: "user-1", role: "user", content: "Hello" },
      { id: "assistant-1", role: "assistant", content: "Hi there" },
    ],
    clone() {
      return { ...this, messages: [...this.messages] };
    },
    async runAgent(
      _input: unknown,
      callbacks: {
        onEvent: (payload: { event: unknown }) => void;
        onNewMessage: (payload: { message: unknown }) => void;
      },
    ) {
      if (options.fail) throw new Error("model provider exploded");
      callbacks.onEvent({ event: { type: EventType.RUN_STARTED, threadId, runId: "run-1" } });
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
  return agent as never;
}

/** Owner resolution that survives cloning: read the agent's own owner first. */
const ownerOf = (agent: unknown): string | undefined => {
  if (!agent || typeof agent !== "object" || !("owner" in agent)) return undefined;
  const owner = (agent as { owner?: unknown }).owner;
  return typeof owner === "string" ? owner : undefined;
};

/** The runtime hands the runner a per-request CLONE; mimic that at call sites. */
function cloneOf(agent: never): never {
  return (agent as unknown as { clone(): unknown }).clone() as never;
}

function runnerFor() {
  return new PersistentAgentRunner(db, ownerOf);
}

async function runOnce(
  runner: PersistentAgentRunner,
  threadId: string,
  agent: never,
  runId = "run-1",
) {
  return firstValueFrom(
    runner
      .run({ threadId, agent, input: { threadId, runId, messages: [] } } as never)
      .pipe(toArray()),
  );
}

test("the pinned runtime version still matches the store contract this runner relies on", () => {
  assert.ok(THREADS_CONTRACT_REF.includes(VERSION));
});

test("RUN_FINISHED is held until the snapshot write completes", async () => {
  const order: string[] = [];
  const original = db.put.bind(db);
  db.put = ((owner: string, kind: string, value: { id: string }) => {
    order.push("put");
    return new Promise((resolve) => setTimeout(resolve, 40)).then(() =>
      original(owner, kind, value),
    );
  }) as Store["put"];
  try {
    const events = await runOnce(runnerFor(), "thread-gated", fakeAgent("thread-gated", "owner-1"));
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
  const original = db.put.bind(db);
  db.put = (() => Promise.reject(new Error("disk full"))) as Store["put"];
  try {
    const events = await runOnce(
      runnerFor(),
      "thread-failing",
      fakeAgent("thread-failing", "owner-1"),
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
  // Pass the CLONE, exactly like the runtime does after cloneAgentForRequest.
  const original = fakeAgent("thread-restart", "owner-1");
  await runOnce(runnerFor(), "thread-restart", cloneOf(original));
  const record = await db.get<LocalThreadRecord>("owner-1", CHAT_THREADS_KIND, "thread-restart");
  assert.ok(record, "the thread was persisted");
  assert.equal(record.owner, "owner-1");
  assert.deepEqual(
    (record.messages as { id: string }[]).map((message) => message.id),
    ["user-1", "assistant-1"],
  );
  assert.equal(record.runs.length, 1);
  assert.ok((record.runs[0].events as unknown[]).length > 0);
  // Simulate a process restart: same database, empty in-memory store, new runner.
  ɵGLOBAL_STORE.clear();
  const revived = runnerFor();
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
  await runOnce(runnerFor(), "thread-a", fakeAgent("thread-a", "owner-a"));
  await runOnce(runnerFor(), "thread-b", fakeAgent("thread-b", "owner-b"));
  assert.equal((await db.list("owner-a", CHAT_THREADS_KIND)).length, 1);
  assert.equal((await db.list("owner-b", CHAT_THREADS_KIND)).length, 1);
  ɵGLOBAL_STORE.clear();
  const runner = runnerFor();
  const replayed = await firstValueFrom(runner.connect({ threadId: "thread-b" }).pipe(toArray()));
  assert.ok(
    replayed.some((event) => (event as { type: string }).type === EventType.TEXT_MESSAGE_CONTENT),
  );
});

test("a failed run still terminates the stream cleanly", async () => {
  const events = await runOnce(
    runnerFor(),
    "thread-failed-run",
    fakeAgent("thread-failed-run", "owner-1", { fail: true }),
  );
  const types = events.map((event) => (event as { type: string }).type);
  assert.ok(types.includes(EventType.RUN_ERROR), "the run error is delivered");
  assert.ok(
    types.every((type) => type !== EventType.RUN_FINISHED),
    "a failed run never reports completion",
  );
  // firstValueFrom resolved, so the stream completed — no client-side hang.
  const record = await db.get<LocalThreadRecord>("owner-1", CHAT_THREADS_KIND, "thread-failed-run");
  assert.equal(record, null, "nothing is stored for a run that produced no events");
});

test("a concurrent run on one thread errors instead of hanging", async () => {
  // Gate the first run inside runAgent so it stays in flight while the second
  // run arrives — deterministic ordering for the "already running" rejection.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stalled = {
    agentId: "default",
    owner: "owner-1",
    messages: [],
    async runAgent(
      _input: unknown,
      callbacks: {
        onEvent: (payload: { event: unknown }) => void;
        onNewMessage: (payload: { message: unknown }) => void;
      },
    ) {
      callbacks.onEvent({
        event: { type: EventType.RUN_STARTED, threadId: "thread-busy", runId: "run-1" },
      });
      await gate;
      callbacks.onEvent({ event: { type: EventType.RUN_FINISHED } });
    },
  } as never;
  const runner = runnerFor();
  const first = firstValueFrom(
    runner
      .run({
        threadId: "thread-busy",
        agent: stalled,
        input: { threadId: "thread-busy", runId: "run-1", messages: [] },
      } as never)
      .pipe(toArray()),
  );
  // Give the first run a macrotask to reach its in-flight state.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(
    firstValueFrom(
      runner
        .run({
          threadId: "thread-busy",
          agent: fakeAgent("thread-busy", "owner-1"),
          input: { threadId: "thread-busy", runId: "run-2", messages: [] },
        } as never)
        .pipe(toArray()),
    ),
    /Thread already running/,
  );
  release();
  await first;
});

test("memory eviction does not truncate the persisted conversation", async () => {
  const threadId = "thread-evict";
  for (let run = 1; run <= 3; run++) {
    const original = fakeAgent(threadId, "owner-1");
    await runOnce(runnerFor(), threadId, cloneOf(original), `run-${run}`);
  }
  const before = await db.get<LocalThreadRecord>("owner-1", CHAT_THREADS_KIND, threadId);
  assert.ok(before);
  assert.equal(before.runs.length, 3, "three runs are stored");
  // Simulate the in-memory run cap dropping old runs after a fourth run starts.
  const store = ɵGLOBAL_STORE.peek(threadId);
  assert.ok(store);
  store.historicRuns.splice(0, 2);
  const fourth = fakeAgent(threadId, "owner-1");
  await runOnce(runnerFor(), threadId, cloneOf(fourth), "run-4");
  const after = await db.get<LocalThreadRecord>("owner-1", CHAT_THREADS_KIND, threadId);
  assert.ok(after);
  assert.deepEqual(
    after.runs.map((run) => run.runId),
    ["run-1", "run-2", "run-3", "run-4"],
    "evicted runs survive in the durable record",
  );
});

test("v1 records with thread-level events migrate on read", async () => {
  const now = new Date().toISOString();
  await db.put("owner-1", CHAT_THREADS_KIND, {
    id: "thread-legacy",
    owner: "owner-1",
    agentId: "default",
    name: null,
    archived: false,
    createdAt: now,
    updatedAt: now,
    messages: [],
    events: [{ type: EventType.RUN_STARTED }],
  });
  ɵGLOBAL_STORE.clear();
  const replayed = await firstValueFrom(
    runnerFor().connect({ threadId: "thread-legacy" }).pipe(toArray()),
  );
  assert.ok(
    replayed.some((event) => (event as { type: string }).type === EventType.RUN_STARTED),
    "legacy thread-level events still replay",
  );
});

test("clearThreads wipes the durable records as well as memory", async () => {
  await runOnce(runnerFor(), "thread-clear", fakeAgent("thread-clear", "owner-1"));
  const runner = runnerFor();
  await runner.clearThreads();
  assert.equal((await db.list("owner-1", CHAT_THREADS_KIND)).length, 0);
});

test("createThreadProvider selects the backend from config", async () => {
  const owners = new Map<unknown, string>();
  const weakOwnerOf = (agent: unknown) => owners.get(agent);
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
    { db, ownerOf: weakOwnerOf },
  );
  assert.equal(intelligence.backend, "intelligence");
  const local = createThreadProvider(
    { ...base, threadsBackend: "local" },
    {
      db,
      ownerOf: weakOwnerOf,
    },
  );
  assert.equal(local.backend, "local");
  if (local.backend !== "local") throw new Error("unreachable");
  assert.ok(local.runner instanceof PersistentAgentRunner);
  // A missing backend means the documented default, which still requires a key.
  const defaulted = createThreadProvider(
    { ...base, intelligenceApiKey: "test-project-key-never-sent" },
    { db, ownerOf: weakOwnerOf },
  );
  assert.equal(defaulted.backend, "intelligence");
  assert.throws(
    () => createThreadProvider({ ...base }, { db, ownerOf: weakOwnerOf }),
    /requires CPK_INTELLIGENCE_API_KEY/,
  );
});
