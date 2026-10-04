import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkMigration,
  type DeviceProfile,
  isDeviceAvailable,
  normalizeCapabilities,
  selectDeviceForTask,
} from "../src/capabilities.ts";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");

function device(over: Partial<DeviceProfile> & { id: string }): DeviceProfile {
  return {
    name: over.id,
    capabilities: [],
    lastSeenAt: new Date(NOW).toISOString(),
    ...over,
  };
}

test("normalizeCapabilities drops unknown entries and sorts deterministically", () => {
  assert.deepEqual(
    normalizeCapabilities(["shell", "telepathy", "browser", "shell"]),
    ["browser", "shell"],
    "unknown capabilities are dropped and the result is stable for comparison",
  );
  assert.deepEqual(normalizeCapabilities([]), []);
  assert.deepEqual(normalizeCapabilities(["not-a-capability"]), []);
});

test("a device that has gone quiet is not a migration target", () => {
  const stale = device({
    id: "phone",
    capabilities: ["shell"],
    lastSeenAt: "2026-10-04T11:00:00.000Z",
  });
  assert.equal(isDeviceAvailable(stale, NOW), false);
  const check = checkMigration(stale, ["shell"], NOW);
  assert.equal(check.ok, false);
  // A stale device is not a capability failure; the reason must distinguish them,
  // because "lacks shell" would send the user hunting for the wrong problem.
  assert.equal(check.ok === false ? check.reason : null, "stale");
  assert.deepEqual(check.ok === false ? check.gap.missing : null, []);
});

test("an unparseable heartbeat is stale rather than a crash", () => {
  assert.equal(isDeviceAvailable(device({ id: "x", lastSeenAt: "not-a-date" }), NOW), false);
});

test("a missing capability is refused and named", () => {
  const phone = device({ id: "phone", capabilities: ["browser"] });
  const check = checkMigration(phone, ["shell"], NOW);
  assert.equal(check.ok, false);
  assert.equal(check.ok === false ? check.reason : null, "missing");
  assert.deepEqual(check.ok === false ? check.gap.missing : null, ["shell"]);
});

test("a capable device passes and needs nothing reported", () => {
  const desktop = device({ id: "desktop", capabilities: ["shell", "browser"] });
  assert.deepEqual(checkMigration(desktop, ["shell", "browser"], NOW), { ok: true });
  assert.deepEqual(
    checkMigration(desktop, [], NOW),
    { ok: true },
    "no requirements is always runnable",
  );
});

test("a refusal points at devices that could take the task", () => {
  const phone = device({ id: "phone", capabilities: ["browser"] });
  const desktop = device({ id: "desktop", capabilities: ["shell"] });
  const laptop = device({ id: "laptop", capabilities: ["screen"] });
  const all = [phone, desktop, laptop];
  const check = checkMigration(phone, ["shell"], NOW, all);
  assert.equal(check.ok, false);
  // Only the desktop can shell; the laptop must not be offered.
  assert.deepEqual(check.ok === false ? check.gap.alternatives : null, [
    { id: "desktop", name: "desktop" },
  ]);
});

test("a stale device is not offered as an alternative", () => {
  const phone = device({ id: "phone", capabilities: ["browser"] });
  const gone = device({
    id: "old-desktop",
    capabilities: ["shell"],
    lastSeenAt: "2026-10-04T11:00:00.000Z",
  });
  const check = checkMigration(phone, ["shell"], NOW, [phone, gone]);
  assert.deepEqual(check.ok === false ? check.gap.alternatives : null, []);
});

test("selectDeviceForTask prefers the creating device to avoid needless migration", () => {
  const phone = device({ id: "phone", capabilities: [] });
  const desktop = device({ id: "desktop", capabilities: [] });
  const all = [phone, desktop];
  // Without a preference the most recent device wins, since list order is
  // heartbeat-ordered.
  assert.equal(selectDeviceForTask([], all, NOW)?.id, "phone");
  assert.equal(selectDeviceForTask([], all, NOW, "desktop")?.id, "desktop");
});

test("selectDeviceForTask migrates away when the creating device cannot run it", () => {
  const phone = device({ id: "phone", capabilities: ["browser"] });
  const desktop = device({ id: "desktop", capabilities: ["shell"] });
  // This is the cross-device resumption case from the architecture: work started
  // on the phone resumes on the desktop when the desktop can do what it needs.
  assert.equal(selectDeviceForTask(["shell"], [phone, desktop], NOW, "phone")?.id, "desktop");
});

test("selectDeviceForTask returns null when nothing can run the task", () => {
  const phone = device({ id: "phone", capabilities: ["browser"] });
  assert.equal(selectDeviceForTask(["shell"], [phone], NOW, "phone"), null);
  assert.equal(selectDeviceForTask([], [], NOW), null);
  const stale = device({ id: "old", lastSeenAt: "2026-10-04T11:00:00.000Z" });
  assert.equal(selectDeviceForTask([], [stale], NOW), null, "a dead device is not a target");
});
