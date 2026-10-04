import assert from "node:assert/strict";
import { test } from "node:test";
import { PAIRING_OTP_LENGTH } from "../../../packages/domain/src/pairing.ts";
import {
  CODE_MAX_LENGTH,
  canSubmitCode,
  type DeviceSummary,
  deviceToApprove,
  normalizeCode,
  pairingView,
} from "../src/device-pairing.ts";

/**
 * The pairing UX, as pure logic.
 *
 * The protocol is asymmetric — a device cannot pair itself — and this is where
 * that asymmetry becomes something a person can act on. The tests are mostly
 * about NOT offering an action whose only outcome is an error, and about not
 * spending the five-attempt OTP budget on a typo.
 */

function device(over: Partial<DeviceSummary> & { id: string }): DeviceSummary {
  return { name: over.id, available: true, paired: true, ...over };
}

test("an unpaired device is shown a code field, not an approve button", () => {
  const view = pairingView({ paired: false, attemptsRemaining: 5 }, [
    device({ id: "desk", name: "Desktop" }),
    device({ id: "phone", name: "Phone", paired: false }),
  ]);
  // The desktop cannot be told to approve the phone from the phone, and the
  // phone must not be offered approval it is not entitled to make.
  assert.equal(view.kind, "redeem");
  assert.equal(view.kind === "redeem" ? view.attemptsRemaining : -1, 5);
});

test("a spent attempt budget says so instead of inviting another try", () => {
  const view = pairingView({ paired: false, attemptsRemaining: 0 }, []);
  assert.equal(view.kind, "redeem");
  assert.match(view.detail, /new one/i);
  assert.equal(view.kind === "redeem" ? view.attemptsRemaining : -1, 0);
});

test("a paired device is told who is waiting for approval", () => {
  const view = pairingView({ paired: true, attemptsRemaining: 5 }, [
    device({ id: "desk", name: "Desktop" }),
    device({ id: "phone", name: "Pixel", paired: false }),
  ]);
  assert.equal(view.kind, "approve");
  assert.match(view.detail, /Pixel/);
  assert.equal(view.kind === "approve" ? view.pending.length : -1, 1);
});

test("a paired device with nothing pending is not nagged", () => {
  const view = pairingView({ paired: true, attemptsRemaining: 5 }, [
    device({ id: "desk", name: "Desktop" }),
  ]);
  assert.equal(view.kind, "paired");
});

test("approval picks an available unpaired device that is not the caller", () => {
  const devices = [
    device({ id: "desk", name: "Desktop" }),
    device({ id: "phone", name: "Pixel", paired: false }),
  ];
  assert.equal(deviceToApprove("desk", devices)?.id, "phone");
  // The caller can never be the target, even if it somehow reads as unpaired:
  // `/pairing/request` answers 409 for that, so offering it is offering an error.
  assert.equal(deviceToApprove("phone", devices), null);
});

test("a stale unpaired device is not offered for approval", () => {
  // A device that has not checked in recently is not sitting there waiting; it is
  // likely a phone that is switched off, and the operator should not be told to
  // approve something that will not respond.
  const devices = [
    device({ id: "desk", name: "Desktop" }),
    device({ id: "old", name: "Old phone", paired: false, available: false }),
  ];
  assert.equal(deviceToApprove("desk", devices), null);
});

test("a code is only sent once it is the right length", () => {
  assert.equal(canSubmitCode("123456"), true);
  assert.equal(canSubmitCode("12345"), false);
  assert.equal(canSubmitCode("1234567"), false);
  assert.equal(canSubmitCode(""), false);
  assert.equal(canSubmitCode("   "), false);
  // A code read aloud or off a screen is often typed with a separator.
  assert.equal(canSubmitCode("123 456"), true);
  assert.equal(canSubmitCode("123-456"), true);
});

test("normalising a code strips what an operator types between digits", () => {
  assert.equal(normalizeCode(" 123 456 "), "123456");
  assert.equal(normalizeCode("123-456"), "123456");
  assert.equal(normalizeCode("1 2 3 4 5 6"), "123456");
  // Digits are unaffected by the upper-casing, which only matters if the scheme
  // ever grows a letter.
  assert.equal(normalizeCode("ab cd"), "ABCD");
});

test("the input bound is derived from the OTP length, not a magic number", () => {
  assert.equal(CODE_MAX_LENGTH, PAIRING_OTP_LENGTH * 2 + 4);
  assert.equal(PAIRING_OTP_LENGTH, 6);
});
