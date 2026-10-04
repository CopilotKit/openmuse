/**
 * Scheduler gating — which tasks may run right now.
 *
 * The worker in `apps/server/src/engine/worker.ts` already dispatches
 * concurrently (a batch of three, `compareAndSwap` on every write, lease expiry
 * and reclaim). What it lacked was dependency gating: it would happily start a
 * task whose prerequisite had not finished, which defeats the point of the
 * board. These predicates are pure so the rule can be tested without a
 * database, and so the API and the worker cannot disagree about it.
 */

import type { TaskStatus } from "./agent.ts";

/** Only the fields dispatching reads; keeps this testable without a full task. */
export interface AgentStatusHolder {
  status: TaskStatus;
  nextRunAt?: string | null | undefined;
  leaseUntil?: string | null | undefined;
}

/** A prerequisite edge: which task, and where that task currently stands. */
export interface Prerequisite {
  id: string;
  /** `undefined` when the prerequisite task no longer exists. */
  status: TaskStatus | undefined;
}

/** Prerequisite edges for a task, keyed by the dependent task's id. */
export type PrerequisiteMap = ReadonlyMap<string, readonly Prerequisite[]>;

/** Statuses a task can never leave. A prerequisite in one of these is settled. */
export const CLOSED_STATUSES: readonly TaskStatus[] = ["succeeded", "failed", "cancelled"];

export function isClosedStatus(status: TaskStatus): boolean {
  return CLOSED_STATUSES.includes(status);
}

/**
 * Whether a task's own status makes it eligible for dispatch, given a clock.
 *
 * `running` counts only once its lease has expired — that is the reclaim path
 * for a worker that died mid-task. `waiting_approval` is included so an
 * approval that has gone stale surfaces again instead of stalling.
 */
export function isDispatchable(task: AgentStatusHolder, now: number): boolean {
  switch (task.status) {
    case "queued":
      return true;
    case "scheduled":
      return Date.parse(task.nextRunAt ?? "") <= now;
    case "running":
      return Date.parse(task.leaseUntil ?? "") <= now;
    case "waiting_approval":
      return true;
    default:
      return false;
  }
}

/**
 * Prerequisites still blocking a task.
 *
 * A prerequisite whose task no longer exists counts as unmet, matching what
 * `AgentService.taskGraph` reports to the API. Running a dependent whose
 * prerequisite vanished would be worse than stalling, and the dangling edge is
 * already visible through the API — so the worker and the API agreeing on this
 * matters more than unblocking early.
 */
export function unmetDependencies(prerequisites: readonly Prerequisite[]): string[] {
  return prerequisites
    .filter((prerequisite) => !prerequisite.status || !isClosedStatus(prerequisite.status))
    .map((prerequisite) => prerequisite.id);
}

/** True when nothing is blocking the task. */
export function dependenciesSatisfied(prerequisites: readonly Prerequisite[]): boolean {
  return unmetDependencies(prerequisites).length === 0;
}

/**
 * The subset of `candidates` that is both dispatchable and unblocked.
 *
 * `prerequisites` comes from `Store.prerequisiteStatuses`, which resolves every
 * edge for the owner in one query.
 */
export function selectRunnable<T extends AgentStatusHolder & { id: string }>(
  candidates: readonly T[],
  prerequisites: PrerequisiteMap,
  now: number,
): T[] {
  return candidates.filter(
    (task) => isDispatchable(task, now) && dependenciesSatisfied(prerequisites.get(task.id) ?? []),
  );
}
