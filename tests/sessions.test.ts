import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { Auth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

let db: Store, directory: string, auth: Auth;
const config: Config = {
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: "",
  agentBackend: "sample",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
};

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-sessions-"));
  db = await createStore();
  config.dataDir = directory;
  auth = new Auth(db, config, "test-signing-key");
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("purgeExpired() removes expired rows and returns the count", async () => {
  await db.put("system", "sessions", {
    id: "expired-1",
    owner: "local-user",
    expiresAt: Date.now() - 1000,
  });
  await db.put("system", "sessions", {
    id: "expired-2",
    owner: "local-user",
    expiresAt: Date.now() - 1,
  });
  await db.put("system", "sessions", {
    id: "live-1",
    owner: "local-user",
    expiresAt: Date.now() + 3600000,
  });
  assert.equal(await auth.purgeExpired(), 2);
  assert.equal(await db.get("system", "sessions", "expired-1"), null);
  assert.equal(await db.get("system", "sessions", "expired-2"), null);
  assert.ok(await db.get("system", "sessions", "live-1"));
  await db.remove("system", "sessions", "live-1");
});

test("session() purges an expired row created beforehand", async () => {
  await db.put("system", "sessions", {
    id: "stale-row",
    owner: "local-user",
    expiresAt: Date.now() - 1000,
  });
  const { token } = await auth.session();
  assert.equal(await db.get("system", "sessions", "stale-row"), null);
  // The new session is usable.
  assert.equal(await auth.owner(`Bearer ${token}`), "local-user");
  await auth.revoke(`Bearer ${token}`);
});

test("revoke() deletes the caller's session so owner() then rejects it", async () => {
  const { token } = await auth.session();
  await auth.revoke(`Bearer ${token}`);
  await assert.rejects(auth.owner(`Bearer ${token}`), /Session expired/);
});

test("revoke() is idempotent", async () => {
  const { token } = await auth.session();
  await auth.revoke(`Bearer ${token}`);
  await auth.revoke(`Bearer ${token}`);
  await auth.revoke();
  await auth.revoke("Bearer nonsense");
  await assert.rejects(auth.owner(`Bearer ${token}`), /Session expired/);
});

test("POST /api/session/revoke signs the caller out", async () => {
  const { app } = await createApp(db, config);
  const session = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(session.status, 200);
  const { token } = (await session.json()) as { token: string };
  const headers = { Authorization: `Bearer ${token}` };
  // The route itself is authenticated.
  assert.equal((await app.request("/api/session/revoke", { method: "POST" })).status, 401);
  const revoke = await app.request("/api/session/revoke", { method: "POST", headers });
  assert.equal(revoke.status, 200);
  assert.deepEqual(await revoke.json(), { ok: true });
  // The token no longer authenticates anything.
  assert.equal((await app.request("/api/workspace", { headers })).status, 401);
  assert.equal((await app.request("/api/session/revoke", { method: "POST", headers })).status, 401);
});
