import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createAuth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import {
  assertNotLastEnabledAdmin,
  createUser,
  ensureAdminSeeded,
  getUser,
  hashPassword,
  listUsers,
  normalizeUsername,
  toPublic,
  validatePassword,
  validateUsername,
  verifyPassword,
} from "../apps/server/src/users.ts";

let db: Store;
let directory: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-users-"));
  db = await createStore();
});

after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

function liveConfig(): Config {
  return {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    accessKey: "test-access-key",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
}

test("scrypt password hashing round-trips and rejects wrong passwords", () => {
  const hash = hashPassword("correct horse");
  assert.ok(hash.startsWith("scrypt$"));
  assert.ok(verifyPassword("correct horse", hash));
  assert.ok(!verifyPassword("wrong horse", hash));
  assert.ok(!verifyPassword("correct horse", "not-a-hash"));
  assert.ok(!verifyPassword("correct horse", "scrypt$bad$format"));
});

test("username validation accepts sane names and rejects the rest", () => {
  assert.equal(validateUsername("Admin"), "admin");
  assert.equal(validateUsername("  simran_99 "), "simran_99");
  assert.throws(() => validateUsername("ab"), /3-32/);
  assert.throws(() => validateUsername("has space"), /3-32/);
  assert.throws(() => validateUsername("UPPER!"), /3-32/);
});

test("password validation enforces a minimum length", () => {
  validatePassword("long-enough");
  assert.throws(() => validatePassword("short"), /8 characters/);
});

test("createUser stores a scrypt hash, never the plaintext", async () => {
  const pub = await createUser(db, "Alice", "s3cret-pass", "user");
  assert.equal(pub.username, "alice");
  assert.equal(pub.role, "user");
  assert.ok(!("passwordHash" in pub));
  const stored = await getUser(db, "ALICE");
  assert.ok(stored);
  assert.ok(stored.passwordHash.startsWith("scrypt$"));
  assert.ok(!stored.passwordHash.includes("s3cret-pass"));
  assert.ok(verifyPassword("s3cret-pass", stored.passwordHash));
  assert.deepEqual(Object.keys(toPublic(stored)).sort(), [
    "createdAt",
    "disabled",
    "role",
    "username",
  ]);
});

test("createUser rejects duplicates and bad roles", async () => {
  await assert.rejects(createUser(db, "alice", "another-pass", "user"), /already taken/);
  await assert.rejects(createUser(db, "bob", "another-pass", "superuser" as never), /Role must be/);
});

test("ensureAdminSeeded creates admin once, then is a no-op", async () => {
  const fresh = await createStore();
  try {
    assert.equal(await ensureAdminSeeded(fresh, "bootstrap-key"), true);
    const admin = await getUser(fresh, "admin");
    assert.ok(admin);
    assert.equal(admin.role, "admin");
    assert.ok(verifyPassword("bootstrap-key", admin.passwordHash));
    assert.equal(await ensureAdminSeeded(fresh, "other-key"), false);
    assert.equal((await listUsers(fresh)).length, 1);
  } finally {
    await fresh.close();
  }
});

test("assertNotLastEnabledAdmin protects the final admin", async () => {
  const fresh = await createStore();
  try {
    await ensureAdminSeeded(fresh, "k");
    await assert.rejects(assertNotLastEnabledAdmin(fresh, "admin"), /last admin/);
    await createUser(fresh, "admin2", "password-2", "admin");
    await assertNotLastEnabledAdmin(fresh, "admin"); // no throw now
  } finally {
    await fresh.close();
  }
});

test("auth bootstrap: legacy access-key-only body seeds admin on first run", async () => {
  const fresh = await createStore();
  try {
    const auth = await createAuth(fresh, liveConfig());
    // Wrong key is rejected before any seeding.
    await assert.rejects(auth.session({ accessKey: "nope" }), /Access key/);
    assert.equal((await listUsers(fresh)).length, 0);
    // Correct key seeds admin and signs in (back-compat for old clients).
    const legacy = await auth.session({ accessKey: "test-access-key" });
    assert.equal(legacy.username, "admin");
    assert.equal(legacy.role, "admin");
    assert.ok(legacy.token);
    const info = await auth.sessionInfo(`Bearer ${legacy.token}`);
    assert.deepEqual(info, { owner: "local-user", username: "admin", role: "admin" });
  } finally {
    await fresh.close();
  }
});

test("auth bootstrap: username+password seeds admin, then key alone is rejected", async () => {
  const fresh = await createStore();
  try {
    const auth = await createAuth(fresh, liveConfig());
    // Wrong key is rejected before any seeding.
    await assert.rejects(auth.session({ username: "admin", password: "nope" }), /Access key/);
    assert.equal((await listUsers(fresh)).length, 0);
    // Correct key seeds admin and signs in.
    const session = await auth.session({ username: "admin", password: "test-access-key" });
    assert.equal(session.username, "admin");
    assert.equal(session.role, "admin");
    assert.ok(session.token);
    // After seeding, the access key alone no longer signs in.
    await assert.rejects(auth.session({ accessKey: "test-access-key" }), /Username and password/);
    const retry = await auth.session({ username: "admin", password: "test-access-key" });
    assert.equal(retry.role, "admin");
    const info = await auth.sessionInfo(`Bearer ${retry.token}`);
    assert.deepEqual(info, { owner: "local-user", username: "admin", role: "admin" });
  } finally {
    await fresh.close();
  }
});

test("auth rejects wrong passwords and disabled users", async () => {
  const fresh = await createStore();
  try {
    const auth = await createAuth(fresh, liveConfig());
    await auth.session({ username: "admin", password: "test-access-key" });
    await createUser(fresh, "simran", "simran-pass", "user");
    await assert.rejects(
      auth.session({ username: "simran", password: "wrong" }),
      /Wrong username or password/,
    );
    const ok = await auth.session({ username: "simran", password: "simran-pass" });
    assert.equal(ok.role, "user");
    // Disable -> sign-in fails even with the right password.
    const simran = await getUser(fresh, "simran");
    assert.ok(simran);
    simran.disabled = true;
    await fresh.put("system", "users", simran);
    await assert.rejects(
      auth.session({ username: "simran", password: "simran-pass" }),
      /Wrong username or password/,
    );
  } finally {
    await fresh.close();
  }
});

test("API: /api/users is admin-only and enforces the last-admin rule", async () => {
  const fresh = await createStore();
  const dir = await mkdtemp(join(tmpdir(), "openmuse-users-api-"));
  try {
    const config = liveConfig();
    config.dataDir = dir;
    const { app } = await createApp(fresh, config);
    const login = async (u: string, p: string) => {
      const r = await app.request("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, password: p }),
      });
      assert.equal(r.status, 200);
      const body = (await r.json()) as { token: string };
      return { Authorization: `Bearer ${body.token}`, "Content-Type": "application/json" };
    };
    const adminH = await login("admin", "test-access-key");
    // Bootstrap admin changes their password via the Users API.
    const pwChange = await app.request("/api/users/admin", {
      method: "PATCH",
      headers: adminH,
      body: JSON.stringify({ password: "new-admin-pass" }),
    });
    assert.equal(pwChange.status, 200);
    const adminH2 = await login("admin", "new-admin-pass");

    // Create a regular user.
    const created = await app.request("/api/users", {
      method: "POST",
      headers: adminH2,
      body: JSON.stringify({ username: "jag", password: "jag-pass-1", role: "user" }),
    });
    assert.equal(created.status, 201);
    const userH = await login("jag", "jag-pass-1");

    // Regular user: Users API is forbidden...
    assert.equal((await app.request("/api/users", { headers: userH })).status, 403);
    // ...as are the Services tab and connector settings.
    assert.equal((await app.request("/api/health/services", { headers: userH })).status, 403);
    assert.equal((await app.request("/api/credentials", { headers: userH })).status, 403);
    assert.equal((await app.request("/api/provider-keys", { headers: userH })).status, 403);
    // ...but chat-adjacent reads still work.
    assert.equal((await app.request("/api/workspace", { headers: userH })).status, 200);
    // Email account management is admin-only; message reading stays open.
    assert.equal(
      (await app.request("/api/email-accounts", { method: "POST", headers: userH, body: "{}" }))
        .status,
      403,
    );

    // Regular user can change their own password with the current one.
    const selfPw = await app.request("/api/users/jag", {
      method: "PATCH",
      headers: userH,
      body: JSON.stringify({ currentPassword: "jag-pass-1", password: "jag-pass-22" }),
    });
    assert.equal(selfPw.status, 200);
    // ...but cannot touch anyone else.
    const otherPw = await app.request("/api/users/admin", {
      method: "PATCH",
      headers: userH,
      body: JSON.stringify({ currentPassword: "x", password: "y" }),
    });
    assert.equal(otherPw.status, 403);

    // Admin cannot demote/delete/disable the last admin.
    for (const body of [{ role: "user" }, { disabled: true }]) {
      const r = await app.request("/api/users/admin", {
        method: "PATCH",
        headers: adminH2,
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 409);
    }
    // Add a second admin, then demoting the first is fine.
    await app.request("/api/users", {
      method: "POST",
      headers: adminH2,
      body: JSON.stringify({ username: "admin2", password: "admin2-pass", role: "admin" }),
    });
    const demote = await app.request("/api/users/admin", {
      method: "PATCH",
      headers: adminH2,
      body: JSON.stringify({ role: "user" }),
    });
    assert.equal(demote.status, 200);
    // Admin cannot delete their own account.
    const selfDel = await app.request("/api/users/admin2", {
      method: "DELETE",
      headers: await login("admin2", "admin2-pass"),
    });
    assert.equal(selfDel.status, 409);
    // Public auth status reflects the configured user base.
    const status = await app.request("/api/auth/status");
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { usersConfigured: true, mode: "live" });
    void normalizeUsername;
  } finally {
    await fresh.close();
    await rm(dir, { recursive: true, force: true });
  }
});
