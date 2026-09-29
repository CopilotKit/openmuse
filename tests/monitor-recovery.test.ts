import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { AgentNotification, AgentTask, Monitor } from "../packages/domain/src/agent.ts";

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string, token: string;
const owner = "local-user";
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const request = (path: string, body?: unknown) =>
  server.app.request(`/api/agent${path}`, {
    headers: headers(),
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
async function read<T>(path: string, body?: unknown, status = 200): Promise<T> {
  const response = await request(path, body);
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
type CompareAndSwap = Store["compareAndSwap"];
// Replaces the next tasks CAS that matches `when` with a lost write (null), then restores.
function loseNextTaskWrite(when: (patch: Record<string, unknown>) => boolean) {
  const original: CompareAndSwap = db.compareAndSwap.bind(db);
  let lost = 0;
  db.compareAndSwap = (async (o, kind, id, expected, patch) => {
    if (!lost && kind === "tasks" && when(patch)) {
      lost++;
      return null;
    }
    return original(o, kind, id, expected, patch);
  }) as CompareAndSwap;
  return {
    get lost() {
      return lost;
    },
    restore() {
      db.compareAndSwap = original;
    },
  };
}
async function createMonitor(title: string) {
  return read<Monitor>(
    "/monitors",
    { title, url: "sample://availability", condition: "change", intervalMinutes: 1 },
    201,
  );
}
// Makes the sample page throw until the returned restore() is called.
function failPage() {
  const originalGet = db.get.bind(db);
  db.get = (async (o: string, kind: string, id: string) => {
    if (kind === "sample-pages") throw new Error("Page unavailable");
    return originalGet(o, kind, id);
  }) as Store["get"];
  return () => {
    db.get = originalGet;
  };
}
// Failures back off into the future; make the scheduled retry due now.
const makeDue = (taskId: string) =>
  db.compareAndSwap(
    owner,
    "tasks",
    taskId,
    { status: "scheduled" },
    { nextRunAt: new Date(0).toISOString() },
  );
const maintain = () => (server.agent as unknown as { maintain(): Promise<void> }).maintain();

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-monitor-recovery-"));
  db = await createStore({ dataDir: join(directory, "db") });
  server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  });
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

test("a page change stays alertable when the task outcome is lost after the baseline moves", async () => {
  await read("/sample-page", { text: "No tables available" });
  const monitor = await createMonitor("Recovery availability");
  const notifications = async () =>
    (await read<AgentNotification[]>("/notifications")).filter(
      (item) => item.taskId === monitor.taskId,
    );
  await server.agent.worker.tick();
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "scheduled");
  assert.equal((await notifications()).length, 0);

  await read("/sample-page", { text: "One table at 7 pm" });
  await read(`/monitors/${monitor.id}/control`, { action: "check" });
  // The worker's final checkpoint for this run loses its lease after observe() committed
  // the new monitor baseline, as if the process stopped or another worker took over.
  const fault = loseNextTaskWrite(
    (patch) => patch.status === "scheduled" && patch.leaseId === null,
  );
  try {
    await server.agent.worker.tick();
  } finally {
    fault.restore();
  }
  assert.equal(fault.lost, 1);
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "queued");

  // Recovery: the requeued run executes, then a later scheduled check runs as well.
  await server.agent.worker.tick();
  await read(`/monitors/${monitor.id}/control`, { action: "check" });
  await server.agent.worker.tick();

  const found = await notifications();
  assert.equal(found.length, 1, "the No tables -> One table change should notify exactly once");
  assert.match(found[0].body, /One table at 7 pm/);
});

test("resuming a monitor fails without activating it when the task transition does not commit", async () => {
  await read("/sample-page", { text: "No tables available" });
  const monitor = await createMonitor("Resume availability");
  await server.agent.worker.tick();
  assert.equal(
    (await read<Monitor>(`/monitors/${monitor.id}/control`, { action: "pause" })).status,
    "paused",
  );
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "paused");

  // Another writer changes the task between the read and the CAS in controlMonitor().
  const fault = loseNextTaskWrite((patch) => patch.status === "queued");
  let response: Response;
  try {
    response = await request(`/monitors/${monitor.id}/control`, { action: "resume" });
  } finally {
    fault.restore();
  }
  assert.equal(fault.lost, 1);
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "paused");
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "paused");
});

