/**
 * Device pairing — the gate on device-local EXECUTION.
 *
 * LIFTED from cntrl `desktop/lib/pairing-gate.ts`, itself modeled on Orca's
 * mobile pairing flow. Kept as a lift: the OTP state machine, its TTL and its
 * attempt budget are the parts worth having, and they are preserved.
 *
 * ---------------------------------------------------------------------------
 * WHY PAIRING EXISTS AT ALL, given the session token already exists
 * ---------------------------------------------------------------------------
 * A session proves a caller holds a credential. Pairing proves a *device* is
 * the user's own machine, and they are deliberately different grants:
 *
 *   - A session may READ. Pulling the change feed discloses notes and task
 *     state, which is what the phone exists to show.
 *   - A session may not EXECUTE. Claiming a task means running tools against
 *     the user's files, logins and screen. That is an ACTION grant, not a
 *     disclosure grant, and a token that can read your notes has no business
 *     being enough to also drive your browser.
 *
 * So a session obtained on a device that has not paired can sync forever and
 * still be refused when it tries to claim work. See `pairingDecision` for the
 * single place that rule is expressed.
 *
 * ---------------------------------------------------------------------------
 * ADAPTATIONS FROM SOURCE (cntrl is a desktop app; this is a server)
 * ---------------------------------------------------------------------------
 * 1. STATE IS NOT IN MEMORY. cntrl's gate holds `paired` and the outstanding
 *    challenge as class fields, because the desktop process outlives the
 *    renderer. Here the gate is reached over HTTP by a device that may be gone
 *    between calls, so the pure state machine below is applied to rows the
 *    caller loads and saves. `PairingState` is the serializable form.
 * 2. THE CODE IS RETURNED TO THE TRUSTED SURFACE, NOT THE DEVICE. cntrl prints
 *    the OTP to the desktop log and the operator types it into the renderer —
 *    the two sides are different processes on the same machine. Here the request
 *    and the verification are both HTTP calls, so returning the code to the
 *    requester would be pointless: the device asking to be paired could simply
 *    verify itself. The code is minted by `mintChallenge` and delivered by the
 *    caller's own transport (an already-trusted surface shows it); only its
 *    HASH is ever persisted or compared.
 * 3. CONSTANT-TIME COMPARISON. cntrl compares `hashOtp(...) === challenge.hash`,
 *    a plain string equality on attacker-supplied input. That leaks the hash one
 *    byte at a time to a patient prober. Here it is `timingSafeEqual`, which is
 *    what `auth.ts` already uses for the access key.
 *
 * This module is pure: no I/O, no clock of its own. That is what makes the whole
 * state machine testable without a database, and it is why the server keeps no
 * pairing state in memory to drift from the database.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const PAIRING_OTP_LENGTH = 6;
export const PAIRING_OTP_TTL_MS = 5 * 60 * 1000;
export const PAIRING_MAX_ATTEMPTS = 5;

/** An outstanding challenge. Only the hash is ever stored. */
export interface PairingChallenge {
  codeHash: string;
  /** Per-device salt, so two devices with the same code do not share a hash. */
  salt: string;
  expiresAt: number;
  attempts: number;
}

/** The serializable pairing state of one device. */
export interface PairingState {
  /** Epoch ms the device was paired, or null when it never has been. */
  pairedAt: number | null;
  /** The outstanding challenge, or null when there is none. */
  challenge: PairingChallenge | null;
}

export const unpaired: PairingState = { pairedAt: null, challenge: null };

/**
 * Wire schema for the persisted form.
 *
 * The state machine's types are compile-time only; the `pairing` column is
 * jsonb and can hold anything a previous build, a hand edit or a bad migration
 * wrote. Parsing it rather than casting is what stops a malformed row from
 * reaching the state machine as a shape it does not expect — a challenge with a
 * non-numeric `expiresAt` would otherwise compare as expired, or as never.
 *
 * Strict on purpose: unknown keys are dropped rather than carried, so a future
 * field cannot silently take effect on an older build's state machine.
 */
export const pairingStateSchema = z.object({
  pairedAt: z.number().int().nonnegative().nullable(),
  challenge: z
    .object({
      codeHash: z.string().regex(/^[0-9a-f]{64}$/),
      salt: z.string().min(1).max(200),
      expiresAt: z.number().int(),
      attempts: z.number().int().nonnegative(),
    })
    .nullable(),
});

