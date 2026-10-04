import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ClaimResponse,
  DEFAULT_TIMING,
  DeviceAgentLoop,
  type DeviceWorkTransport,
  heartbeatInterval,
  type Lease,
  type LoopTimers,
  nextIdleDelay,
  type TaskExecutor,
  type WorkOutcome,
} from "../src/device-agent-loop.ts";

/**
 * The device work loop, driven by a fake clock.
 *
 * `tests/device-work-api.test.ts` proves the server half of the protocol; this
 * proves the half that actually holds a lease. What matters here is the
 * behaviour *around* a lease rather than the happy path: a heartbeat that comes
 * back false, a lease lost mid-run, a report the server rejects as stale, and an
 * app that goes to the background. None of those can be observed by waiting on a
 * real timer, so time here is a queue the test drains by hand.
 */

const TIMING = { ...DEFAULT_TIMING, idlePollMs: 10, maxIdlePollMs: 80, minHeartbeatMs: 5 };

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

/**
 * Start the loop and let its first poll fire.
 *
 * A bare `drain()` is not enough: the first claim sits behind a `setTimeout`,
 * and this clock only runs those when the test advances it. Without this helper
 * every test would assert against a loop that had not claimed anything.
 */
async function start(clock: { advance(ms: number): Promise<void> }, loop: DeviceAgentLoop) {
  loop.start();
  await clock.advance(0);
}

/** Let queued promise callbacks run until nothing more is pending. */
async function drain() {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

interface Recorded {
  claims: number;
  heartbeats: { taskId: string; leaseId: string }[];
  reports: { taskId: string; leaseId: string; outcome: WorkOutcome; result: string }[];
}

function recorder(): Recorded {
  return { claims: 0, heartbeats: [], reports: [] };
}

/** A lease valid for `ms` from the fake clock's current instant. */
function leaseFor(clock: { timers: LoopTimers }, ms: number): Lease {
  return { id: "lease-1", until: new Date(clock.timers.now() + ms).toISOString() };
}

test("a claimed task runs, heartbeats while it works, and reports success", async () => {
  const clock = fakeClock();
  const log = recorder();
  const gate = deferred();
  const transport: DeviceWorkTransport = {
    async claim() {
      log.claims += 1;
      if (log.claims > 1) return { task: null };
      return { task: { id: "task-1", title: "Summarise my notes" }, lease: leaseFor(clock, 3_000) };
    },
    async heartbeat(taskId, leaseId) {
      log.heartbeats.push({ taskId, leaseId });
      return { ok: true, leaseUntil: new Date(clock.timers.now() + 3_000).toISOString() };
    },
    async report(taskId, leaseId, outcome, result) {
      log.reports.push({ taskId, leaseId, outcome, result });
    },
  };
  const execute: TaskExecutor = async () => {
    await gate.promise;
    return { outcome: "succeeded", result: "done" };
  };
  const loop = new DeviceAgentLoop(transport, execute, TIMING, clock.timers);
  const seen: string[] = [];
  loop.subscribe(() => {
    const snapshot = loop.getSnapshot();
    if (snapshot.task) seen.push(snapshot.task.id);
  });

  await start(clock, loop);
  assert.equal(loop.getSnapshot().phase, "running");
  assert.deepEqual(loop.getSnapshot().task, { id: "task-1", title: "Summarise my notes" });
  assert.deepEqual(seen, ["task-1"]);

  // Inside the lease window, at least one beat must land before the work finishes.
  await clock.advance(1_200);
  assert.ok(log.heartbeats.length > 0, "a long task must heartbeat while it holds a lease");
  assert.deepEqual(log.heartbeats[0], { taskId: "task-1", leaseId: "lease-1" });

  gate.resolve();
  await drain();
  assert.deepEqual(log.reports, [
    { taskId: "task-1", leaseId: "lease-1", outcome: "succeeded", result: "done" },
  ]);
  assert.equal(loop.getSnapshot().completed, 1);
  await loop.shutdown();
});

test("a lease lost mid-run aborts the work and reports nothing", async () => {
  const clock = fakeClock();
  const log = recorder();
  let finished = false;
  const transport: DeviceWorkTransport = {
    async claim() {
      log.claims += 1;
      if (log.claims > 1) return { task: null };
      return { task: { id: "task-1", title: "Long job" }, lease: leaseFor(clock, 600) };
    },
    // The server has already handed this task to another device.
    async heartbeat() {
      return { ok: false, leaseUntil: null };
    },
    async report(taskId, leaseId, outcome, result) {
      log.reports.push({ taskId, leaseId, outcome, result });
    },
  };
  const execute: TaskExecutor = (_task, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        finished = true;
        reject(new Error("aborted"));
      });
    });
  const loop = new DeviceAgentLoop(transport, execute, TIMING, clock.timers);
  await start(clock, loop);
  assert.equal(loop.getSnapshot().phase, "running");

  await clock.advance(600);
  assert.equal(finished, true, "the executor must be aborted, not left running");
  // The decisive assertion: a device that lost the lease must be SILENT. A late
  // report would overwrite the result of whoever took the task over.
  assert.deepEqual(log.reports, [], "a lost lease must not report a result");
  assert.equal(loop.getSnapshot().completed, 0);
  assert.match(loop.getSnapshot().error, /another device/);
  await loop.shutdown();
});