test("the paused alert is delivered when the final failure outcome is lost", async () => {
  await read("/sample-page", { text: "No tables available" });
  const monitor = await createMonitor("Failing availability");
  await server.agent.worker.tick();
  const restorePage = failPage();
  try {
    for (let failure = 1; failure < 5; failure++) {
      await makeDue(monitor.taskId);
      await server.agent.worker.tick();
      const task = await db.get<AgentTask>(owner, "tasks", monitor.taskId);
      assert.equal(task?.status, "scheduled");
      assert.equal(task?.state.failures, failure);
    }
    await makeDue(monitor.taskId);
    // The fifth failure's paused outcome is lost after the run already recorded the failure.
    const fault = loseNextTaskWrite((patch) => patch.status === "paused" && patch.leaseId === null);
    try {
      await server.agent.worker.tick();
    } finally {
      fault.restore();
    }
    assert.equal(fault.lost, 1);
    assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "queued");
    await server.agent.worker.tick();
  } finally {
    restorePage();
  }

  const task = await db.get<AgentTask>(owner, "tasks", monitor.taskId);
  assert.equal(task?.status, "paused");
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "paused");
  const pausedId = createHash("sha256")
    .update(`watch-error:${monitor.taskId}:1:paused`)
    .digest("hex");
  const paused = (await read<AgentNotification[]>("/notifications")).filter(
    (item) => item.id === pausedId,
  );
  assert.equal(paused.length, 1, "the watch paused alert should be delivered exactly once");

  const resumed = await read<Monitor>(`/monitors/${monitor.id}/control`, { action: "resume" });
  assert.equal(resumed.status, "active");
  assert.equal(resumed.error, null);
  const requeued = await db.get<AgentTask>(owner, "tasks", monitor.taskId);
  assert.equal(requeued?.status, "queued");
  assert.equal(requeued?.state.failures, 0);
  await server.agent.worker.tick();
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "scheduled");
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "active");
});

test("maintenance finishes a resume that stopped after the monitor was activated", async () => {
  await read("/sample-page", { text: "No tables available" });
  const monitor = await createMonitor("Interrupted resume");
  await server.agent.worker.tick();
  await read(`/monitors/${monitor.id}/control`, { action: "pause" });
  const paused = await db.get<AgentTask>(owner, "tasks", monitor.taskId);
  assert.equal(paused?.status, "paused");

  // The durable state left when a resume stops after activating the monitor, before queueing.
  await db.compareAndSwap(
    owner,
    "tasks",
    monitor.taskId,
    { status: "paused" },
    { state: { ...paused?.state, resumingMonitor: true } },
  );
  const current = await db.get<Monitor>(owner, "monitors", monitor.id);
  assert.ok(current);
  await db.put(owner, "monitors", { ...current, status: "active" });

  await maintain();
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "queued");
  await server.agent.worker.tick();
  const task = await db.get<AgentTask>(owner, "tasks", monitor.taskId);
  assert.equal(task?.status, "scheduled");
  assert.equal(task?.state.resumingMonitor, false);
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "active");
});

test("checking a watch retries once when its run finishes during the request", async () => {
  await read("/sample-page", { text: "No tables available" });
  const monitor = await createMonitor("Check during run");
  await server.agent.worker.tick();
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "scheduled");

  const fault = loseNextTaskWrite((patch) => patch.status === "queued");
  let response: Response;
  try {
    response = await request(`/monitors/${monitor.id}/control`, { action: "check" });
  } finally {
    fault.restore();
  }
  assert.equal(fault.lost, 1);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "queued");
});

