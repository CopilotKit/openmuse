/**
 * Capability contracts for the two-plane architecture.
 *
 * The central plane owns task identity; the per-device execution plane owns
 * capability. A task's *state* is portable (it lives in jsonb), but its
 * *capabilities* are not: a role needing a shell cannot run on a phone that has
 * no shell. Without this contract, "a task started on the phone resumes on the
 * desktop" is unenforceable — the scheduler would happily dispatch work to a
 * device that cannot perform it and fail confusingly mid-task.
 *
 * Roles declare what they REQUIRE; devices declare what they OFFER. A task is
 * migratable when every requirement is satisfied by the target device's offers.
 */

/**
 * What a device can do. Coarse on purpose: these are the axes along which
 * devices genuinely differ, not individual tool names. A phone and a desktop
 * differ on exactly these and nothing else worth branching on.
 */
export const CAPABILITIES = [
  /** A desktop browser the agent can drive. Phones have a browser but not a drivable one. */
  "browser",
  /** A filesystem the agent can read and write outside its own scratch space. */
  "filesystem",
  /** Shell / arbitrary command execution. */
  "shell",
  /** A screen the agent can see and click. */
  "screen",
  /** Destructive actions (send, delete, pay) — always requires human approval regardless of device. */
  "destructive",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Capabilities a device may claim. Validation lives here rather than in a zod
 * schema at the route because this is domain vocabulary: an unknown capability
 * means a client is speaking a protocol we do not have, and silently accepting
 * it would produce a task that believes it can shell out somewhere it cannot.
 */
export function normalizeCapabilities(values: readonly string[]): Capability[] {
  const seen = new Set<Capability>();
  for (const value of values) if (isCapability(value)) seen.add(value);
  // Sort so two devices offering the same set compare equal, which makes
  // device identity and cache keys stable.
  return CAPABILITIES.filter((c) => seen.has(c));
}

export interface DeviceProfile {
  id: string;
  name: string;
  /** What this device can actually do right now. */
  capabilities: Capability[];
  /** ISO timestamp of the last heartbeat; a silent device is not a migratable one. */
  lastSeenAt: string;
}

/** A device is only a valid target if it has checked in recently. */
export const DEVICE_STALE_MS = 90_000;

export function isDeviceAvailable(device: DeviceProfile, now: number): boolean {
  const seen = Date.parse(device.lastSeenAt);
  return Number.isFinite(seen) && now - seen < DEVICE_STALE_MS;
}

export interface CapabilityGap {
  missing: Capability[];
  /** Devices that could run this, best first. Empty when nothing can. */
  alternatives: { id: string; name: string }[];
}

/**
 * Can `device` run a task requiring `required`?
 *
 * Returns the missing capabilities rather than a bare boolean so the UI can say
 * *why* a handoff was refused. "This device lacks shell" is actionable;
 * "migration failed" is not.
 */
export function checkMigration(
  device: DeviceProfile,
  required: readonly Capability[],
  now: number,
  allDevices: readonly DeviceProfile[] = [],
): { ok: true } | { ok: false; reason: "stale" | "missing"; gap: CapabilityGap } {
  if (!isDeviceAvailable(device, now))
    return {
      ok: false,
      reason: "stale",
      gap: { missing: [], alternatives: viableAlternatives(required, now, allDevices, device.id) },
    };

  const offered = new Set(device.capabilities);
  const missing = required.filter((c) => !offered.has(c));
  if (missing.length > 0)
    return {
      ok: false,
      reason: "missing",
      gap: { missing, alternatives: viableAlternatives(required, now, allDevices, device.id) },
    };
  return { ok: true };
}

function viableAlternatives(
  required: readonly Capability[],
  now: number,
  allDevices: readonly DeviceProfile[],
  excludeId: string,
): { id: string; name: string }[] {
  return allDevices
    .filter((d) => d.id !== excludeId && isDeviceAvailable(d, now))
    .filter((d) => required.every((c) => d.capabilities.includes(c)))
    .map((d) => ({ id: d.id, name: d.name }));
}

/**
 * The best device for a task, or null when nothing can run it.
 *
 * Prefers the device that created the task, so a task does not hop between
 * machines on every tick — moving execution is a real cost (a cold model, a
 * re-authenticated session) and should only happen when it has to.
 */
export function selectDeviceForTask(
  required: readonly Capability[],
  devices: readonly DeviceProfile[],
  now: number,
  preferredDeviceId?: string | undefined,
): DeviceProfile | null {
  const viable = devices.filter(
    (d) => isDeviceAvailable(d, now) && required.every((c) => d.capabilities.includes(c)),
  );
  if (viable.length === 0) return null;
  return viable.find((d) => d.id === preferredDeviceId) ?? viable[0] ?? null;
}