test("a report rejected as a stale lease is a handover, not a failed task", async () => {
  const clock = fakeClock();
  const log = recorder();
  const transport: DeviceWorkTransport = {
    async claim() {
      log.claims += 1;
      if (log.claims > 1) return { task: null };
      return { task: { id: "task-1" }, lease: leaseFor(clock, 3_000) };
    },
    async heartbeat() {
      return { ok: true, leaseUntil: new Date(clock.timers.now() + 3_000).toISOString() };
    },
    // The exact message the server's CAS failure produces.
    async report() {
      throw new Error("Lost the lease on this task; stop working on it (409)");
    },
  };
  const loop = new DeviceAgentLoop(
    transport,
    async () => ({ outcome: "succeeded", result: "done" }),
    TIMING,
    clock.timers,
  );
  await start(clock, loop);
  await clock.advance(50);
  // Not counted: the work really was done, but the task is not this device's
  // to close. Not an error either — the user has nothing to act on.
  assert.equal(loop.getSnapshot().completed, 0);
  assert.equal(loop.getSnapshot().error, "");
  await loop.shutdown();
});

test("a network blip keeps the lease instead of abandoning live work", async () => {
  const clock = fakeClock();
  const log = recorder();
  let beats = 0;
  const gate = deferred();
  const transport: DeviceWorkTransport = {
    async claim() {
      log.claims += 1;
      if (log.claims > 1) return { task: null };
      return { task: { id: "task-1" }, lease: leaseFor(clock, 600) };
    },
    async heartbeat() {
      beats += 1;
      // First beat fails at the socket; the second proves the lease survived.
      if (beats === 1) throw new Error("Network request failed");
      return { ok: true, leaseUntil: new Date(clock.timers.now() + 600).toISOString() };
    },
    async report(taskId, leaseId, outcome, result) {
      log.reports.push({ taskId, leaseId, outcome, result });
    },
  };
  const loop = new DeviceAgentLoop(
    transport,
    async () => {
      await gate.promise;
      return { outcome: "succeeded", result: "done" };
    },
    TIMING,
    clock.timers,
  );
  await start(clock, loop);
  await clock.advance(600);
  assert.equal(beats >= 2, true, "a failed beat must be retried, not end the heartbeat");
  assert.equal(
    loop.getSnapshot().phase,
    "running",
    "a socket error is not proof the lease is gone",
  );
  assert.match(loop.getSnapshot().error, /still holding/);

  gate.resolve();
  await drain();
  assert.equal(log.reports.length, 1, "the task still reports once the connection returns");
  await loop.shutdown();
});

test("an executor that throws is reported as a failed task", async () => {
  const clock = fakeClock();
  const log = recorder();
  let claimed = 0;
  const transport: DeviceWorkTransport = {
    async claim(): Promise<ClaimResponse> {
      // One task only: this test is about how a crash is reported, not about
      // looping, and an always-eligible queue would just report it repeatedly.
      claimed += 1;
      return claimed > 1
        ? { task: null }
        : { task: { id: "task-1" }, lease: leaseFor(clock, 3_000) };
    },
    async heartbeat(taskId, leaseId) {
      log.heartbeats.push({ taskId, leaseId });
      return { ok: true, leaseUntil: new Date(clock.timers.now() + 3_000).toISOString() };
    },
    async report(taskId, leaseId, outcome, result) {
      log.reports.push({ taskId, leaseId, outcome, result });
    },
  };
  const loop = new DeviceAgentLoop(
    transport,
    async () => {
      throw new Error("the browser tool crashed");
    },
    TIMING,
    clock.timers,
  );
  loop.start();
  await drain();
  await clock.advance(20);
  assert.deepEqual(log.reports, [
    {
      taskId: "task-1",
      leaseId: "lease-1",
      outcome: "failed",
      result: "the browser tool crashed",
    },
  ]);
  await loop.shutdown();
});

