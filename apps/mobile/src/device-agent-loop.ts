/**
 * The device-side half of the work loop: claim, heartbeat, run, report.
 *
 * `packages/domain/src/device-work.ts` decides *what may run*; the routes in
 * `apps/server/src/engine/routes.ts` decide *who wins the lease*. Neither runs
 * anything. This module is the missing third piece: the part that actually holds
 * a lease on a phone and keeps it alive.
 *
 * Everything external is injected — the transport, the executor, the clock, and
 * the timers — so the whole state machine is testable without React, without a
 * network, and without waiting on real wall-clock time. That matters because the
 * interesting behaviour here is all timing: what happens when a lease lapses
 * mid-run, when the app is backgrounded, or when the heartbeat fails.
 *
 * The rules this enforces, in the order they matter:
 *
 * - **One task at a time.** A device-local role needs the screen, the files and
 *   the user's attention. Two concurrent runs on one phone is not more
 *   throughput, it is two half-attentions.
 *
 * - **A lost lease stops the work, it does not merely stop the reporting.** The
 *   heartbeat's `ok: false` means the server has handed this task to someone
 *   else. Continuing to execute would have two devices writing results for one
 *   task, so the executor is aborted and nothing is reported.
 *
 * - **A failed report is not a failed task.** The report is a compare-and-swap on
 *   a lease that may already have lapsed, and the server answers 409 in exactly
 *   that case. Treating it as an error would show the user a task that failed
 *   when it was in fact taken over cleanly.
 *
 * - **Backgrounding stops claiming, not the run in hand.** Work this device
 *   started continues — that is the documented background-continuation promise —
 *   and the lease keeps being heartbeated so the server does not assume the
 *   phone died.
 *
 * Background execution is an *optimisation*, never a correctness requirement:
 * if the process is killed outright, the lease lapses and the server requeues
 * the task. Nothing here is load-bearing for correctness on its own.
 */

/** How a claimed task came back from the server. */
export interface ClaimedTask {
  id: string;
  /** Present so the UI can say what is running; the loop itself is title-agnostic. */
  title?: string | undefined;
  prompt?: string | undefined;
}

/** A lease as `POST /device/claim` returns it. */
export interface Lease {
  id: string;
  until: string;
}

export type ClaimResponse =
  | { task: ClaimedTask; lease: Lease }
  | { task: null; reason?: string | undefined };

export type WorkOutcome = "succeeded" | "failed";

export interface DeviceWorkTransport {
  claim(): Promise<ClaimResponse>;
  /** Resolves `ok: false` when the lease is gone — that is a signal, not a throw. */
  heartbeat(taskId: string, leaseId: string): Promise<{ ok: boolean; leaseUntil: string | null }>;
  /** Rejects with the server's error when the lease is gone (HTTP 409). */
  report(taskId: string, leaseId: string, outcome: WorkOutcome, result: string): Promise<unknown>;
}

/**
 * Runs one claimed task locally. Receives an `AbortSignal` that fires when the
 * lease is lost or the loop is shut down, so a long-running execution can bail
 * out instead of finishing work nobody is waiting for.
 */
export type TaskExecutor = (
  task: ClaimedTask,
  signal: AbortSignal,
) => Promise<{ outcome: WorkOutcome; result: string }>;

/** Injected so tests can drive time deterministically. */
export interface LoopTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export type LoopPhase = "idle" | "waiting" | "claiming" | "running";

export interface LoopSnapshot {
  phase: LoopPhase;
  /** False once `stop()` has been called: no new work will be claimed. */
  enabled: boolean;
  /** The task in hand, when there is one. */
  task: { id: string; title: string } | null;
  /** Set when the last claim, heartbeat or report went wrong in a way a user could act on. */
  error: string;
  /** True once the server has told us this device may not claim at all. */
  unpaired: boolean;
  /** How many tasks this device has finished, for display and for tests. */
  completed: number;
}

