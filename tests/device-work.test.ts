import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DeviceProfile } from "../packages/domain/src/capabilities.ts";
import {
  CLAIM_LEASE_MS,
  type ClaimableTask,
  claimEligibility,
  lapsedLeaseRecovery,
  leaseIsLive,
  selectClaimableTask,
} from "../packages/domain/src/device-work.ts";

/**
 * The claim protocol, as pure logic.
 *
 * The load-bearing properties are the negative ones — a task must never be
 * claimed by a device that cannot run it, must never be claimed twice while a
 * lease is live, and must NOT be stranded when a device dies. The last is the
 * one that is easy to get wrong and invisible until a phone is lost, so it gets
 * the most attention here.
 */

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
// Comfortably past `DEVICE_STALE_MS` (90s), so the fixture is unambiguously
// stale rather than sitting on the boundary where a rounding slip would flip it.
const STALE_SEEN = new Date(NOW - 10 * 60_000).toISOString();
const FUTURE = new Date(NOW + CLAIM_LEASE_MS).toISOString();
const EXPIRED = new Date(NOW - 1_000).toISOString();

const shellPhone: DeviceProfile = {
  id: "phone",
  name: "Phone",
  capabilities: ["browser"],
  lastSeenAt: new Date(NOW - 5_000).toISOString(),
};

const shellDesktop: DeviceProfile = {
  id: "desktop",
  name: "Desktop",
  capabilities: ["shell", "browser", "filesystem"],
  lastSeenAt: new Date(NOW - 5_000).toISOString(),
};

function task(over: Partial<ClaimableTask> = {}): ClaimableTask {
  return { id: "task-1", status: "queued", ...over };
}

describe("claimEligibility", () => {
  it("lets a paired, capable, live device claim a queued task", () => {
    assert.deepEqual(claimEligibility(task(), shellDesktop, true, NOW), { eligible: true });
  });

  it("refuses an unpaired device FIRST, even when it is capable and live", () => {
    // Ordering matters: an unpaired phone that also lacks shell should be told
    // to pair, because pairing is the gate that outranks capability and is the
    // only fix that matters. Reporting "missing shell" here would send the
    // operator to a different machine for no reason.
    const decision = claimEligibility(
      task({ requiredCapabilities: ["shell"] }),
      shellPhone,
      false,
      NOW,
    );
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, "not-paired");
    assert.equal(decision.missing, undefined);
  });

  it("names the missing capabilities when pairing is fine", () => {
    const decision = claimEligibility(
      task({ requiredCapabilities: ["shell", "filesystem"] }),
      shellPhone,
      true,
      NOW,
    );
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, "capability-gap");
    assert.deepEqual(decision.missing, ["shell", "filesystem"]);
  });

  it("treats a task with no requirements as claimable by any paired device", () => {
    // The permissive reading is deliberate: absent means "needs nothing
    // device-local", so a browser-only phone may take it.
    assert.deepEqual(claimEligibility(task(), shellPhone, true, NOW), { eligible: true });
  });

  it("refuses a device that has not checked in recently", () => {
    const stale = { ...shellDesktop, lastSeenAt: STALE_SEEN };
    const decision = claimEligibility(task(), stale, true, NOW);
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, "stale-device");
  });

  it("refuses a QUEUED task that still carries a live lease", () => {
    // A queued task with a live lease is a real state: recovery requeues work
    // whose lease lapsed, and a partially-applied write can leave a lease
    // behind. Claiming it would race the device that still believes it holds
    // the task, so the lease gates the claim regardless of status.
    const stray = task({ status: "queued", leaseId: "lease-a", leaseUntil: FUTURE });
    const decision = claimEligibility(stray, shellDesktop, true, NOW);
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, "leased");
    assert.equal(selectClaimableTask([stray], shellDesktop, true, NOW), null);
  });

  it("refuses a task that is not queued", () => {
    for (const status of [
      "succeeded",
      "failed",
      "cancelled",
      "paused",
      "waiting_approval",
      "waiting_input",
      "scheduled",
    ] as const) {
      const decision = claimEligibility(task({ status }), shellDesktop, true, NOW);
      assert.equal(decision.eligible, false, `${status} must not be claimable`);
      assert.equal(decision.reason, "not-queued");
    }
  });
});

