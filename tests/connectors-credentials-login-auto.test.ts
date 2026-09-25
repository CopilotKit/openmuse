import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { type TestContext } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { credentialChatTools } from "../apps/server/src/connectors/credentials/tools.ts";
import type { BrowserSession } from "../packages/domain/src/index.ts";
import { browserFixture } from "./helpers/browser.ts";

const sessionId = "00000000-0000-4000-8000-000000000001";
const owner = "local-user";

function makeSession(url: string): BrowserSession {
  return {
    id: sessionId,
    title: "Test page",
    url,
    status: "active",
    updatedAt: "2026-09-22T00:00:00.000Z",
  };
}

async function setup(t: TestContext) {
  const fills: { path: string; body: Record<string, unknown> }[] = [];
  const fixture = await browserFixture(t, (path, body) => {
    if (path.endsWith("/fill")) {
      fills.push({ path, body });
      return {
        data: { ...makeSession("https://example.com/portal/"), filled: true, submitted: true },
      };
    }
    return { data: makeSession("https://example.com/portal/") };
  });
  const { db, config } = fixture;
  config.encryptionKey = randomBytes(32).toString("base64");
  const { app, auth, agent, credentials } = await createApp(db, config);
  assert.ok(credentials, "the credentials plugin must load for this test");
  t.after(() => agent.stop());
  const { token } = await auth.session();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  async function saveCredential(input: {
    label: string;
    domain: string;
    username: string;
    password: string;
  }) {
    const created = await app.request("/api/credentials", {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    assert.equal(created.status, 201);
    return created.json() as Promise<{ id: string; label: string }>;
  }
  async function openOn(url: string) {
    await db.put(owner, "browsers", makeSession(url));
  }
  return { db, app, headers, credentials, fills, saveCredential, openOn };
}

test("loginAuto fills the single matching credential with no label needed", async (t) => {
  const { credentials, fills, saveCredential, openOn } = await setup(t);
  await saveCredential({
    label: "Example Site",
    domain: "example.com",
    username: "admin",
    password: "top-secret-pw",
  });
  await openOn("https://example.com/portal/");

  const result = await credentials.loginAuto(owner, sessionId);
  assert.ok(result.ok);
  assert.equal(result.label, "Example Site");
  assert.equal(result.hostname, "example.com");
  assert.equal(fills.length, 1);
  assert.equal(fills[0].body.expectedDomain, "example.com");
  assert.equal(fills[0].body.password, "top-secret-pw");
});

test("loginAuto matches a subdomain session against the parent-domain login", async (t) => {
  const { credentials, fills, saveCredential, openOn } = await setup(t);
  await saveCredential({
    label: "Example",
    domain: "example.com",
    username: "jo@example.com",
    password: "pw",
  });
  await openOn("https://studio.example.com/dashboard");

  const result = await credentials.loginAuto(owner, sessionId);
  assert.ok(result.ok);
  assert.equal(result.hostname, "studio.example.com");
  assert.equal(fills.length, 1);
});

test("loginAuto returns a choice when several logins match, and fills nothing", async (t) => {
  const { credentials, fills, saveCredential, openOn } = await setup(t);
  await saveCredential({
    label: "Example Site admin",
    domain: "example.com",
    username: "admin",
    password: "pw-one",
  });
  await saveCredential({
    label: "Example Site editor",
    domain: "example.com",
    username: "editor@example.com",
    password: "pw-two",
  });
  await openOn("https://example.com/portal/");

  const result = await credentials.loginAuto(owner, sessionId);
  assert.ok(!result.ok && result.needsChoice);
  assert.equal(result.hostname, "example.com");
  assert.equal(result.options.length, 2);
  assert.deepEqual(result.options.map((o) => o.label).sort(), [
    "Example Site admin",
    "Example Site editor",
  ]);
  // Hints are redacted, and no secret material leaks into the choice.
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("pw-one") && !serialized.includes("pw-two"));
  assert.ok(serialized.includes("a***"));
  assert.equal(fills.length, 0);

  // Picking one by label then works.
  const picked = await credentials.login(owner, { label: "Example Site editor" }, sessionId);
  assert.equal(picked.ok, true);
  assert.equal(picked.label, "Example Site editor");
  assert.equal(fills.length, 1);
});

test("loginAuto reports cleanly when no login is saved for the site", async (t) => {
  const { credentials, fills, saveCredential, openOn } = await setup(t);
  await saveCredential({
    label: "Example",
    domain: "example.com",
    username: "jo",
    password: "pw",
  });
  await openOn("https://unknown-site.org/login");

  await assert.rejects(
    credentials.loginAuto(owner, sessionId),
    /No saved login for unknown-site\.org/,
  );
  assert.equal(fills.length, 0);
});

test("loginAuto can never fill a credential into a non-matching domain", async (t) => {
  const { credentials, fills, saveCredential, openOn } = await setup(t);
  await saveCredential({
    label: "Example",
    domain: "example.com",
    username: "jo@example.com",
    password: "pw",
  });
  // Lookalike and unrelated domains are not candidates.
  await openOn("https://example.com.evil.com/login");
  await assert.rejects(credentials.loginAuto(owner, sessionId), /No saved login/);
  await openOn("https://other.com/");
  await assert.rejects(credentials.loginAuto(owner, sessionId), /No saved login/);
  assert.equal(fills.length, 0);
});

test("POST /api/credentials/login-auto: ok, choice, and no-match", async (t) => {
  const { app, headers, fills, saveCredential, openOn } = await setup(t);
  await saveCredential({
    label: "Example Site",
    domain: "example.com",
    username: "admin",
    password: "pw",
  });
  await openOn("https://example.com/portal/");

  const ok = await app.request("/api/credentials/login-auto", {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId }),
  });
  assert.equal(ok.status, 200);
  const receipt = await ok.json();
  assert.equal(receipt.ok, true);
  assert.equal(receipt.hostname, "example.com");
  assert.equal(fills.length, 1);

  await saveCredential({
    label: "Example Site second",
    domain: "example.com",
    username: "second",
    password: "pw2",
  });
  const choice = await app.request("/api/credentials/login-auto", {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId }),
  });
  assert.equal(choice.status, 409);
  const choiceBody = await choice.json();
  assert.equal(choiceBody.needsChoice, true);
  assert.equal(choiceBody.options.length, 2);
  assert.ok(!JSON.stringify(choiceBody).includes("pw2"));

  await openOn("https://no-login-here.net/");
  const missing = await app.request("/api/credentials/login-auto", {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId }),
  });
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /No saved login for no-login-here\.net/);
});

