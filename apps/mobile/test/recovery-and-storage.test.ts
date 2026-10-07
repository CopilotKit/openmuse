import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AgentWorkState,
  type AgentWorkStorage,
  type ClaimResponse,
  DEFAULT_TIMING,
  DeviceAgentLoop,
  type DeviceWorkTransport,
  type Lease,
  type LoopTimers,
  nextIdleDelay,
  recoverAgentState,
  type TaskExecutor,
} from "../src/device-agent-loop.ts";

const TIMING = { ...DEFAULT_TIMING, idlePollMs: 10, maxIdlePollMs: 80, minHeartbeatMs: 5 };

/** Let queued promise callbacks run until nothing more is pending. */
async function drain() {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/** A clock the test advances explicitly. `at` is milliseconds since the epoch. */
function fakeClock() {
  let at = 1_000_000;
  let sequence = 0;
  const scheduled = new Map<number, { at: number; fn: () => void }>();
  const timers: LoopTimers = {
    setTimeout(fn, ms) {
      const handle = ++sequence;
      scheduled.set(handle, { at: at + ms, fn });
      return handle;
    },
    clearTimeout(handle) {
      scheduled.delete(handle as number);
    },
    now: () => at,
  };
  return {
    timers,
    get pending() {
      return scheduled.size;
    },
    /** Run every callback due within `ms`, in time order, then settle the microtask queue. */
    async advance(ms: number) {
      const until = at + ms;
      for (;;) {
        const due = [...scheduled.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        const [handle, timer] = due;
        scheduled.delete(handle);
        at = timer.at;
        timer.fn();
        await drain();
      }
      at = until;
      await drain();
    },
  };
}

/** Start the loop and let its first poll fire. */
async function start(
  clock: { advance(ms: number): Promise<void> },
  loop: DeviceAgentLoop,
): Promise<void> {
  loop.start();
  await clock.advance(0);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A lease valid for `ms` from the fake clock's current instant. */
function leaseFor(clock: { timers: LoopTimers }, ms: number): Lease {
  return { id: "lease-1", until: new Date(clock.timers.now() + ms).toISOString() };
}

/** Saved state for a recovered run, with a lease 3 s in the future. */
function savedState(clock: { timers: LoopTimers }): AgentWorkState {
  return {
    taskId: "recovered-task",
    leaseId: "recovered-lease",
    leaseUntil: new Date(clock.timers.now() + 3_000).toISOString(),
    title: "Recovered Task",
  };
}

class FakeStorage implements AgentWorkStorage {
  saves: AgentWorkState[] = [];
  leaseUpdates: string[] = [];
  clearCount = 0;
  save(state: AgentWorkState): void {
    this.saves.push({ ...state });
  }
  updateLease(leaseUntil: string): void {
    this.leaseUpdates.push(leaseUntil);
  }
  clear(): void {
    this.clearCount += 1;
  }
}

// ─── recoverAgentState decision logic ───────────────────────────────

test("recoverAgentState returns noop for null saved state", () => {
  assert.equal(recoverAgentState(null, 1_000_000), "noop");
});

test("recoverAgentState returns requeue for an unparseable lease timestamp", () => {
  const state: AgentWorkState = {
    taskId: "t1",
    leaseId: "l1",
    leaseUntil: "not-a-date",
    title: "T1",
  };
  assert.equal(recoverAgentState(state, 1_000_000), "requeue");
});

test("recoverAgentState returns requeue when the lease has lapsed with zero grace", () => {
  const state: AgentWorkState = {
    taskId: "t1",
    leaseId: "l1",
    leaseUntil: new Date(1_000_000).toISOString(),
    title: "T1",
  };
  assert.equal(recoverAgentState(state, 2_000_000, 0), "requeue");
});

test("recoverAgentState returns resume when the lease is still valid", () => {
  const state: AgentWorkState = {
    taskId: "t1",
    leaseId: "l1",
    leaseUntil: new Date(2_000_000).toISOString(),
    title: "T1",
  };
  assert.equal(recoverAgentState(state, 1_000_000), "resume");
});

test("recoverAgentState returns resume within the grace window", () => {
  const state: AgentWorkState = {
    taskId: "t1",
    leaseId: "l1",
    leaseUntil: new Date(1_990_000).toISOString(),
    title: "T1",
  };
  assert.equal(recoverAgentState(state, 2_000_000, 60_000), "resume");
});

test("recoverAgentState returns requeue beyond the grace window", () => {
  const state: AgentWorkState = {
    taskId: "t1",
    leaseId: "l1",
    leaseUntil: new Date(1_939_999).toISOString(),
    title: "T1",
  };
  assert.equal(recoverAgentState(state, 2_000_000, 60_000), "requeue");
});

// ─── Storage injection ──────────────────────────────────────────────

test("storage.save is called when a task is claimed", async () => {
  const clock = fakeClock();
  const storage = new FakeStorage();
  const gate = deferred();
  const transport: DeviceWorkTransport = {
    async claim(): Promise<ClaimResponse> {
      return { task: { id: "task-1", title: "Summarise" }, lease: leaseFor(clock, 3_000) };
    },
    async heartbeat() {
      return { ok: true, leaseUntil: new Date(clock.timers.now() + 3_000).toISOString() };
    },
    async report() {},
  };
  const execute: TaskExecutor = async () => {
    await gate.promise;
    return { outcome: "succeeded", result: "done" };
  };
  const loop = new DeviceAgentLoop(transport, execute, TIMING, clock.timers, storage);

  await start(clock, loop);
  assert.equal(loop.getSnapshot().phase, "running");
  assert.equal(storage.saves.length, 1, "save should fire once on claim");
  const saved = storage.saves[0];
  assert.ok(saved, "save should have been called");
  assert.equal(saved.taskId, "task-1");
  assert.equal(saved.leaseId, "lease-1");

  gate.resolve();
  await clock.advance(0);
  await loop.shutdown();
});

test("storage.updateLease is called on each heartbeat extension", async () => {
  const clock = fakeClock();
  const storage = new FakeStorage();
  const gate = deferred();
  let beatCount = 0;
  const transport: DeviceWorkTransport = {
    async claim(): Promise<ClaimResponse> {
      return { task: { id: "task-1" }, lease: leaseFor(clock, 3_000) };
    },
    async heartbeat() {
      beatCount += 1;
      return {
        ok: true,
        leaseUntil: new Date(clock.timers.now() + 3_000).toISOString(),
      };
    },
    async report() {},
  };
  const execute: TaskExecutor = async () => {
    await gate.promise;
    return { outcome: "succeeded", result: "done" };
  };
  const loop = new DeviceAgentLoop(transport, execute, TIMING, clock.timers, storage);

  await start(clock, loop);
  // The first beat fires at heartbeatInterval(3000, now, TIMING) = 1000ms.
  await clock.advance(1_000);
  assert.ok(beatCount > 0, "at least one beat should have fired");
  assert.ok(storage.leaseUpdates.length > 0, "updateLease should be called on beat");

  gate.resolve();
  await clock.advance(0);
  await loop.shutdown();
});

test("storage.clear is called when a task finishes", async () => {
  const clock = fakeClock();
  const storage = new FakeStorage();
  const transport: DeviceWorkTransport = {
    async claim(): Promise<ClaimResponse> {
      if (clock.timers.now() < 1_001_000) {
        return { task: { id: "task-1" }, lease: leaseFor(clock, 3_000) };
      }
      return { task: null };
    },
    async heartbeat() {
      return { ok: true, leaseUntil: new Date(clock.timers.now() + 3_000).toISOString() };
    },
    async report() {},
  };
  const execute: TaskExecutor = async () => ({ outcome: "succeeded", result: "done" });
  const loop = new DeviceAgentLoop(transport, execute, TIMING, clock.timers, storage);

  await start(clock, loop);
  assert.equal(storage.saves.length, 1);
  // The execute resolves immediately, so run() → finishRun() → clear().
  await clock.advance(0);
  await drain();
  assert.ok(storage.clearCount > 0, "clear should fire when the run finishes");
  await loop.shutdown();
});

// ─── Recovery flow ──────────────────────────────────────────────────

test("restoreSavedState sets phase to running and starts the heartbeat", async () => {
  const clock = fakeClock();
  const storage = new FakeStorage();
  const state = savedState(clock);
  const transport: DeviceWorkTransport = {
    async claim() {
      return { task: null };
    },
    async heartbeat() {
      return { ok: true, leaseUntil: new Date(clock.timers.now() + 3_000).toISOString() };
    },
    async report() {},
  };
  const gate = deferred();
  const execute: TaskExecutor = async () => {
    await gate.promise;
    return { outcome: "succeeded", result: "done" };
  };
  const loop = new DeviceAgentLoop(transport, execute, TIMING, clock.timers, storage);

  loop.restoreSavedState(state);

  assert.equal(loop.getSnapshot().phase, "running");
  assert.deepEqual(loop.getSnapshot().task, {
    id: "recovered-task",
    title: "Recovered Task",
  });
  assert.equal(storage.saves.length, 1, "restoreSavedState should persist via storage.save");
  const restoredSave = storage.saves[0];
  assert.ok(restoredSave, "save should have been called during restore");
  assert.equal(restoredSave.taskId, "recovered-task");

  gate.resolve();
  await clock.advance(0);
  await loop.shutdown();
});

test("claimAndRun does not claim while a restored task is active", async () => {
  const clock = fakeClock();
  const storage = new FakeStorage();
  let claims = 0;
  const transport: DeviceWorkTransport = {
    async claim() {
      claims += 1;
      return { task: null };
    },
    async heartbeat() {
      return { ok: true, leaseUntil: new Date(clock.timers.now() + 3_000).toISOString() };
    },
    async report() {},
  };
  const gate = deferred();
  const execute: TaskExecutor = async () => {
    await gate.promise;
    return { outcome: "succeeded", result: "done" };
  };
  const loop = new DeviceAgentLoop(transport, execute, TIMING, clock.timers, storage);

  loop.restoreSavedState(savedState(clock));
  // start() is a no-op when already enabled — only the heartbeat is running.
  loop.start();
  await clock.advance(0);
  // Even after a poll fires, claim() must not run because a task is in hand.
  await clock.advance(100);
  assert.equal(claims, 0, "should not claim while a restored task is active");

  gate.resolve();
  await clock.advance(0);
  await loop.shutdown();
});

test("finishRun re-arms the poll after a restored lease is lost", async () => {
  const clock = fakeClock();
  const storage = new FakeStorage();
  let claims = 0;
  let beats = 0;
  const transport: DeviceWorkTransport = {
    async claim() {
      claims += 1;
      if (claims > 1) return { task: null };
      return { task: { id: "task-2" }, lease: leaseFor(clock, 3_000) };
    },
    async heartbeat() {
      beats += 1;
      if (beats > 1) return { ok: false, leaseUntil: null };
      return { ok: true, leaseUntil: new Date(clock.timers.now() + 3_000).toISOString() };
    },
    async report() {},
  };
  // task-2 gets an immediate executor — it finishes fast, that's fine here.
  const execute: TaskExecutor = async () => ({ outcome: "succeeded", result: "done" });
  const loop = new DeviceAgentLoop(transport, execute, TIMING, clock.timers, storage);

  loop.restoreSavedState(savedState(clock));
  loop.start();

  // First beat: ok=true, extends the lease.
  await clock.advance(1_000);
  assert.equal(beats, 1);
  assert.ok(storage.leaseUpdates.length > 0, "updateLease called on beat");

  // Second beat: lease lost → finishRun → storage.clear + poll re-armed.
  await clock.advance(1_000);
  assert.equal(beats, 2);
  assert.ok(storage.clearCount > 0, "clear called when lease is lost");
  assert.equal(loop.getSnapshot().task, null, "no active task after finishRun");

  // The poll should fire and claim a new task.
  await clock.advance(10);
  assert.ok(claims > 0, "should claim new work after the restored task finished");
  await loop.shutdown();
});

test("noopStorage lets the loop run without throwing", async () => {
  const clock = fakeClock();
  const transport: DeviceWorkTransport = {
    async claim() {
      return { task: { id: "t", title: "T" }, lease: leaseFor(clock, 3_000) };
    },
    async heartbeat() {
      return { ok: true, leaseUntil: new Date(clock.timers.now() + 3_000).toISOString() };
    },
    async report() {},
  };
  const gate = deferred();
  const execute: TaskExecutor = async () => {
    await gate.promise;
    return { outcome: "succeeded", result: "done" };
  };
  // Fifth arg omitted → uses noopStorage default.
  const loop = new DeviceAgentLoop(transport, execute, TIMING, clock.timers);

  await start(clock, loop);
  assert.equal(loop.getSnapshot().phase, "running");
  assert.ok("completed" in loop.getSnapshot());

  gate.resolve();
  await clock.advance(0);
  await loop.shutdown();
});

test("nextIdleDelay doubles and caps at maxIdlePollMs", () => {
  assert.equal(nextIdleDelay(0, TIMING), 10);
  assert.equal(nextIdleDelay(1, TIMING), 20);
  assert.equal(nextIdleDelay(2, TIMING), 40);
  assert.equal(nextIdleDelay(9, TIMING), TIMING.maxIdlePollMs);
});