describe("leaseIsLive", () => {
  it("is live before expiry and dead after", () => {
    assert.equal(leaseIsLive(task({ leaseUntil: FUTURE }), NOW), true);
    assert.equal(leaseIsLive(task({ leaseUntil: EXPIRED }), NOW), false);
  });

  it("is dead when there is no lease at all", () => {
    assert.equal(leaseIsLive(task({ leaseUntil: null }), NOW), false);
    assert.equal(leaseIsLive(task({}), NOW), false);
  });

  it("treats an unparseable lease as dead rather than blocking forever", () => {
    // A malformed timestamp must fail toward RECOVERY. If it read as live, the
    // task could never be claimed again and would be stranded permanently.
    assert.equal(leaseIsLive(task({ leaseUntil: "not-a-date" }), NOW), false);
  });
});

describe("a live lease blocks a second claim", () => {
  it("refuses to re-claim a running task whose lease is live", () => {
    const decision = claimEligibility(
      task({ status: "running", leaseId: "lease-a", leaseUntil: FUTURE }),
      shellDesktop,
      true,
      NOW,
    );
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, "leased");
  });

  it("allows re-claim once the lease lapses — this is the recovery path", () => {
    const lapsed = task({ status: "running", leaseId: "lease-a", leaseUntil: EXPIRED });
    assert.equal(leaseIsLive(lapsed, NOW), false);
    // A lapsed lease on a `running` task is NOT claimable directly: the task is
    // requeued first (see lapsedLeaseRecovery), and only then claimed. Skipping
    // that step would let two devices race a task still marked `running`.
    assert.equal(claimEligibility(lapsed, shellDesktop, true, NOW).eligible, false);
    assert.equal(lapsedLeaseRecovery(lapsed, NOW), true);
  });
});

describe("lapsedLeaseRecovery", () => {
  it("recovers a running task whose device died", () => {
    assert.equal(lapsedLeaseRecovery(task({ status: "running", leaseUntil: EXPIRED }), NOW), true);
  });

  it("leaves a healthy running task alone", () => {
    assert.equal(lapsedLeaseRecovery(task({ status: "running", leaseUntil: FUTURE }), NOW), false);
  });

  it("does not touch a queued task", () => {
    // A queued task has nothing to recover; requeueing it would be a no-op
    // write on every sweep.
    assert.equal(lapsedLeaseRecovery(task({ status: "queued" }), NOW), false);
    assert.equal(
      lapsedLeaseRecovery(task({ status: "succeeded", leaseUntil: EXPIRED }), NOW),
      false,
    );
  });
});

