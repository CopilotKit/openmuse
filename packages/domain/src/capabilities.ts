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
  /**
   * Physical class. Not a capability: a phone may declare `screen` and still be
   * a phone, and the destructive-work exclusion below is about holding the
   * device in one hand while acting irreversibly — something capability
   * declarations cannot express and a client could therefore lie about.
   *
   * Absent means `handheld`, the fail-closed default.
   */
  formFactor?: FormFactor | undefined;
}

/**
 * What a device physically is.
 *
 * `handheld` is a phone or tablet — something acted on with one hand and no
 * easy abort. `desktop` is a machine with a keyboard and a screen the user is
 * sitting at.
 */
export const FORM_FACTORS = ["handheld", "desktop"] as const;

export type FormFactor = (typeof FORM_FACTORS)[number];

export function isFormFactor(value: unknown): value is FormFactor {
  return typeof value === "string" && (FORM_FACTORS as readonly string[]).includes(value);
}

export function normalizeFormFactor(value: unknown): FormFactor | undefined {
  return isFormFactor(value) ? value : undefined;
}

/** The form factor a device is treated as when it has not declared one. */
export const DEFAULT_FORM_FACTOR: FormFactor = "handheld";

export function formFactorOf(device: Pick<DeviceProfile, "formFactor">): FormFactor {
  return device.formFactor ?? DEFAULT_FORM_FACTOR;
}

/**
 * May a device of this form factor take work requiring `required`?
 *
 * A HANDHELD may never take destructive work, even when it declares the
 * capability. The approval gate is what stops a send, delete, or payment from
 * firing unattended, and the realistic failure is a phone left face-up on a
 * desk: an approval prompt is one tap away on a device already in the user's
 * hands, and "the user approved this earlier" does not survive the task being
 * queued, migrated, and run minutes later on a device they are not looking at.
 *
 * The decision therefore lives here, in the capability contract, rather than in
 * each route — otherwise it is one omission away from not existing.
 *
 * This is about the DEVICE, not the capability set: a phone declaring
 * `destructive` is refused anyway, because a client that can claim a capability
 * can also claim a form factor, and only one of those two claims is worth
 * believing.
 */
export function formFactorAllows(
  device: Pick<DeviceProfile, "formFactor">,
  required: readonly Capability[],
): boolean {
  if (formFactorOf(device) === "desktop") return true;
  return !required.includes("destructive");
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
):
  | { ok: true }
  | { ok: false; reason: "stale" | "missing" | "handheld-destructive"; gap: CapabilityGap } {
  if (!isDeviceAvailable(device, now))
    return {
      ok: false,
      reason: "stale",
      gap: { missing: [], alternatives: viableAlternatives(required, now, allDevices, device.id) },
    };
  // Checked before the capability gap for the same reason as in the claim
  // path: a handheld missing nothing is still refused, and reporting an empty
  // `missing` list with reason "missing" would be a confusing lie.
  if (!formFactorAllows(device, required))
    return {
      ok: false,
      reason: "handheld-destructive",
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
    (d) =>
      isDeviceAvailable(d, now) &&
      formFactorAllows(d, required) &&
      required.every((c) => d.capabilities.includes(c)),
  );
  if (viable.length === 0) return null;
  return viable.find((d) => d.id === preferredDeviceId) ?? viable[0] ?? null;
}