test("chat tool browser_login: label is optional, auto-match fills, choice asks", async (t) => {
  const { credentials, fills, saveCredential, openOn } = await setup(t);
  await saveCredential({
    label: "Example Site",
    domain: "example.com",
    username: "admin",
    password: "pw",
  });
  await openOn("https://example.com/portal/");

  const [tool] = credentialChatTools(credentials, owner);
  const execute = (tool as unknown as { execute: (args: unknown) => Promise<unknown> }).execute;

  // No label → auto-match fills the single saved login.
  const filled = (await execute({ sessionId })) as { ok: boolean; site: string };
  assert.equal(filled.ok, true);
  assert.equal(filled.site, "example.com");
  assert.equal(fills.length, 1);

  // A second login for the same domain → the tool asks which one.
  await saveCredential({
    label: "Example Site backup",
    domain: "example.com",
    username: "backup",
    password: "pw2",
  });
  const choice = (await execute({ sessionId })) as {
    needsChoice: boolean;
    options: { label: string }[];
  };
  assert.equal(choice.needsChoice, true);
  assert.equal(choice.options.length, 2);
  assert.equal(fills.length, 1);

  // Explicit label still works (the user's pick).
  const picked = (await execute({ label: "Example Site backup", sessionId })) as { ok: boolean };
  assert.equal(picked.ok, true);
  assert.equal(fills.length, 2);

  // No saved login → clean error, no fill.
  await openOn("https://nothing-saved.example/");
  const missing = (await execute({ sessionId })) as { error: string };
  assert.match(missing.error, /No saved login for nothing-saved\.example/);
  assert.equal(fills.length, 2);

  // The tool description tells the model the user's "log in" words are
  // authorization — the refusal that caused the bug must not come back.
  const description = (tool as unknown as { description: string }).description;
  assert.match(description, /those words are the authorization/i);
});

test("explicit label login on a mismatched domain is still refused", async (t) => {
  const { credentials, fills, saveCredential, openOn } = await setup(t);
  await saveCredential({
    label: "Example",
    domain: "example.com",
    username: "jo",
    password: "pw",
  });
  await openOn("https://evil.com/login");
  await assert.rejects(
    credentials.login(owner, { label: "Example" }, sessionId),
    /cannot be used on evil\.com/,
  );
  assert.equal(fills.length, 0);
});
