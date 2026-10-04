/**
 * The pairing flow, as the two devices see it.
 *
 * The protocol is asymmetric on purpose: a device may not pair itself, so the
 * code is minted by a machine already in the operator's hands and typed into the
 * new one. That asymmetry is only usable if both halves exist, and until now only
 * the server half did — `apps/mobile` could read a pairing status but had no way
 * to act on it, so an unpaired phone was told to pair and then given nothing to
 * do about it.
 *
 * Pure and React-Native-free so it is reachable from a node test; the same
 * reasoning as `device-work-copy.ts`.
 */

import { PAIRING_OTP_LENGTH } from "../../../packages/domain/src/pairing";

/**
 * The longest raw input the server will accept.
 *
 * The route's own bound is `PAIRING_OTP_LENGTH * 2 + 4`, loose enough for the
 * separators `normalizeCode` strips. Derived from the domain constant rather than
 * repeated, so the input's `maxLength` cannot drift from the protocol it guards.
 */
const MAX_CODE_LENGTH = PAIRING_OTP_LENGTH * 2 + 4;

/** A device as `GET /api/agent/devices` returns it. */
export interface DeviceSummary {
  id: string;
  name: string;
  available: boolean;
  /** Added by this change; absent on servers older than it, hence optional. */
  paired?: boolean | undefined;
}

/** What the UI should offer, given who is asking. */
export type PairingView =
  | { kind: "redeem"; detail: string; attemptsRemaining: number }
  | { kind: "approve"; detail: string; pending: DeviceSummary[] }
  | { kind: "paired"; detail: string };

/**
 * What one device should show.
 *
 * Ordered so the most specific state wins, and the ordering encodes the protocol:
 *
 * - `paired` wins over everything except `approve`, because a paired device's
 *   primary job is approving OTHERS even though its own pairing is settled.
 * - A paired device is told what is waiting for it only when something is
 *   actually waiting; otherwise the card would nag continuously.
 * - `approve` is deliberately only reachable by an already-paired caller. The
 *   server refuses it anyway (`/pairing/request` requires a paired caller), so
 *   offering the button to an unpaired phone would be offering an action that
 *   always fails.
 */
export function pairingView(
  self: { paired: boolean; attemptsRemaining: number },
  devices: readonly DeviceSummary[],
): PairingView {
  const pending = devices.filter((d) => d.paired === false);
  if (!self.paired) {
    if (self.attemptsRemaining <= 0)
      return {
        kind: "redeem",
        detail: "Too many wrong codes. Ask the other device for a new one.",
        attemptsRemaining: 0,
      };
    return {
      kind: "redeem",
      detail: "Enter the code from a device you already trust.",
      attemptsRemaining: self.attemptsRemaining,
    };
  }
  if (pending.length > 0)
    return {
      kind: "approve",
      detail: `Waiting to be approved: ${pending.map((d) => d.name).join(", ")}`,
      pending,
    };
  return { kind: "paired", detail: "This device is paired." };
}

/**
 * The `deviceId` to mint a code for, or null when there is nothing to approve.
 *
 * A device can be approved only by a paired device that is not itself, so this
 * refuses to return the caller's own id even if it somehow appears unpaired in
 * the list. `POST /pairing/request` rejects that case with a 409; filtering it
 * here means the UI never offers a button whose only outcome is an error.
 */
export function deviceToApprove(
  selfDeviceId: string,
  devices: readonly DeviceSummary[],
): DeviceSummary | null {
  return devices.find((d) => d.id !== selfDeviceId && d.paired === false && d.available) ?? null;
}

/**
 * Is a typed code complete enough to send?
 *
 * Requires exactly the OTP length, after normalisation — not merely "non-empty".
 * An attempt spends the caller's attempt budget, and the budget is only five, so
 * sending a half-typed code to find out it is too short would burn a real attempt
 * on a typo. The user is mid-typing; the check belongs before the request.
 */
export function canSubmitCode(code: string): boolean {
  const normalized = normalizeCode(code);
  return normalized.length === PAIRING_OTP_LENGTH;
}

/**
 * Normalise a typed code for submission.
 *
 * Strips spaces and dashes, because an operator reading a six-digit code aloud
 * or off a screen may well type "123 456". Upper-casing is a no-op for digits and
 * costs nothing if the scheme ever grows a letter.
 */
export function normalizeCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

/** Exposed for the input's `maxLength`, so the UI cannot exceed the server bound. */
export const CODE_MAX_LENGTH = MAX_CODE_LENGTH;