test("a resume during outcome publication is not paused again by the failure reconcile", async () => {
  await read("/sample-page", { text: "No tables available" });
  const monitor = await createMonitor("Resume during publication");
  await server.agent.worker.tick();
  // A failure pause has committed on the task, but the monitor has not been paused yet.
  const task = await db.get<AgentTask>(owner, "tasks", monitor.taskId);
  assert.ok(task);
  await db.compareAndSwap(
    owner,
    "tasks",
    task.id,
    { status: "scheduled" },
    {
      status: "paused",
      error: "Page unavailable",
      state: {
        ...task.state,
        failures: 5,
        notice: { title: "Watch needs attention", body: "Page unavailable", key: "race-paused" },
      },
    },
  );
  await db.compareAndSwap(
    owner,
    "monitors",
    monitor.id,
    { status: "active" },
    { error: "Page unavailable" },
  );

  // The user resumes while publishOutcome() is sending the paused notice.
  const originalInsert = db.insertIfAbsent.bind(db);
  let resuming: Promise<Response> | undefined;
  db.insertIfAbsent = (async (o: string, kind: string, value: { id: string }) => {
    if (!resuming && kind === "notifications") {
      resuming = Promise.resolve(request(`/monitors/${monitor.id}/control`, { action: "resume" }));
      await resuming;
    }
    return originalInsert(o, kind, value);
  }) as Store["insertIfAbsent"];
  try {
    await (
      server.agent as unknown as { publishOutcome(o: string, t: AgentTask): Promise<void> }
    ).publishOutcome(owner, task);
  } finally {
    db.insertIfAbsent = originalInsert;
  }
  const resumed = await resuming;
  assert.equal(resumed?.status, 200, await resumed?.clone().text());
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "active");
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "queued");
});

test("a resume finished by maintenance during the request still succeeds", async () => {
  await read("/sample-page", { text: "No tables available" });
  const monitor = await createMonitor("Resume with maintenance");
  await server.agent.worker.tick();
  await read(`/monitors/${monitor.id}/control`, { action: "pause" });

  // Maintenance runs right after the request activates the monitor, and queues the task first.
  const originalPut = db.put.bind(db);
  const originalCas: CompareAndSwap = db.compareAndSwap.bind(db);
  let fired = false;
  const afterActivation = async (kind: string, status: unknown) => {
    if (!fired && kind === "monitors" && status === "active") {
      fired = true;
      await maintain();
    }
  };
  db.put = (async (o: string, kind: string, value: { id: string; status?: string }) => {
    const saved = await originalPut(o, kind, value);
    await afterActivation(kind, value.status);
    return saved;
  }) as Store["put"];
  db.compareAndSwap = (async (o, kind, id, expected, patch) => {
    const saved = await originalCas(o, kind, id, expected, patch);
    if (saved) await afterActivation(kind, patch.status);
    return saved;
  }) as CompareAndSwap;
  let response: Response;
  try {
    response = await request(`/monitors/${monitor.id}/control`, { action: "resume" });
  } finally {
    db.put = originalPut;
    db.compareAndSwap = originalCas;
  }
  assert.ok(fired);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "active");
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "queued");
});

test("two overlapping resume requests both leave the watch active", async () => {
  await read("/sample-page", { text: "No tables available" });
  const monitor = await createMonitor("Double resume");
  await server.agent.worker.tick();
  await read(`/monitors/${monitor.id}/control`, { action: "pause" });

  // A second resume runs to completion right after the first one marks the task.
  const originalCas: CompareAndSwap = db.compareAndSwap.bind(db);
  let second: Promise<Response> | undefined;
  db.compareAndSwap = (async (o, kind, id, expected, patch) => {
    const saved = await originalCas(o, kind, id, expected, patch);
    const state = patch.state as { resumingMonitor?: boolean } | undefined;
    if (!second && saved && kind === "tasks" && state?.resumingMonitor === true) {
      second = Promise.resolve(request(`/monitors/${monitor.id}/control`, { action: "resume" }));
      await second;
    }
    return saved;
  }) as CompareAndSwap;
  let first: Response;
  try {
    first = await request(`/monitors/${monitor.id}/control`, { action: "resume" });
  } finally {
    db.compareAndSwap = originalCas;
  }
  const secondResponse = await second;
  assert.equal(secondResponse?.status, 200, await secondResponse?.clone().text());
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "active");
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "queued");
});

