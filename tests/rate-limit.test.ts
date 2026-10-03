import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { createRateLimitStore, resolveClientKey } from "../apps/server/src/rate-limit.ts";

test("resolveClientKey keys authenticated requests by session token, independent of IP", () => {
  const keyA = resolveClientKey({
    authorization: "Bearer token-a",
    trustProxy: false,
    forwardedFor: "1.2.3.4",
  });
  const keyB = resolveClientKey({
    authorization: "Bearer token-b",
    trustProxy: false,
    forwardedFor: "1.2.3.4",
  });
  assert.notEqual(keyA, keyB);
  assert.equal(
    keyA,
    resolveClientKey({
      authorization: "Bearer token-a",
      trustProxy: false,
      forwardedFor: "9.9.9.9",
    }),
  );
});

test("resolveClientKey ignores forwarding headers unless trustProxy is enabled", () => {
  const untrustedA = resolveClientKey({
    trustProxy: false,
    forwardedFor: "1.2.3.4",
    connectionAddress: "10.0.0.1",
  });
  const untrustedB = resolveClientKey({
    trustProxy: false,
    forwardedFor: "5.6.7.8",
    connectionAddress: "10.0.0.1",
  });
  assert.equal(untrustedA, untrustedB, "spoofed X-Forwarded-For must not change the bucket");

  const trustedA = resolveClientKey({ trustProxy: true, forwardedFor: "1.2.3.4, 10.0.0.1" });
  const trustedB = resolveClientKey({ trustProxy: true, forwardedFor: "5.6.7.8, 10.0.0.1" });
  assert.notEqual(trustedA, trustedB, "a trusted proxy header should pick the first (client) hop");

  assert.equal(resolveClientKey({ trustProxy: true, realIp: "1.2.3.4" }), "proxy:1.2.3.4");
});

test("resolveClientKey falls back to a connection-derived key with no headers", () => {
  assert.equal(resolveClientKey({ trustProxy: false }), "conn:unknown");
  assert.equal(
    resolveClientKey({ trustProxy: false, connectionAddress: "127.0.0.1" }),
    "conn:127.0.0.1",
  );
});

test("createRateLimitStore enforces the request limit and resets after the window", () => {
  const store = createRateLimitStore({ windowMs: 1000, maxRequests: 2, maxEntries: 10 });
  assert.equal(store.take("a", 0), true);
  assert.equal(store.take("a", 0), true);
  assert.equal(store.take("a", 0), false, "third request within the window must be rejected");
  assert.equal(store.take("a", 1001), true, "a new window should reset the counter");
});

test("createRateLimitStore caps total entries and evicts expired ones to make room", () => {
  const store = createRateLimitStore({ windowMs: 1000, maxRequests: 5, maxEntries: 2 });
  assert.equal(store.take("a", 0), true);
  assert.equal(store.take("b", 0), true);
  assert.equal(store.size(), 2);
  assert.equal(store.take("c", 500), false, "a brand-new key must be rejected once at capacity");
  assert.equal(store.size(), 2, "the map must never exceed maxEntries");

  // Once "a" and "b" expire, capacity should be reclaimed for a new key.
  assert.equal(store.take("c", 2000), true);
  assert.equal(store.size(), 1);
});

let db: Store, app: Awaited<ReturnType<typeof createApp>>["app"], config: Config, directory: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-ratelimit-"));
  db = await createStore();
  config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  ({ app } = await createApp(db, config));
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

async function login() {
  const response = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  const { token } = await response.json();
  return token as string;
}

test("two authenticated sessions are rate-limited independently", async () => {
  const tokenA = await login();
  const tokenB = await login();
  const headersFor = (token: string) => ({ Authorization: `Bearer ${token}` });

  let lastStatus = 200;
  for (let i = 0; i < 121; i++) {
    const response = await app.request("/api/workspace", { headers: headersFor(tokenA) });
    lastStatus = response.status;
  }
  assert.equal(lastStatus, 429, "session A should eventually be rate-limited");

  const responseB = await app.request("/api/workspace", { headers: headersFor(tokenB) });
  assert.equal(responseB.status, 200, "session B must not be affected by session A's limit");
});

test("unauthenticated requests cannot multiply buckets by spoofing X-Forwarded-For", async () => {
  let lastStatus = 200;
  for (let i = 0; i < 121; i++) {
    const response = await app.request("/api/health", {
      headers: { "X-Forwarded-For": `10.0.0.${i % 255}` },
    });
    lastStatus = response.status;
  }
  assert.equal(
    lastStatus,
    429,
    "spoofed per-request X-Forwarded-For values must not create independent buckets",
  );
});
