/**
 * The device-side work loop: how a device claims work, runs it, and reports back.
 *
 * LIFTED/ADAPTED from cntrl's `desktop/lib/pairing-gate.ts` sibling flow — but
 * cntrl has no equivalent, because in cntrl the *desktop* is the server. In
 * OpenMuse the server is central and devices are satellites, so a device has to
 * PULL work. That makes two problems the server must solve, and this module
 * holds the pure part of both so they can be tested without a database:
 *
 *   1. Which tasks is this device even allowed to claim? (eligibility)
 *   2. When two devices pull at once, who wins? (the lease)
 *
 * The central plane owns task identity; the device owns execution. This is the
 * seam between them: the server decides *what may run*, the device decides *how*.
 *
 * Design notes worth keeping:
 *
 * - **Claiming is separate from running.** A claim hands the task to one device
 *   for a bounded window (the lease). The device then heartbeats. If it dies, the
 *   lease expires and the task returns to the queue — which is why a claim is a
 *   lease and not a status flip. A status flip with no expiry strands work on a
 *   device that is gone, and no phone is ever coming back.
 *
 * - **Eligibility is capability + availability + pairing**, all three. Pairing
 *   matters here because a claim IS execution: the whole point of the pairing
 *   gate is that an unpaired device may read but not run.
 *
 * - **Deterministic ordering.** Devices pull at unpredictable moments; ties must
 *   not be broken by who asked first, or the same task ping-pongs between two
 *   equally-capable devices across restarts.
 */

import type { TaskStatus } from "./agent.js";
import {
  type Capability,
  type DeviceProfile,
  formFactorAllows,
  isDeviceAvailable,
} from "./capabilities.js";

/** A task as the claim logic sees it: the fields that decide eligibility. */
export interface ClaimableTask {
  id: string;
  status: TaskStatus;
  /** What this task needs from a device. Absent means "needs nothing device-local". */
  requiredCapabilities?: Capability[] | undefined;
  /**
   * The device that created the task. A preference, not an entitlement: work
   * travels with the user, and holding a stale or unpaired creator must not
   * strand a task on a machine that cannot run it.
   */
  deviceId?: string | undefined;
  leaseId?: string | null | undefined;
  leaseUntil?: string | null | undefined;
}

/** Statuses a device may claim from. */
const CLAIMABLE: readonly TaskStatus[] = ["queued"];

/** Default claim window. Long enough for a model call, short enough to recover. */
export const CLAIM_LEASE_MS = 120_000;

/** Why a device cannot claim a task. Distinguish these; they are different bugs. */
export type IneligibleReason =
  | "not-paired"
  | "capability-gap"
  | "handheld-destructive"
  | "stale-device"
  | "not-queued"
  | "leased";

export interface ClaimDecision {
  eligible: boolean;
  reason?: IneligibleReason;
  /** What the device is missing, when the reason is a capability gap. */
  missing?: Capability[];
}

/**
 * Is the lease on this task still live?
 *
 * An EXPIRED lease does not block a claim — that is the recovery path. A task
 * whose device vanished returns to the queue the moment its lease lapses, which
 * is the entire reason leases expire.
 */
export function leaseIsLive(task: ClaimableTask, now: number): boolean {
  if (!task.leaseUntil) return false;
  const until = Date.parse(task.leaseUntil);
  return Number.isFinite(until) && until > now;
}

/**
 * May `device` claim `task`?
 *
 * Checked in the order a human would triage them: pairing first (it is the gate
 * that outranks everything), then the task's own state, then capability. That
 * order matters because the reason is user-facing — "pair this phone" is useful
 * advice whether or not it also lacks a shell, whereas "missing shell" sent to
 * someone who is merely unpaired sends them to fix the wrong thing.
 */
export function claimEligibility(
  task: ClaimableTask,
  device: DeviceProfile,
  paired: boolean,
  now: number,
): ClaimDecision {
  if (!paired) return { eligible: false, reason: "not-paired" };
  // The claimer is this device, so its own freshness gates the claim. Without
  // this, a device that has stopped heartbeating — a phone that lost network,
  // an app the user force-quit — would still be handed work it can never
  // report on, and the task would sit `running` until its lease lapsed.
  if (!isDeviceAvailable(device, now)) return { eligible: false, reason: "stale-device" };
  if (!CLAIMABLE.includes(task.status))
    return {
      eligible: false,
      reason: task.status === "running" && leaseIsLive(task, now) ? "leased" : "not-queued",
    };
  if (leaseIsLive(task, now)) return { eligible: false, reason: "leased" };
  const required = task.requiredCapabilities ?? [];
  // Form factor outranks capabilities: a handheld is refused destructive work
  // even when it offers every required capability, so this must be checked
  // BEFORE the capability gap or the reason would report a shortfall that does
  // not exist and send the operator chasing the wrong thing.
  if (!formFactorAllows(device, required))
    return { eligible: false, reason: "handheld-destructive" };
  const offered = new Set(device.capabilities);
  const missing = required.filter((c) => !offered.has(c));
  if (missing.length > 0) return { eligible: false, reason: "capability-gap", missing };
  return { eligible: true };
}

/**
 * The best task for this device to claim next, or null.
 *
 * Ordering is by task id so that two devices pulling the same pool agree on
 * which task is first. Without a deterministic tiebreak the choice depends on
 * arrival order, and a task can migrate back and forth between two identically
 * capable devices for no reason other than clock skew.
 *
 * The `deviceId` preference is applied WITHIN the ordering, not as a filter: the
 * creator's device is tried first so work stays put, but a task never sits idle
 * because its creator is unpaired or offline.
 */
export function selectClaimableTask(
  tasks: readonly ClaimableTask[],
  device: DeviceProfile,
  paired: boolean,
  now: number,
): ClaimableTask | null {
  // No explicit `paired` check here: every candidate passes through
  // `claimEligibility`, which refuses an unpaired device outright. A second
  // guard would be dead code, and dead security checks are worse than none —
  // they read as protection that is not being exercised.
  const eligible = tasks.filter((task) => claimEligibility(task, device, paired, now).eligible);
  if (eligible.length === 0) return null;
  const preferred = eligible.filter((task) => task.deviceId === device.id);
  const pool = preferred.length > 0 ? preferred : eligible;
  // Sorted by id so two devices pulling the same pool agree on which task is
  // first. The caller mints the lease: a candidate that arrived here was never
  // claimed, so this module has no business inventing a lease id.
  return [...pool].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ?? null;
}

/**
 * Requeue a task whose lease lapsed, so a dead device cannot strand it.
 *
 * Returns the tasks that changed, or null when there was nothing to recover.
 * Recovery is a compare-and-swap on the exact lease that lapsed: if the task
 * moved on in the meantime (a human cancelled it, another device claimed it),
 * the swap fails and the row is left alone.
 */
export function lapsedLeaseRecovery(task: ClaimableTask, now: number): boolean {
  return task.status === "running" && !leaseIsLive(task, now);
}
