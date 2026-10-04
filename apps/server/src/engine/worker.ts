import { randomUUID } from "node:crypto";
import type { AgentTask, RunEvent } from "../../../../packages/domain/src/agent.ts";
import { selectRunnable } from "../../../../packages/domain/src/scheduler.ts";
import type { Store } from "../db.ts";
import { backgroundFailure } from "../log.ts";

export class LostLeaseError extends Error {
  constructor() {
    super("Task was paused, cancelled or taken over by another worker");
    this.name = "LostLeaseError";
  }
}
export interface TaskContext {
  signal: AbortSignal;
  guard(): Promise<void>;
  checkpoint(patch: Partial<AgentTask>): Promise<AgentTask>;
  event(kind: RunEvent["kind"], title: string, detail?: string): Promise<void>;
}
export type TaskHandler = (
  owner: string,
  task: AgentTask,
  context: TaskContext,
) => Promise<Partial<AgentTask>>;
export class TaskWorker {
  // `| undefined` because `stop()` clears it explicitly to release the handle.
  private timer?: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopping = false;
  private active = new Map<string, AbortController>();
  /** Every run dispatched by the current tick, so it can await and await-settle. */
  private inFlight = new Set<Promise<void>>();
  lastTickAt?: string | undefined;
  constructor(
    private readonly db: Store,
    private readonly execute: TaskHandler,
    private readonly options: {
      now?: () => number;
      leaseMs?: number;
      pollMs?: number;
      /** Concurrent runs per tick. Default 3, the batch size this worker always used. */
      maxConcurrency?: number;
      settled?: (owner: string, task: AgentTask) => Promise<void>;
    } = {},
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private capacity() {
    return Math.max(1, this.options.maxConcurrency ?? 3);
  }
  get running() {
    return Boolean(this.timer);
  }
  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => {
      // Timer callbacks cannot await runs; each run owns its durable error state.
      void this.tick().catch((error) => backgroundFailure("task worker tick", error));
    }, this.options.pollMs ?? 1000);
    void this.tick().catch((error) => backgroundFailure("initial task worker tick", error));
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.active.values()) controller.abort();
    // Wait on inFlight as well as active: a run removes itself from `active`
    // before its promise settles, so waiting on `active` alone can let stop()
    // return while a refill is still about to be admitted.
    while (this.active.size > 0 || this.inFlight.size > 0 || this.ticking)
      await new Promise((r) => setTimeout(r, 10));
  }
  abort(taskId: string) {
    this.active.get(taskId)?.abort();
  }
  async tick() {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutable instance flag checked across async boundaries
    if (this.stopping) return;
    if (this.running)
      await this.db.put("system", "worker-status", {
        id: "tasks",
        lastTickAt: new Date(this.now()).toISOString(),
      });
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutable instance flag
    if (this.ticking) return;
    this.ticking = true;
    this.lastTickAt = new Date(this.now()).toISOString();
    try {
      const records = await this.db.scan<AgentTask>("tasks");
      const now = this.now();
      // Resolve prerequisites once per owner, not once per task, then let the
      // shared predicate decide what may run. Owners are independent here, so
      // each is gated only by its own edges.
      const runnableByOwner = new Map<string, Set<string>>();
      for (const owner of new Set(records.map((record) => record.owner))) {
        const candidates = records
          .filter((record) => record.owner === owner && !this.active.has(record.value.id))
          .map((record) => record.value);
        runnableByOwner.set(
          owner,
          new Set(
            selectRunnable(candidates, await this.db.prerequisiteStatuses(owner), now).map(
              (task) => task.id,
            ),
          ),
        );
      }
      const due = records.filter(
        ({ owner, value: t }) => runnableByOwner.get(owner)?.has(t.id) === true,
      );
      const eligible: typeof due = [];
      for (const record of due) {
        if (record.value.status === "waiting_approval") {
          const action = record.value.actionId
            ? await this.db.get<{ status: string; expiresAt?: string }>(
                record.owner,
                "actions",
                record.value.actionId,
              )
            : null;
          if (
            record.value.actionId &&
            action?.status === "awaiting_review" &&
            Date.parse(action.expiresAt ?? "") <= this.now()
          )
            await this.db.compareAndSwap(
              record.owner,
              "actions",
              record.value.actionId,
              { status: "awaiting_review", expiresAt: action.expiresAt },
              { status: "expired" },
            );
          else if (action && ["awaiting_review", "executing"].includes(action.status)) continue;
        }
        eligible.push(record);
      }
      // Pool, not batch. Awaiting `Promise.all` here would hold `ticking` for the
      // whole duration of the slowest run, so every later poll returns early and
      // throughput is capped at `capacity` per poll interval no matter how quickly
      // tasks actually finish. Instead admit up to `capacity`, then admit one more
      // each time a run settles — a 10-task backlog with 2 slots runs 2, then keeps
      // 2 in flight for the whole batch instead of trickling 3 per second.
      const queue = [...eligible];
      // Loop until both the queue is drained *and* every run this tick started
      // has settled. Returning as soon as the queue empties would abandon runs
      // still in flight, and callers legitimately treat a resolved tick as "the
      // work I dispatched is done" — service shutdown and the tests both close
      // the store right after awaiting it.
      while (queue.length > 0 || this.inFlight.size > 0) {
        // Capacity is measured on `inFlight`, not `active`: `run()` only adds to
        // `active` after its lease compare-and-swap resolves, so checking
        // `active` here would see zero and admit the entire queue in one go.
        // `inFlight` is updated synchronously at admission.
        while (queue.length > 0 && this.inFlight.size < this.capacity()) {
          const next = queue.shift();
          if (!next) break;
          const running = this.run(next.owner, next.value);
          this.inFlight.add(running);
          // Bookkeeping on the same promise callers await. `run` never rejects,
          // so this cannot surface as an unhandled rejection.
          void running.finally(() => this.inFlight.delete(running));
        }
        if (this.inFlight.size === 0) break;
        // Whichever run finishes first frees a slot; never wait on the slowest.
        await Promise.race([...this.inFlight]);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: mutable instance flag set by stop() across this await
        if (this.stopping) break;
      }
    } finally {
      this.ticking = false;
    }
  }
  private async run(owner: string, previous: AgentTask) {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutable instance flag
    if (this.stopping) return;
    const leaseId = randomUUID(),
      leaseMs = this.options.leaseMs ?? 60000;
    const expected: Record<string, unknown> = {
      status: previous.status,
      leaseId: previous.leaseId ?? null,
    };
    if (previous.status === "running") expected.leaseUntil = previous.leaseUntil;
    let task = await this.db.compareAndSwap<AgentTask>(owner, "tasks", previous.id, expected, {
      status: "running",
      leaseId,
      leaseUntil: new Date(this.now() + leaseMs).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
      attempts: previous.attempts + 1,
    });
    if (!task) return;
    const controller = new AbortController();
    this.active.set(task.id, controller);
    const taskId = task.id;
    const guard = async () => {
      const latest = await this.db.get<AgentTask>(owner, "tasks", taskId);
      if (controller.signal.aborted || latest?.leaseId !== leaseId || latest.status !== "running")
        throw new LostLeaseError();
    };
    const checkpoint = async (patch: Partial<AgentTask>) => {
      if (controller.signal.aborted) throw new LostLeaseError();
      const next = await this.db.compareAndSwap<AgentTask>(
        owner,
        "tasks",
        taskId,
        { leaseId, status: "running" },
        { ...patch, updatedAt: new Date(this.now()).toISOString() },
      );
      if (!next) throw new LostLeaseError();
      task = next;
      return next;
    };
    const event = async (kind: RunEvent["kind"], title: string, detail = "") => {
      await guard();
      await this.db.put(owner, "run-events", {
        id: randomUUID(),
        taskId,
        date: new Date(this.now()).toISOString(),
        kind,
        title,
        detail,
      });
    };
    const startedAt = new Date(this.now()).toISOString();
    const heartbeat = setInterval(
      () => {
        void this.db
          .compareAndSwap(
            owner,
            "tasks",
            taskId,
            { leaseId, status: "running" },
            { leaseUntil: new Date(this.now() + leaseMs).toISOString() },
          )
          .then((value) => {
            if (!value) controller.abort();
          })
          .catch(() => controller.abort());
      },
      Math.max(10, Math.floor(leaseMs / 3)),
    );
    try {
      await this.db.put(owner, "runs", {
        id: leaseId,
        taskId,
        startedAt,
        status: "running",
      });
      const result = await this.execute(owner, task, {
        signal: controller.signal,
        guard,
        checkpoint,
        event,
      });
      await checkpoint({ ...result, leaseId: null, leaseUntil: null });
      await this.db.put(owner, "runs", {
        id: leaseId,
        taskId,
        startedAt,
        finishedAt: new Date(this.now()).toISOString(),
        status: result.status ?? task.status,
      });
    } catch (error) {
      if (error instanceof LostLeaseError || controller.signal.aborted) {
        await this.db.compareAndSwap(
          owner,
          "tasks",
          taskId,
          { leaseId, status: "running" },
          { status: "queued", leaseId: null, leaseUntil: null },
        );
      } else {
        const detail = error instanceof Error ? error.message : "Task execution failed";
        await event("error", "Task needs attention", detail).catch((err) =>
          backgroundFailure("record task error", err),
        );
        await this.db.compareAndSwap(
          owner,
          "tasks",
          taskId,
          { leaseId, status: "running" },
          {
            status: "failed",
            error: detail,
            leaseId: null,
            leaseUntil: null,
            updatedAt: new Date(this.now()).toISOString(),
          },
        );
      }
      await this.db.compareAndSwap(
        owner,
        "runs",
        leaseId,
        { status: "running" },
        {
          status: controller.signal.aborted ? "interrupted" : "failed",
          finishedAt: new Date(this.now()).toISOString(),
        },
      );
    } finally {
      clearInterval(heartbeat);
      this.active.delete(taskId);
    }
    const settled = await this.db.get<AgentTask>(owner, "tasks", taskId);
    if (settled && this.options.settled) await this.options.settled(owner, settled);
  }
}