/** Timing defaults, all overridable so tests need not sleep. */
export interface LoopTiming {
  /** How long to wait after an empty claim before trying again. */
  idlePollMs: number;
  /** Cap for the backed-off idle wait, so a burst of work is not missed for long. */
  maxIdlePollMs: number;
  /**
   * Fraction of the lease window between heartbeats. Comfortably under half so
   * one failed heartbeat does not immediately cost the lease: a phone on a flaky
   * connection gets a second attempt inside the window it already holds.
   */
  heartbeatFraction: number;
  /** Floor for the heartbeat interval, for a server that hands out tiny leases. */
  minHeartbeatMs: number;
}

export const DEFAULT_TIMING: LoopTiming = {
  idlePollMs: 5_000,
  maxIdlePollMs: 60_000,
  heartbeatFraction: 1 / 3,
  minHeartbeatMs: 1_000,
};

/** How long to wait before the next claim, given how long the last waits have been. */
export function nextIdleDelay(consecutiveIdle: number, timing: LoopTiming): number {
  if (consecutiveIdle <= 0) return timing.idlePollMs;
  return Math.min(timing.idlePollMs * 2 ** consecutiveIdle, timing.maxIdlePollMs);
}

/**
 * The heartbeat interval for a given lease.
 *
 * Derived from the lease the server actually issued rather than a constant,
 * because the server is the only party that knows how long the window is. A
 * fixed interval would be either wasteful on a long lease or fatal on a short
 * one.
 *
 * A lease whose timestamp cannot be parsed falls back to the idle poll: better
 * to beat slowly than to compute `NaN` and stop heartbeating entirely, which is
 * the one failure mode that loses the task.
 */
export function heartbeatInterval(
  leaseUntil: string | null | undefined,
  now: number,
  timing: LoopTiming,
): number {
  const until = Date.parse(leaseUntil ?? "");
  const remaining = Number.isFinite(until) ? until - now : 0;
  const window = Math.max(remaining, timing.minHeartbeatMs * 2);
  return Math.max(Math.floor(window * timing.heartbeatFraction), timing.minHeartbeatMs);
}

/**
 * State persisted so the process can recover after being killed.
 *
 * The foreground service writes this to SharedPreferences on each claim; the
 * headless recovery task reads it when the OS restarts the process. `title`
 * is stored so the notification can name the task without a server round-trip.
 */
export interface AgentWorkState {
  taskId: string;
  leaseId: string;
  leaseUntil: string;
  title: string;
}

/** What the recovery logic decides to do on process restart. */
export type RecoveryAction = "resume" | "requeue" | "noop";

/**
 * Decide what the device should do when it may have been killed mid-task.
 *
 * Pure: based on the saved lease and the clock alone. The caller acts on the
 * result:
 *
 * - `noop` — nothing was in flight; do nothing.
 * - `resume` — the lease is still live; restart the heartbeat loop.
 * - `requeue` — the lease has lapsed (or is malformed), so the server has
 *   already requeued the task; just clear local state.
 *
 * A malformed timestamp reads as dead, never live — consistent with the
 * server's own treatment of unparseable lease times in `device-work.ts`.
 */
export function recoverAgentState(
  saved: AgentWorkState | null,
  now: number,
  leaseGraceMs = 60_000,
): RecoveryAction {
  if (!saved) return "noop";
  const until = Date.parse(saved.leaseUntil);
  if (!Number.isFinite(until)) return "requeue";
  // Grace period accounts for UTC-timestamp jitter and the lag between the OS
  // reading SharedPreferences and the JS headless task starting: if the lease
  // lapsed only recently, give the heartbeat a fighting chance before
  // conceding to "requeue".
  return until + leaseGraceMs > now ? "resume" : "requeue";
}

/**
 * Persistence adapter injected into the loop so tests can pass a fake.
 *
 * The native module (Android) implements this by writing to SharedPreferences
 * directly — synchronous in the JS bridge. On platforms without the native
 * module, the bridge falls back to fire-and-forget SecureStore writes, since
 * these calls are best-effort persistence for recovery, not critical data.
 */
export interface AgentWorkStorage {
  /** Persist the active task and start the foreground service. */
  save(state: AgentWorkState): void;
  /** Update the stored lease expiry without touching the task. */
  updateLease(leaseUntil: string): void;
  /** Clear saved state and stop the foreground service. */
  clear(): void;
}