describe("a handheld never takes destructive work", () => {
  const phone = { ...shellPhone, formFactor: "handheld" as const };
  const desktop = { ...shellDesktop, formFactor: "desktop" as const };

  it("refuses destructive work even when the phone DECLARES the capability", () => {
    // Declaring it must not help. A client that can claim a capability can also
    // claim a form factor, and only one of those claims is worth believing.
    const greedy: DeviceProfile = {
      ...phone,
      capabilities: ["browser", "destructive", "shell"],
    };
    const decision = claimEligibility(
      task({ requiredCapabilities: ["destructive"] }),
      greedy,
      true,
      NOW,
    );
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, "handheld-destructive");
    assert.equal(decision.missing, undefined, "the capability was offered; this is not a gap");
  });

  it("refuses a phone that never declared a form factor", () => {
    // Rows written before the column existed must fail closed.
    const undeclared: DeviceProfile = {
      id: "old",
      name: "Old",
      capabilities: ["destructive"],
      lastSeenAt: new Date(NOW).toISOString(),
    };
    const decision = claimEligibility(
      task({ requiredCapabilities: ["destructive"] }),
      undeclared,
      true,
      NOW,
    );
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, "handheld-destructive");
  });

  it("lets a desktop take the same destructive work", () => {
    // The desktop must OFFER `destructive`: the form-factor rule only removes a
    // restriction, it never grants a capability the device does not have.
    const powerful: DeviceProfile = { ...desktop, capabilities: ["destructive", "shell"] };
    assert.deepEqual(
      claimEligibility(task({ requiredCapabilities: ["destructive"] }), powerful, true, NOW),
      { eligible: true },
    );
    // Offering nothing relevant is still a capability gap, form factor aside.
    const desk = claimEligibility(
      task({ requiredCapabilities: ["destructive"] }),
      desktop,
      true,
      NOW,
    );
    assert.equal(desk.eligible, false);
    assert.equal(desk.reason, "capability-gap");
  });

  it("still allows a phone non-destructive work", () => {
    assert.deepEqual(
      claimEligibility(task({ requiredCapabilities: ["browser"] }), phone, true, NOW),
      { eligible: true },
    );
  });

  it("reports the form-factor refusal, not a capability gap", () => {
    // Ordering: a phone that lacks nothing must not be told it is missing a
    // capability. The message would send the operator to a different machine.
    const decision = claimEligibility(
      task({ requiredCapabilities: ["destructive", "shell"] }),
      phone,
      true,
      NOW,
    );
    assert.equal(decision.reason, "handheld-destructive");
    assert.equal(decision.missing, undefined);
  });
});

describe("selectClaimableTask", () => {
  it("returns null for an unpaired device even when work is available", () => {
    const work = [task({ id: "task-1" })];
    assert.equal(selectClaimableTask(work, shellDesktop, false, NOW), null);
  });

  it("returns null when nothing is eligible", () => {
    const work = [task({ id: "task-1", requiredCapabilities: ["shell"] })];
    assert.equal(selectClaimableTask(work, shellPhone, true, NOW), null);
  });

  it("picks the lowest id, so two devices agree on which task is first", () => {
    // Deterministic ordering: the pick must not depend on array order or on who
    // pulled first, or a task can migrate between two identical devices for no
    // reason other as arrival order.
    const work = [task({ id: "task-c" }), task({ id: "task-a" }), task({ id: "task-b" })];
    assert.equal(selectClaimableTask(work, shellDesktop, true, NOW)?.id, "task-a");
    assert.equal(selectClaimableTask([...work].reverse(), shellDesktop, true, NOW)?.id, "task-a");
  });

  it("prefers the creating device's own work, so tasks stay put", () => {
    const work = [
      task({ id: "task-a", deviceId: "desktop" }),
      task({ id: "task-b", deviceId: "phone" }),
    ];
    assert.equal(selectClaimableTask(work, shellDesktop, true, NOW)?.id, "task-a");
    assert.equal(selectClaimableTask(work, shellPhone, true, NOW)?.id, "task-b");
  });

  it("takes another device's task when its creator cannot run it", () => {
    // The preference is not an entitlement. If the creator is gone, work must
    // not sit idle waiting for a machine that will never come back.
    const work = [task({ id: "task-a", deviceId: "dead-laptop", requiredCapabilities: ["shell"] })];
    assert.equal(selectClaimableTask(work, shellDesktop, true, NOW)?.id, "task-a");
  });

  it("never hands destructive work to a handheld", () => {
    const phone = { ...shellPhone, formFactor: "handheld" as const };
    const work = [
      task({ id: "task-a", requiredCapabilities: ["destructive"] }),
      task({ id: "task-b", requiredCapabilities: ["browser"] }),
    ];
    // Prefers work it may actually run rather than refusing to run anything.
    assert.equal(selectClaimableTask(work, phone, true, NOW)?.id, "task-b");
  });

  it("skips a leased task and takes the next one", () => {
    const work = [
      task({ id: "task-a", status: "running", leaseUntil: FUTURE }),
      task({ id: "task-b" }),
    ];
    assert.equal(selectClaimableTask(work, shellDesktop, true, NOW)?.id, "task-b");
  });
});