test("a leftover resume marker does not keep a failing watch running", async () => {
  await read("/sample-page", { text: "No tables available" });
  const monitor = await createMonitor("Leftover marker");
  await server.agent.worker.tick();
  // The task is paused directly, then a resume stops right after marking it.
  await read(`/tasks/${monitor.taskId}/control`, { action: "pause" });
  const paused = await db.get<AgentTask>(owner, "tasks", monitor.taskId);
  await db.compareAndSwap(
    owner,
    "tasks",
    monitor.taskId,
    { status: "paused" },
    { state: { ...paused?.state, resumingMonitor: true } },
  );
  await read(`/tasks/${monitor.taskId}/control`, { action: "resume" });

  const restorePage = failPage();
  try {
    await server.agent.worker.tick();
    for (let failure = 2; failure <= 5; failure++) {
      await makeDue(monitor.taskId);
      await server.agent.worker.tick();
    }
  } finally {
    restorePage();
  }
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "paused");
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "paused");
  await maintain();
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "paused");
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "paused");
});

test("a leftover resume marker does not undo a later task pause", async () => {
  await read("/sample-page", { text: "No tables available" });
  const monitor = await createMonitor("Leftover marker pause");
  await server.agent.worker.tick();
  await read(`/tasks/${monitor.taskId}/control`, { action: "pause" });
  const paused = await db.get<AgentTask>(owner, "tasks", monitor.taskId);
  await db.compareAndSwap(
    owner,
    "tasks",
    monitor.taskId,
    { status: "paused" },
    { state: { ...paused?.state, resumingMonitor: true } },
  );
  await read(`/tasks/${monitor.taskId}/control`, { action: "resume" });
  await server.agent.worker.tick();
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "scheduled");

  // A later task pause stops after pausing the task, before it reaches the monitor.
  await db.compareAndSwap(
    owner,
    "tasks",
    monitor.taskId,
    { status: "scheduled" },
    { status: "paused", leaseId: null, leaseUntil: null },
  );
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "active");
  await maintain();
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "paused");
});

test("a stop during a resume keeps the watch stopped", async () => {
  await read("/sample-page", { text: "No tables available" });
  const monitor = await createMonitor("Stop during resume");
  await server.agent.worker.tick();
  await read(`/monitors/${monitor.id}/control`, { action: "pause" });

  // The user stops the watch right after the resume marks the task.
  const originalCas: CompareAndSwap = db.compareAndSwap.bind(db);
  let stopping: Promise<Response> | undefined;
  db.compareAndSwap = (async (o, kind, id, expected, patch) => {
    const saved = await originalCas(o, kind, id, expected, patch);
    const state = patch.state as { resumingMonitor?: boolean } | undefined;
    if (!stopping && saved && kind === "tasks" && state?.resumingMonitor === true) {
      stopping = Promise.resolve(request(`/monitors/${monitor.id}/control`, { action: "stop" }));
      await stopping;
    }
    return saved;
  }) as CompareAndSwap;
  let response: Response;
  try {
    response = await request(`/monitors/${monitor.id}/control`, { action: "resume" });
  } finally {
    db.compareAndSwap = originalCas;
  }
  assert.equal((await stopping)?.status, 200);
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "stopped");
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "cancelled");
});

test("a resume from the task screen is not paused again by a stale failure reconcile", async () => {
  await read("/sample-page", { text: "No tables available" });
  const monitor = await createMonitor("Task screen resume");
  await server.agent.worker.tick();
  const restorePage = failPage();
  try {
    for (let failure = 1; failure <= 5; failure++) {
      await makeDue(monitor.taskId);
      await server.agent.worker.tick();
    }
  } finally {
    restorePage();
  }
  const stale = await db.get<AgentTask>(owner, "tasks", monitor.taskId);
  assert.equal(stale?.status, "paused");
  assert.ok(stale?.error);
  await read(`/tasks/${monitor.taskId}/control`, { action: "resume" });

  // A failure reconcile that read the paused task before the resume finishes afterwards.
  const originalGet = db.get.bind(db);
  let served = false;
  db.get = (async (o: string, kind: string, id: string) => {
    if (!served && kind === "tasks" && id === monitor.taskId) {
      served = true;
      return stale;
    }
    return originalGet(o, kind, id);
  }) as Store["get"];
  try {
    await (
      server.agent as unknown as { publishOutcome(o: string, t: AgentTask): Promise<void> }
    ).publishOutcome(owner, stale);
  } finally {
    db.get = originalGet;
  }
  assert.ok(served);
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "active");
  await server.agent.worker.tick();
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "scheduled");
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "active");
});