/** A no-op storage for platforms/tests that do not need process-death recovery. */
export const noopStorage: AgentWorkStorage = {
  save: () => {},
  updateLease: () => {},
  clear: () => {},
};

/** A task in hand, plus the means to abort it. */
interface ActiveRun {
  task: ClaimedTask;
  lease: Lease;
  /** The expiry the SERVER last granted, not the one the claim returned. */
  leaseUntil: string;
  title: string;
  controller: AbortController;
}

/**
 * The device work loop.
 *
 * Constructed disabled: call `start()`. This is not a React component and holds
 * no framework state — the hook in `device-agent-loop.tsx` bridges it to the app.
 */
export class DeviceAgentLoop {
  private phase: LoopPhase = "idle";
  private running_ = false;
  private active: ActiveRun | null = null;
  private errorText = "";
  private unpairedFlag = false;
  private completedCount = 0;
  private idleStreak = 0;
  private pollHandle: unknown = null;
  private listeners = new Set<() => void>();
  private tickChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly transport: DeviceWorkTransport,
    private readonly execute: TaskExecutor,
    private readonly timing: LoopTiming = DEFAULT_TIMING,
    private readonly timers: LoopTimers = {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
    },
    private readonly storage: AgentWorkStorage = noopStorage,
  ) {}

  getSnapshot = (): LoopSnapshot => ({
    phase: this.phase,
    enabled: this.running_,
    task: this.active ? { id: this.active.task.id, title: this.active.title } : null,
    error: this.errorText,
    unpaired: this.unpairedFlag,
    completed: this.completedCount,
  });

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Whether the loop is claiming work.
   *
   * Read through a method rather than off the field directly: biome's
   * `noUnnecessaryConditions` narrows a private boolean to its initialiser and
   * then reports every guard on it as dead code, which would have had me delete
   * the checks that stop a stopped loop from claiming. Going through a call it
   * cannot constant-fold keeps the guards — and keeps them honest.
   */
  private isEnabled(): boolean {
    return this.running_;
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private setPhase(phase: LoopPhase) {
    this.phase = phase;
    this.emit();
  }

  private setError(text: string) {
    this.errorText = text;
    this.emit();
  }

  /** Begin claiming. Idempotent — a second call while already running is a no-op. */
  start() {
    if (this.isEnabled()) return;
    this.running_ = true;
    this.emit();
    this.schedulePoll(0);
  }

  /**
   * Stop claiming new work.
   *
   * A task already in hand keeps running and keeps heartbeating: the server
   * still believes this device is working, and abandoning the lease without
   * reporting would waste the run. The lease lapses on its own if the app is
   * killed outright, which is why this is an optimisation and not a guarantee.
   */
  stop() {
    if (!this.isEnabled()) return;
    this.running_ = false;
    this.clearPoll();
    this.emit();
  }

  /** Stop and abandon the task in hand, aborting its execution. */
  async shutdown() {
    this.stop();
    this.active?.controller.abort();
    // Settle the in-flight tick so a test can assert on a quiesced loop.
    await this.tickChain.catch(() => {});
    this.active = null;
    this.setPhase("idle");
  }

  /**
   * Rebuild an {@link ActiveRun} from state saved before a process kill.
   *
   * The original executor is gone, so this only starts the heartbeat to hold
   * the lease until the app returns to the foreground. `finishRun()` is the
   * only place that clears the run — it is called both from `run()` and from
   * `beat()` when the heartbeat reports the lease is gone.
   */
  restoreSavedState(state: AgentWorkState): void {
    if (this.active !== null) return;
    const active: ActiveRun = {
      task: { id: state.taskId, title: state.title },
      lease: { id: state.leaseId, until: state.leaseUntil },
      leaseUntil: state.leaseUntil,
      title: state.title,
      controller: new AbortController(),
    };
    this.active = active;
    this.running_ = true;
    this.setPhase("running");
    this.storage.save({
      taskId: state.taskId,
      leaseId: state.leaseId,
      leaseUntil: state.leaseUntil,
      title: state.title,
    });
    void this.startHeartbeat(active);
  }

  private clearPoll() {
    if (this.pollHandle === null) return;
    this.timers.clearTimeout(this.pollHandle);
    this.pollHandle = null;
  }

  private schedulePoll(delayMs: number) {
    this.clearPoll();
    this.pollHandle = this.timers.setTimeout(() => {
      this.pollHandle = null;
      this.tickChain = this.tickChain.then(() => this.tick()).catch(() => {});
    }, delayMs);
  }

  /**
   * One claim attempt, followed by the run it produced.
   *
   * One task at a time is enforced TWHERE, independently, and both were checked
   * by mutation rather than assumed:
   *
   *   1. The next poll is armed here, after `claimAndRun` has settled, so while
   *      this tick is in flight no timer is pending to fire.
   *   2. `schedulePoll` chains onto `tickChain`, so even a timer that did fire
   *      early waits for the previous tick to settle.
   *
   * There is deliberately no `claiming` boolean: with both of the above in place
   * a tick cannot start while another runs, so a guard on it would be provably
   * dead code — and a dead security check reads as protection that is not
   * exercised.
   *
   * The `isEnabled()` check in the `finally` IS load-bearing: `stop()` can land
   * while `claimAndRun` is awaiting, and re-arming then would leave a live timer
   * polling for work on a loop the user has paused.
   */
  private async tick() {
    if (!this.isEnabled()) return;
    await this.claimAndRun();
    if (this.isEnabled() && this.phase !== "running")
      this.schedulePoll(nextIdleDelay(this.idleStreak, this.timing));
  }

  private async claimAndRun() {
    // A task is already in hand — e.g. one restored from saved state after a
    // process kill. Don't claim a second one; wait for the current run to finish.
    if (this.active !== null) return;
    this.setPhase("claiming");
    let claimed: ClaimResponse;
    try {
      claimed = await this.transport.claim();
    } catch (e) {
      // A rejected claim is almost always "not paired" — the pairing gate throws
      // before anything else — and hammering it every five seconds would keep
      // the user on a screen that cannot fix itself. Surface it and back off.
      this.idleStreak += 1;
      this.unpairedFlag = looksUnpaired(e);
      // Only overwrite a standing notice with a claim failure if there is no
      // notice, or if this failure is the pairing gate — that one needs to win,
      // because pairing is what the user has to fix next.
      if (!this.errorText || this.unpairedFlag) this.setError(messageOf(e));
      return;
    }
    if (!claimed.task) {
      this.idleStreak += 1;
      // Deliberately does NOT clear `error`. An empty poll is the common case and
      // runs every few seconds, so clearing here would wipe a lease-lost or
      // connectivity notice within milliseconds of it appearing — the user would
      // never read it. The notice clears when the next task actually starts.
      return;
    }
    this.idleStreak = 0;
    this.unpairedFlag = false;
    this.setError("");
    await this.run(claimed.task, claimed.lease);
  }

  private async run(task: ClaimedTask, lease: Lease) {
    const active: ActiveRun = {
      task,
      lease,
      leaseUntil: lease.until,
      title: task.title ?? task.id,
      controller: new AbortController(),
    };
    this.active = active;
    this.setPhase("running");
    this.storage.save({
      taskId: task.id,
      leaseId: lease.id,
      leaseUntil: lease.until,
      title: active.title,
    });

    const beat = this.startHeartbeat(active);
    let result: { outcome: WorkOutcome; result: string } | null = null;
    try {
      result = await this.execute(task, active.controller.signal);
    } catch (e) {
      // A thrown executor is a real failure of the work, and the server should
      // hear about it — unless we aborted it, in which case the lease is gone
      // and there is nobody left to report to.
      if (!active.controller.signal.aborted) result = { outcome: "failed", result: messageOf(e) };
    } finally {
      beat.stop();
    }

    if (active.controller.signal.aborted) {
      // The lease was lost while we worked. Say nothing: the task belongs to
      // whoever holds it now, and a late report would overwrite their result.
      this.finishRun();
      return;
    }
    await this.reportRun(task.id, lease.id, result ?? { outcome: "failed", result: "No result" });
    this.finishRun();
  }

  private async reportRun(
    taskId: string,
    leaseId: string,
    result: { outcome: WorkOutcome; result: string },
  ) {
    try {
      await this.transport.report(taskId, leaseId, result.outcome, result.result);
      this.completedCount += 1;
      this.setError("");
    } catch (e) {
      // 409 means the lease lapsed before we reported, so the task has already
      // been requeued or taken. That is a clean handover, not a failed task, so
      // it must not be counted or shown as a failure.
      if (isLostLease(e)) {
        this.setError("");
        return;
      }
      this.setError(messageOf(e));
    }
  }

  private finishRun() {
    if (this.active === null) return;
    this.active = null;
    this.storage.clear();
    this.setPhase(this.isEnabled() ? "waiting" : "idle");
    // In the normal flow, `tick()` re-arms the poll after `claimAndRun`
    // settles. But when a restored task's lease is lost via `beat()`, there is
    // no enclosing `tick()` — without this, the loop would be stuck idle forever.
    // `schedulePoll` clears any handle already pending, so this is safe to call
    // twice (the `tick()` path simply overwrites).
    if (this.isEnabled()) {
      this.schedulePoll(nextIdleDelay(this.idleStreak, this.timing));
    }
  }

  /**
   * Keep the lease alive until stopped.
   *
   * On `ok: false` the executor is aborted, which unwinds `run()` past the
   * report. Recursive `setTimeout` rather than `setInterval` so a heartbeat
   * that takes longer than its interval cannot pile up behind itself — a phone
   * resuming from sleep would otherwise fire a burst of them at once and burn
   * the lease on its own backlog.
   */
  private startHeartbeat(active: ActiveRun) {
    let handle: unknown = null;
    const stop = () => {
      if (handle !== null) this.timers.clearTimeout(handle);
      handle = null;
    };
    const schedule = () => {
      if (active.controller.signal.aborted) return;
      handle = this.timers.setTimeout(
        () => {
          handle = null;
          void this.beat(active, schedule);
        },
        heartbeatInterval(active.leaseUntil, this.timers.now(), this.timing),
      );
    };
    schedule();
    return { stop };
  }

  private async beat(active: ActiveRun, schedule: () => void) {
    if (active.controller.signal.aborted) return;
    let ok: boolean;
    let leaseUntil: string | null;
    try {
      const response = await this.transport.heartbeat(active.task.id, active.lease.id);
      ok = response.ok;
      leaseUntil = response.leaseUntil;
    } catch {
      // A network failure is NOT proof the lease is gone, so it does not abort
      // the run: the lease may still be live and the task is genuinely ours.
      // Retry on the SAME schedule rather than stopping — returning here without
      // rescheduling would end the heartbeat for good, which is exactly the
      // failure mode that loses the task. Whether the lease survived is decided
      // by the next beat's `ok`.
      this.setError("Lost contact with your workspace; still holding the task.");
      schedule();
      return;
    }
    if (!ok) {
      active.controller.abort();
      this.setError("This task moved to another device.");
      this.finishRun();
      return;
    }
    // Schedule against the NEW expiry. Measuring every beat against the window
    // the claim returned would shorten the interval on each pass — the window
    // only ever shrinks — until the beats were arriving faster than the network
    // could answer them.
    if (leaseUntil) {
      active.leaseUntil = leaseUntil;
      this.storage.updateLease(leaseUntil);
    }
    schedule();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Did this rejection mean "this device may not claim"?
 *
 * Matched on the pairing gate's own wording, which is what the server returns
 * for an unpaired device. A substring test rather than a status code because the
 * mobile client only has the error message — `MuseApi.request` throws
 * `Error(payload.error)` and drops the status.
 */
function looksUnpaired(error: unknown): boolean {
  return /pair/i.test(messageOf(error));
}

/** A 409 from `/device/report` is the lease having lapsed, not a task failure. */
function isLostLease(error: unknown): boolean {
  return /lost the lease|409/i.test(messageOf(error));
}
