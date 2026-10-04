import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hashPairingCode,
  mintChallenge,
  PAIRING_MAX_ATTEMPTS,
  PAIRING_OTP_TTL_MS,
  type PairingState,
  pairingDecision,
  pairingStateSchema,
  pairingStatus,
  revokePairing,
  unpaired,
  verifyPairing,
} from "../packages/domain/src/pairing.ts";

const NOW = 1_700_000_000_000;
const SALT = "test-salt";
const CODE = "042195";

describe("pairing state machine", () => {
  it("pairs only on the correct code, and consumes the challenge when it does", () => {
    const minted = mintChallenge(unpaired, SALT, CODE, NOW);
    const ok = verifyPairing(minted.state, CODE, NOW);
    assert.equal(ok.ok, true);
    assert.equal(ok.state.pairedAt, NOW);
    // A code is single-use: a request that captured it cannot replay it.
    assert.equal(ok.state.challenge, null);
    const replay = verifyPairing(ok.state, CODE, NOW);
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, "no-challenge");
  });

  it("never stores the code itself, only a salted hash", () => {
    const minted = mintChallenge(unpaired, SALT, CODE, NOW);
    const serialized = JSON.stringify(minted.state);
    assert.ok(!serialized.includes(CODE));
    assert.equal(minted.state.challenge?.codeHash, hashPairingCode(CODE, SALT));
  });

  it("salts per device, so the same code does not produce the same hash twice", () => {
    // Without this, one precomputed table of 10^6 digests would confirm a guess
    // against every device at once.
    const a = mintChallenge(unpaired, "salt-a", CODE, NOW);
    const b = mintChallenge(unpaired, "salt-b", CODE, NOW);
    assert.notEqual(a.state.challenge?.codeHash, b.state.challenge?.codeHash);
  });

  it("counts a wrong guess and reports mismatch while attempts remain", () => {
    const minted = mintChallenge(unpaired, SALT, CODE, NOW);
    const first = verifyPairing(minted.state, "000000", NOW);
    assert.equal(first.ok, false);
    // Narrow before reading `reason`: the union genuinely does not have it on
    // the success arm, and asserting that is the point of the strict config.
    assert.equal(first.ok === false && first.reason, "mismatch");
    assert.equal(first.state.challenge?.attempts, 1);
    // The attempt survives, so the next try is judged against the same code.
    assert.equal(pairingStatus(first.state, NOW).attemptsRemaining, PAIRING_MAX_ATTEMPTS - 1);
  });

  it("burns the challenge once the attempt budget is spent", () => {
    let state = mintChallenge(unpaired, SALT, CODE, NOW).state;
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS - 1; i += 1) {
      const attempt = verifyPairing(state, "000000", NOW);
      assert.equal(attempt.ok === false && attempt.reason, "mismatch");
      state = attempt.state;
    }
    const last = verifyPairing(state, "000000", NOW);
    assert.equal(last.ok, false);
    assert.equal(last.ok === false && last.reason, "attempts-exhausted");
    // Burned, so a brute-force run must go back through mintChallenge, which the
    // operator sees because minting is a trusted-surface action.
    assert.equal(last.state.challenge, null);
  });

  it("expires on the TTL and clears the challenge", () => {
    const minted = mintChallenge(unpaired, SALT, CODE, NOW);
    assert.equal(pairingStatus(minted.state, NOW).challengeOutstanding, true);
    const at = NOW + PAIRING_OTP_TTL_MS;
    assert.equal(pairingStatus(minted.state, at).challengeOutstanding, false);
    const result = verifyPairing(minted.state, CODE, at);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "expired");
    assert.equal(result.state.challenge, null);
  });

  it("mints over an outstanding challenge, so only the newest code works", () => {
    const first = mintChallenge(unpaired, SALT, "111111", NOW);
    const second = mintChallenge(first.state, "other-salt", "222222", NOW + 1000);
    assert.equal(verifyPairing(second.state, "111111", NOW + 2000).ok, false);
    assert.equal(verifyPairing(second.state, "222222", NOW + 2000).ok, true);
  });

  it("revoking drops pairing and any outstanding challenge", () => {
    const paired = verifyPairing(mintChallenge(unpaired, SALT, CODE, NOW).state, CODE, NOW).state;
    assert.equal(pairingStatus(paired, NOW).paired, true);
    const revoked = revokePairing(paired);
    assert.equal(pairingStatus(revoked, NOW).paired, false);
    assert.deepEqual(revoked, unpaired);
  });

  it("preserves an existing pairing when a new challenge is minted", () => {
    // Re-pairing a paired device must not un-pair it if the code is never used.
    const paired = verifyPairing(mintChallenge(unpaired, SALT, CODE, NOW).state, CODE, NOW).state;
    const reminted = mintChallenge(paired, SALT, "999999", NOW + 1000);
    assert.equal(reminted.state.pairedAt, NOW);
  });
});

describe("pairing decision: read versus execute", () => {
  const paired: PairingState = { pairedAt: NOW, challenge: null };

  it("allows an unpaired device to read but not to execute", () => {
    assert.deepEqual(pairingDecision(unpaired, "read"), { allowed: true });
    assert.deepEqual(pairingDecision(unpaired, "execute"), {
      allowed: false,
      reason: "not-paired",
    });
  });

  it("allows both for a paired device", () => {
    assert.deepEqual(pairingDecision(paired, "read"), { allowed: true });
    assert.deepEqual(pairingDecision(paired, "execute"), { allowed: true });
  });

  it("does not treat a merely-outstanding challenge as paired", () => {
    // The dangerous middle state: a code has been minted but not redeemed.
    const challenged = mintChallenge(unpaired, SALT, CODE, NOW).state;
    assert.equal(pairingDecision(challenged, "execute").allowed, false);
  });
});

describe("persisted pairing state", () => {
  it("round-trips a valid state", () => {
    const minted = mintChallenge(unpaired, SALT, CODE, NOW);
    const parsed = pairingStateSchema.parse(JSON.parse(JSON.stringify(minted.state)));
    assert.deepEqual(parsed, minted.state);
  });

  it("rejects a malformed row rather than feeding it to the state machine", () => {
    // A challenge with a non-numeric expiresAt would compare as NaN and read as
    // "never expires" — the opposite of fail-closed.
    for (const bad of [
      {
        pairedAt: null,
        challenge: { codeHash: "x".repeat(64), salt: "s", expiresAt: "soon", attempts: 0 },
      },
      { pairedAt: null, challenge: { codeHash: "short", salt: "s", expiresAt: 1, attempts: 0 } },
      {
        pairedAt: null,
        challenge: { codeHash: "x".repeat(64), salt: "", expiresAt: 1, attempts: 0 },
      },
      { pairedAt: -1, challenge: null },
      {
        pairedAt: null,
        challenge: { codeHash: "x".repeat(64), salt: "s", expiresAt: 1, attempts: -1 },
      },
    ])
      assert.equal(pairingStateSchema.safeParse(bad).success, false, JSON.stringify(bad));
  });

  it("drops unknown keys, so a future field cannot take effect on an older build", () => {
    const parsed = pairingStateSchema.parse({ pairedAt: NOW, challenge: null, futureFlag: true });
    assert.deepEqual(parsed, { pairedAt: NOW, challenge: null });
  });
});