test("a stop during a check keeps the watch stopped", async () => {
  await read("/sample-page", { text: "No tables available" });
  const monitor = await createMonitor("Stop during check");
  await server.agent.worker.tick();
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "scheduled");

  // The user stops the watch right before the check reactivates the monitor.
  const originalPut = db.put.bind(db);
  const originalCas: CompareAndSwap = db.compareAndSwap.bind(db);
  let stopping: Response | undefined;
  const beforeActivation = async (kind: string, status: unknown) => {
    if (!stopping && kind === "monitors" && status === "active") {
      db.put = originalPut;
      db.compareAndSwap = originalCas;
      stopping = await request(`/monitors/${monitor.id}/control`, { action: "stop" });
    }
  };
  db.put = (async (o: string, kind: string, value: { id: string; status?: string }) => {
    await beforeActivation(kind, value.status);
    return originalPut(o, kind, value);
  }) as Store["put"];
  db.compareAndSwap = (async (o, kind, id, expected, patch) => {
    await beforeActivation(kind, patch.status);
    return originalCas(o, kind, id, expected, patch);
  }) as CompareAndSwap;
  let response: Response;
  try {
    response = await request(`/monitors/${monitor.id}/control`, { action: "check" });
  } finally {
    db.put = originalPut;
    db.compareAndSwap = originalCas;
  }
  assert.equal(stopping?.status, 200, await stopping?.clone().text());
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "stopped");
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "cancelled");
});

test("a check does not revive a task cancelled from the task screen", async () => {
  await read("/sample-page", { text: "No tables available" });
  const monitor = await createMonitor("Cancel during check");
  await server.agent.worker.tick();

  // The check arrives after the task is cancelled, before the cancel reaches the monitor.
  const originalCas: CompareAndSwap = db.compareAndSwap.bind(db);
  let checking: Response | undefined;
  db.compareAndSwap = (async (o, kind, id, expected, patch) => {
    if (!checking && kind === "monitors" && patch.status === "stopped") {
      db.compareAndSwap = originalCas;
      checking = await request(`/monitors/${monitor.id}/control`, { action: "check" });
    }
    return originalCas(o, kind, id, expected, patch);
  }) as CompareAndSwap;
  try {
    await read(`/tasks/${monitor.taskId}/control`, { action: "cancel" });
  } finally {
    db.compareAndSwap = originalCas;
  }
  assert.equal(checking?.status, 409, await checking?.clone().text());
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "stopped");
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "cancelled");
});

test("a check keeps the baseline from a run that finishes during the request", async () => {
  await read("/sample-page", { text: "No tables available" });
  const monitor = await createMonitor("Baseline during check");
  await server.agent.worker.tick();
  const before = await db.get<AgentTask>(owner, "tasks", monitor.taskId);
  assert.equal(before?.status, "scheduled");
  await read("/sample-page", { text: "One table at 7 pm" });

  // A whole scheduled run completes between the check's read and its requeue.
  const originalCas: CompareAndSwap = db.compareAndSwap.bind(db);
  let ran: AgentTask | null = null;
  db.compareAndSwap = (async (o, kind, id, expected, patch) => {
    if (!ran && kind === "tasks" && patch.status === "queued" && expected.status === "scheduled") {
      db.compareAndSwap = originalCas;
      await makeDue(monitor.taskId);
      await server.agent.worker.tick();
      ran = await db.get<AgentTask>(owner, "tasks", monitor.taskId);
    }
    return originalCas(o, kind, id, expected, patch);
  }) as CompareAndSwap;
  try {
    await read(`/monitors/${monitor.id}/control`, { action: "check" });
  } finally {
    db.compareAndSwap = originalCas;
  }
  const finished = ran as AgentTask | null;
  const afterRun = finished?.state.lastHash;
  assert.equal(finished?.status, "scheduled");
  assert.ok(afterRun);
  assert.notEqual(afterRun, before?.state.lastHash);
  const task = await db.get<AgentTask>(owner, "tasks", monitor.taskId);
  assert.equal(task?.status, "queued");
  assert.equal(task?.state.lastHash, afterRun);
});
