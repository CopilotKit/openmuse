import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { Config } from "../apps/server/src/config.ts";
import { createEncryptedAuthState } from "../apps/server/src/connectors/whatsapp/auth-state.ts";
import { createStore } from "../apps/server/src/db.ts";

const OWNER = "owner-wa-auth";

const configWithKey = (): Config =>
  ({ encryptionKey: randomBytes(32).toString("base64") }) as Config;

test("auth state round-trips creds, including Uint8Array key material", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const config = configWithKey();
  const state = await createEncryptedAuthState(db, config, OWNER);
  const noiseKey = new Uint8Array([1, 2, 3, 250, 0, 17]);
  await state.saveCreds({
    me: { id: "15551234567@s.whatsapp.net" },
    noiseKey,
    nested: { signedPreKey: new Uint8Array([9, 9, 9]) },
  });
  const reloaded = await createEncryptedAuthState(db, config, OWNER);
  const creds = reloaded.creds as {
    me: { id: string };
    noiseKey: Uint8Array;
    nested: { signedPreKey: Uint8Array };
  };
  assert.equal(creds.me.id, "15551234567@s.whatsapp.net");
  assert.ok(creds.noiseKey instanceof Uint8Array, "Uint8Array must survive the round-trip");
  assert.deepEqual(Array.from(creds.noiseKey), [1, 2, 3, 250, 0, 17]);
  assert.ok(creds.nested.signedPreKey instanceof Uint8Array);
  assert.deepEqual(Array.from(creds.nested.signedPreKey), [9, 9, 9]);
});

test("stored envelopes never contain plaintext creds", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const state = await createEncryptedAuthState(db, configWithKey(), OWNER);
  await state.saveCreds({ me: { id: "15551234567@s.whatsapp.net" }, secret: "super-secret-value" });
  await state.keys.set({ session: { "1": { key: new Uint8Array([7, 7, 7]) } } });
  const credsRecord = await db.get<{ envelope: string }>(OWNER, "whatsapp-auth", "creds");
  const keyRecord = await db.get<{ envelope: string }>(OWNER, "whatsapp-auth-keys", "session:1");
  assert.ok(credsRecord && keyRecord);
  for (const envelope of [credsRecord.envelope, keyRecord.envelope]) {
    assert.ok(!envelope.includes("15551234567"), "no phone/JID in plaintext");
    assert.ok(!envelope.includes("super-secret-value"), "no secret in plaintext");
    assert.ok(!envelope.includes("s.whatsapp.net"), "no JID domain in plaintext");
  }
});

test("signal key store get/set/clear", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const state = await createEncryptedAuthState(db, configWithKey(), OWNER);
  await state.keys.set({
    session: { a: { v: 1 }, b: { v: 2 } },
    "pre-key": { c: { v: 3 } },
  });
  assert.deepEqual(await state.keys.get("session", ["a", "b", "missing"]), {
    a: { v: 1 },
    b: { v: 2 },
  });
  // null removes the key
  await state.keys.set({ session: { a: null } });
  assert.deepEqual(await state.keys.get("session", ["a", "b"]), { b: { v: 2 } });
  await state.keys.clear();
  assert.deepEqual(await state.keys.get("session", ["b"]), {});
  assert.deepEqual(await state.keys.get("pre-key", ["c"]), {});
});

test("wipe removes creds and all keys", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const state = await createEncryptedAuthState(db, configWithKey(), OWNER);
  await state.saveCreds({ me: { id: "1@s.whatsapp.net" } });
  await state.keys.set({ session: { a: { v: 1 } } });
  await state.wipe();
  const reloaded = await createEncryptedAuthState(db, configWithKey(), OWNER);
  assert.equal(reloaded.creds, null);
  assert.deepEqual(await reloaded.keys.get("session", ["a"]), {});
  assert.equal(await db.get(OWNER, "whatsapp-auth", "creds"), null);
});

test("missing TOKEN_ENCRYPTION_KEY refuses to build auth state", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  await assert.rejects(createEncryptedAuthState(db, {} as Config, OWNER), /TOKEN_ENCRYPTION_KEY/);
});