test("one device runs one task at a time", async () => {
  const clock = fakeClock();
  const started: string[] = [];
  let concurrent = 0;
  let peak = 0;
  const gate = deferred();
  const transport: DeviceWorkTransport = {
    async claim(): Promise<ClaimResponse> {
      return { task: { id: `task-${started.length + 1}` }, lease: leaseFor(clock, 3_000) };
    },
    async heartbeat() {
      return { ok: true, leaseUntil: new Date(clock.timers.now() + 3_000).toISOString() };
    },
    async report() {},
  };
  const loop = new DeviceAgentLoop(
    transport,
    async (task) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      started.push(task.id);
      // Deliberately held open across the clock advance below. An executor that
      // merely drained microtasks would finish before any second poll could
      // arrive, and the test would pass even if polls overlapped freely.
      await gate.promise;
      concurrent -= 1;
      return { outcome: "succeeded", result: task.id };
    },
    TIMING,
    clock.timers,
  );
  await start(clock, loop);
  assert.equal(started.length, 1, "the first claim should have started a run");
  await clock.advance(5_000);
  // A second task must never overlap the first: two half-attentions on one phone
  // is worse than one task done properly.
  assert.equal(peak, 1, `expected serial execution, saw ${String(peak)} concurrent runs`);
  assert.equal(started.length, 1, "no second claim may arrive while a run is in flight");

  gate.resolve();
  await drain();
  await clock.advance(500);
  assert.ok(started.length > 1, "the loop must go on to the next task after reporting");
  assert.equal(peak, 1, "serial execution must hold across tasks too");
  await loop.shutdown();
});

test("backgrounding stops claiming but finishes the task in hand", async () => {
  const clock = fakeClock();
  const log = recorder();
  const gate = deferred();
  const transport: DeviceWorkTransport = {
    async claim() {
      log.claims += 1;
      if (log.claims > 1) return { task: null };
      // A 900ms lease beats every 300ms, so a 400ms window contains real beats.
      // A 3s lease beats every second and the assertion would pass vacuously.
      return { task: { id: "task-1" }, lease: leaseFor(clock, 900) };
    },
    async heartbeat() {
      log.heartbeats.push({ taskId: "task-1", leaseId: "lease-1" });
      return { ok: true, leaseUntil: new Date(clock.timers.now() + 900).toISOString() };
    },
    async report(taskId, leaseId, outcome, result) {
      log.reports.push({ taskId, leaseId, outcome, result });
    },
  };
  const loop = new DeviceAgentLoop(
    transport,
    async () => {
      await gate.promise;
      return { outcome: "succeeded", result: "done" };
    },
    TIMING,
    clock.timers,
  );
  await start(clock, loop);
  assert.equal(loop.getSnapshot().phase, "running");

  // The app goes to the background with work in hand.
  loop.stop();
  await clock.advance(400);
  assert.ok(
    log.heartbeats.length > 0,
    "the lease must keep beating after backgrounding, or the server assumes the phone died",
  );

  gate.resolve();
  await drain();
  assert.equal(log.reports.length, 1, "work already started still reports");

  const claimsAtStop = log.claims;
  await clock.advance(5_000);
  assert.equal(log.claims, claimsAtStop, "a stopped loop must not claim new work");
  assert.equal(loop.getSnapshot().enabled, false);
  await loop.shutdown();
});

test("stopping mid-claim leaves no timer polling for work", async () => {
  const clock = fakeClock();
  const log = recorder();
  const gate = deferred();
  const transport: DeviceWorkTransport = {
    async claim() {
      log.claims += 1;
      await gate.promise;
      return { task: null };
    },
    async heartbeat() {
      return { ok: true, leaseUntil: null };
    },
    async report() {},
  };
  const loop = new DeviceAgentLoop(
    transport,
    async () => ({ outcome: "succeeded", result: "" }),
    TIMING,
    clock.timers,
  );
  await start(clock, loop);
  assert.equal(log.claims, 1);

  // The user pauses while the claim is still in flight — the exact window where
  // re-arming afterwards would leave a live timer claiming work for a loop that
  // has been switched off.
  loop.stop();
  gate.resolve();
  await drain();

  // Check the timer BEFORE advancing. A stray re-armed timer would fire during
  // `advance`, see the loop is stopped, and return immediately — leaving
  // `pending` back at 0 and hiding exactly the defect being looked for.
  assert.equal(clock.pending, 0, "stopping mid-claim must not re-arm the poll timer");
  await clock.advance(10_000);
  assert.equal(log.claims, 1, "a loop stopped mid-claim must not poll again");
  assert.equal(clock.pending, 0, "a stopped loop must leave no timer behind");
  await loop.shutdown();
});