export type PairingFailure =
  /** No challenge outstanding — the device must ask for one. */
  | "no-challenge"
  /** The challenge existed but its TTL elapsed. */
  | "expired"
  /** Wrong code, with attempts still remaining. */
  | "mismatch"
  /** Attempt budget spent; the challenge is burned and must be re-minted. */
  | "attempts-exhausted";

export type VerifyResult =
  | { ok: true; state: PairingState }
  | { ok: false; reason: PairingFailure; state: PairingState };

/**
 * Hash a code with a per-device salt.
 *
 * Salted rather than a bare digest: a 6-digit code has ~10^6 candidates, so an
 * attacker who can read the stored hash can confirm a guess instantly with one
 * SHA-256 per candidate. The salt does not stop a determined offline attack on
 * a 6-digit space — nothing short of a longer code does — it stops one lookup
 * per candidate across every device at once.
 */
export function hashPairingCode(code: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

/** Constant-time equality over two SHA-256 hex digests. */
function digestsMatch(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(expected, "hex");
  // timingSafeEqual throws on a length mismatch. The length here is the digest
  // width, which is fixed for any input, so comparing it leaks nothing about
  // the code — an attacker cannot vary the digest length by guessing.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Mint a fresh challenge, replacing any outstanding one.
 *
 * `code` is returned to the caller so it can be SHOWN to the operator on a
 * trusted surface. It is never persisted and never returned by `verifyPairing`.
 */
export function mintChallenge(
  state: PairingState,
  salt: string,
  code: string,
  now: number,
): { state: PairingState; code: string } {
  return {
    state: {
      pairedAt: state.pairedAt,
      challenge: {
        codeHash: hashPairingCode(code, salt),
        salt,
        expiresAt: now + PAIRING_OTP_TTL_MS,
        attempts: 0,
      },
    },
    code,
  };
}

/**
 * Redeem a code.
 *
 * Returns the NEXT state rather than mutating: the caller persists it. Every
 * failure path returns the state to store, so a burned or expired challenge is
 * cleared durably rather than lingering to be retried.
 */
export function verifyPairing(state: PairingState, candidate: string, now: number): VerifyResult {
  const challenge = state.challenge;
  if (!challenge) return { ok: false, reason: "no-challenge", state };
  if (challenge.expiresAt <= now)
    return {
      ok: false,
      reason: "expired",
      state: { pairedAt: state.pairedAt, challenge: null },
    };

  const attempts = challenge.attempts + 1;
  const spent: PairingState = {
    pairedAt: state.pairedAt,
    challenge: { ...challenge, attempts },
  };
  if (digestsMatch(hashPairingCode(candidate, challenge.salt), challenge.codeHash))
    // The challenge is consumed on success too: a code is single-use, so a
    // leaked request that captured it cannot be replayed.
    return { ok: true, state: { pairedAt: now, challenge: null } };

  if (attempts >= PAIRING_MAX_ATTEMPTS)
    // Burn it, so a brute-force run must go back through mintChallenge — which
    // the operator sees, because minting is a trusted-surface action.
    return {
      ok: false,
      reason: "attempts-exhausted",
      state: { pairedAt: state.pairedAt, challenge: null },
    };
  return { ok: false, reason: "mismatch", state: spent };
}

/** Drop pairing, on explicit sign-out. Also clears any outstanding challenge. */
export function revokePairing(_state: PairingState): PairingState {
  return unpaired;
}

export interface PairingStatus {
  paired: boolean;
  /** True while a challenge is live: neither expired nor used. */
  challengeOutstanding: boolean;
  attemptsRemaining: number;
}

export function pairingStatus(state: PairingState, now: number): PairingStatus {
  const outstanding = state.challenge !== null && state.challenge.expiresAt > now;
  return {
    paired: state.pairedAt !== null,
    challengeOutstanding: outstanding,
    attemptsRemaining: outstanding
      ? Math.max(0, PAIRING_MAX_ATTEMPTS - (state.challenge?.attempts ?? 0))
      : PAIRING_MAX_ATTEMPTS,
  };
}

/**
 * The one place the read-vs-execute rule is expressed.
 *
 * A paired device may do both. An unpaired device may read and is refused
 * execution — separately from, and before, any capability check, because
 * "this device can shell" is a different question from "this device is
 * allowed to act".
 */
export type PairingDecision = { allowed: true } | { allowed: false; reason: "not-paired" };

export function pairingDecision(state: PairingState, grant: "read" | "execute"): PairingDecision {
  if (grant === "read") return { allowed: true };
  if (state.pairedAt === null) return { allowed: false, reason: "not-paired" };
  return { allowed: true };
}
