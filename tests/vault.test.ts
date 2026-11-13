import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import test from "node:test";
import {
  decryptSecret,
  encryptSecret,
  legacyCredentialAad,
} from "../packages/integrations/src/vault.ts";

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
    const bytes = Buffer.from(corrupted[index], "base64url");
    bytes[0] ^= 1;
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

test("vault still reads credentials saved under the previous product name", () => {
  const key = randomBytes(32).toString("base64");
  const seal = (aad: Buffer) => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update("saved refresh token", "utf8"),
      cipher.final(),
    ]);
    return ["v1", nonce, cipher.getAuthTag(), ciphertext]
      .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
      .join(".");
  };
  assert.equal(decryptSecret(seal(legacyCredentialAad), key), "saved refresh token");
  assert.throws(
    () => decryptSecret(seal(Buffer.from("another:credential:v1")), key),
    /authenticate|decrypt/i,
  );
});