test("an unpaired device surfaces the pairing gate and backs off", async () => {
  const clock = fakeClock();
  const transport: DeviceWorkTransport = {
    async claim(): Promise<ClaimResponse> {
      throw new Error("This device must be paired before it can claim work");
    },
    async heartbeat() {
      throw new Error("unreachable");
    },
    async report() {},
  };
  const loop = new DeviceAgentLoop(
    transport,
    async () => ({ outcome: "succeeded", result: "" }),
    TIMING,
    clock.timers,
  );
  await start(clock, loop);
  assert.equal(loop.getSnapshot().unpaired, true);
  assert.match(loop.getSnapshot().error, /paired/);
  await loop.shutdown();
});

test("an empty queue backs off rather than spinning", async () => {
  const clock = fakeClock();
  let claims = 0;
  const transport: DeviceWorkTransport = {
    async claim(): Promise<ClaimResponse> {
      claims += 1;
      return { task: null, reason: "no-eligible-work" };
    },
    async heartbeat() {
      return { ok: true, leaseUntil: null };
    },
    async report() {},
  };
  const loop = new DeviceAgentLoop(
    transport,
    async () => ({ outcome: "succeeded", result: "" }),
    { ...TIMING, idlePollMs: 10, maxIdlePollMs: 40, minHeartbeatMs: 5 },
    clock.timers,
  );
  await start(clock, loop);
  await clock.advance(400);
  // 10ms polls capped at 40ms: 10, 20, 40, 40... rather than 40 rapid claims.
  assert.ok(
    claims >= 8 && claims <= 14,
    `expected a backed-off poll, saw ${String(claims)} claims`,
  );
  await loop.shutdown();
  assert.equal(clock.pending, 0, "shutdown must leave no timer behind");
});

test("the heartbeat interval tracks the expiry the server actually granted", () => {
  // A 3s lease beats every 1s, not every 100s and not every 3ms.
  assert.equal(heartbeatInterval(new Date(4_000).toISOString(), 1_000, TIMING), 1_000);
  // An extended lease must not shorten the interval on the next pass.
  assert.equal(heartbeatInterval(new Date(10_000).toISOString(), 1_000, TIMING), 3_000);
  // A lease that has already expired (clock skew) must not produce a zero or
  // NaN interval — that is how a lease gets burned by its own heartbeat.
  assert.equal(heartbeatInterval(new Date(0).toISOString(), 10_000, TIMING), TIMING.minHeartbeatMs);
  // An unparseable expiry falls back to the floor rather than to NaN.
  assert.equal(heartbeatInterval("not-a-date", 1_000, TIMING), TIMING.minHeartbeatMs);
  assert.equal(heartbeatInterval(null, 1_000, TIMING), TIMING.minHeartbeatMs);
});

test("the heartbeat schedule follows each extension instead of shrinking to nothing", async () => {
  const clock = fakeClock();
  const gaps: number[] = [];
  const gate = deferred();
  let last = clock.timers.now();
  const transport: DeviceWorkTransport = {
    async claim(): Promise<ClaimResponse> {
      return { task: { id: "task-1" }, lease: leaseFor(clock, 900) };
    },
    async heartbeat() {
      const now = clock.timers.now();
      gaps.push(now - last);
      last = now;
      // Every beat extends the lease by another 900ms.
      return { ok: true, leaseUntil: new Date(now + 900).toISOString() };
    },
    async report() {},
  };
  const loop = new DeviceAgentLoop(
    transport,
    async () => {
      await gate.promise;
      return { outcome: "succeeded", result: "done" };
    },
    TIMING,
    clock.timers,
  );
  loop.start();
  await clock.advance(2_700);
  gate.resolve();
  await drain();

  assert.ok(gaps.length >= 3, `expected several beats, saw ${String(gaps.length)}`);
  // The first gap is measured from claim time, so only compare the beats.
  const beats = gaps.slice(1);
  // Every gap should be ~300ms (900/3). If the loop measured against the ORIGINAL
  // window, each pass would see a shorter time-to-expiry and beat faster and
  // faster — the classic run-away heartbeat that burns its own lease.
  for (const gap of beats) {
    assert.ok(
      gap >= 250 && gap <= 350,
      `heartbeat gap drifted to ${String(gap)}ms; it must track the current lease`,
    );
  }
  await loop.shutdown();
});

test("the idle backoff doubles and then holds at the cap", () => {
  assert.equal(nextIdleDelay(0, TIMING), 10);
  assert.equal(nextIdleDelay(1, TIMING), 20);
  assert.equal(nextIdleDelay(2, TIMING), 40);
  assert.equal(nextIdleDelay(3, TIMING), 80);
  assert.equal(nextIdleDelay(9, TIMING), TIMING.maxIdlePollMs);
});

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
