import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { decryptSecret, encryptSecret } from "../packages/integrations/src/vault.ts";

test("vault encrypts with a fresh nonce and authenticates the entire envelope", () => {
  const key = randomBytes(32).toString("base64");
  const secret = "synthetic refresh token / café";
  const first = encryptSecret(secret, key);
  const second = encryptSecret(secret, key);
  assert.notEqual(first, second);
  assert.equal(first.includes(secret), false);
  assert.equal(decryptSecret(first, key), secret);
  assert.throws(
    () => decryptSecret(first, randomBytes(32).toString("base64")),
    /authenticate|decrypt/i,
  );
  const parts = first.split(".");
  assert.equal(parts.length, 4);
  for (let index = 1; index < 4; index++) {
    const corrupted = [...parts];
    const bytes = Buffer.from(corrupted[index]!, "base64url");
    bytes[0] = bytes[0]! ^ 1;
    corrupted[index] = bytes.toString("base64url");
    assert.throws(() => decryptSecret(corrupted.join("."), key), /authenticate|decrypt/i);
  }
});

test("vault rejects malformed keys and envelopes without echoing secrets", () => {
  for (const key of [
    "",
    "password",
    randomBytes(31).toString("base64"),
    `${randomBytes(32).toString("base64")}!`,
  ]) {
    assert.throws(() => encryptSecret("secret-value", key), /32-byte base64/i);
  }
  const key = randomBytes(32).toString("base64");
  for (const envelope of ["", "plaintext-secret", "v2.a.b.c", "v1.!.a.b", "v1.a.b.c.extra"]) {
    assert.throws(() => decryptSecret(envelope, key), /invalid encrypted secret/i);
  }
  assert.equal(decryptSecret(encryptSecret("", key), key), "");
});
