import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { domainMatches, usernameHint } from "../apps/server/src/connectors/credentials/service.ts";
import type { BrowserSession } from "../packages/domain/src/index.ts";
import { browserFixture } from "./helpers/browser.ts";

const sessionId = "00000000-0000-4000-8000-000000000001";
const savedSession: BrowserSession = {
  id: sessionId,
  title: "Example login",
  url: "https://accounts.example.com/login",
  status: "active",
  updatedAt: "2026-09-22T00:00:00.000Z",
};

test("domain lock accepts the domain and subdomains, rejects lookalikes", () => {
  assert.equal(domainMatches("accounts.example.com", "accounts.example.com"), true);
  assert.equal(domainMatches("deep.accounts.example.com", "accounts.example.com"), true);
  assert.equal(domainMatches("ACCOUNTS.EXAMPLE.COM", "accounts.example.com"), true);
  assert.equal(domainMatches("evil-accounts.example.com", "accounts.example.com"), false);
  assert.equal(domainMatches("accounts.example.com.evil.com", "accounts.example.com"), false);
  assert.equal(domainMatches("example.com", "accounts.example.com"), false);
});

test("username hints never reveal the full username or password", () => {
  assert.equal(usernameHint("jo@example.com"), "jo***@example.com");
  assert.equal(usernameHint("a@example.com"), "a***@example.com");
  assert.equal(usernameHint("admin"), "a***");
  assert.ok(!usernameHint("jo@example.com").includes("secret"));
});

test("credential API stores encrypted secrets and serves metadata only", async (t) => {
  const fills: { path: string; body: Record<string, unknown> }[] = [];
  let fillStatus = 200;
  const { db, config } = await browserFixture(t, (path, body) => {
    if (path.endsWith("/fill")) {
      fills.push({ path, body });
      if (fillStatus !== 200)
        return {
          status: fillStatus,
          data: { error: { code: "DOMAIN_MISMATCH", message: "Worker refused: wrong site." } },
        };
      return { data: { ...savedSession, filled: true, submitted: true } };
    }
    return { data: savedSession };
  });
  config.encryptionKey = randomBytes(32).toString("base64");
  const { app, auth, agent } = await createApp(db, config);
  t.after(() => agent.stop());
  const { token } = await auth.session();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const owner = "local-user";

  await db.put(owner, "browsers", savedSession);

  // Create.
  const created = await app.request("/api/credentials", {
    method: "POST",
    headers,
    body: JSON.stringify({
      label: "Example",
      domain: "https://accounts.example.com/login",
      username: "jo@example.com",
      password: "s3cret-password",
    }),
  });
  assert.equal(created.status, 201);
  const credential = await created.json();
  assert.equal(credential.domain, "accounts.example.com");
  assert.equal(credential.usernameHint, "jo***@example.com");
  assert.ok(!("secret" in credential) && !("password" in credential));
  assert.ok(!JSON.stringify(credential).includes("s3cret-password"));

  // Stored record is encrypted.
  const stored = await db.get<{ secret: string }>(owner, "browser-credentials", credential.id);
  assert.ok(stored?.secret && !stored.secret.includes("s3cret-password"));

  // List serves metadata only.
  const listed = await app.request("/api/credentials", { headers });
  assert.equal(listed.status, 200);
  const items = await listed.json();
  assert.equal(items.length, 1);
  assert.ok(!JSON.stringify(items).includes("s3cret-password"));

  // Login on a mismatched domain is refused before touching the worker.
  await db.put(owner, "browsers", { ...savedSession, url: "https://evil.com/login" });
  const denied = await app.request(`/api/credentials/${credential.id}/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId }),
  });
  assert.equal(denied.status, 403);
  assert.ok(!(await denied.json()).error.includes("s3cret-password"));
  assert.equal(fills.length, 0);

  // Login on the matching domain fills worker-side.
  await db.put(owner, "browsers", savedSession);
  const loggedIn = await app.request(`/api/credentials/${credential.id}/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId }),
  });
  assert.equal(loggedIn.status, 200);
  assert.deepEqual(await loggedIn.json(), {
    ok: true,
    label: "Example",
    domain: "accounts.example.com",
    hostname: "accounts.example.com",
  });
  assert.equal(fills.length, 1);
  assert.equal(fills[0].path, `/sessions/${sessionId}/fill`);
  assert.deepEqual(fills[0].body, {
    username: "jo@example.com",
    password: "s3cret-password",
    expectedDomain: "accounts.example.com",
  });

  // An audit receipt exists with no secret material.
  const activity = await db.list<{ title: string; detail: string }>(owner, "activity");
  const receipt = activity.find((entry) => entry.title === "Browser login · Example");
  assert.ok(receipt);
  assert.ok(!`${receipt.title} ${receipt.detail}`.includes("s3cret-password"));

  // Password rotation takes effect on the next login.
  const updated = await app.request(`/api/credentials/${credential.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ password: "n3w-password" }),
  });
  assert.equal(updated.status, 200);
  const relogin = await app.request(`/api/credentials/${credential.id}/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId }),
  });
  assert.equal(relogin.status, 200);
  assert.equal(fills[1].body.password, "n3w-password");

  // A worker-side domain refusal surfaces as a failed login (worker errors
  // are reported as 502 with the worker's message preserved).
  fillStatus = 403;
  const refused = await app.request(`/api/credentials/${credential.id}/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId }),
  });
  assert.equal(refused.status, 502);
  assert.match((await refused.json()).error, /wrong site/);
  fillStatus = 200;

  // Delete removes the credential.
  const removed = await app.request(`/api/credentials/${credential.id}`, {
    method: "DELETE",
    headers,
  });
  assert.equal(removed.status, 200);
  const gone = await app.request(`/api/credentials/${credential.id}/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId }),
  });
  assert.equal(gone.status, 404);
});

test("credential creation requires the encryption key", async (t) => {
  const { db, config } = await browserFixture(t, () => ({ data: {} }));
  config.encryptionKey = undefined;
  const { app, auth, agent } = await createApp(db, config);
  t.after(() => agent.stop());
  const { token } = await auth.session();
  const response = await app.request("/api/credentials", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      label: "Example",
      domain: "accounts.example.com",
      username: "jo@example.com",
      password: "s3cret",
    }),
  });
  assert.equal(response.status, 503);
});
