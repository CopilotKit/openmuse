import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import {
  createRateLimitStore,
  rateLimit,
  resolveClientKey,
} from "../apps/server/src/rate-limit.ts";

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

  // Only the hop our own proxy appended (the last entry) is trusted: the
  // leftmost entry is caller-controlled and must not mint a new bucket.
  const trustedA = resolveClientKey({ trustProxy: true, forwardedFor: "1.2.3.4, 10.0.0.1" });
  const trustedB = resolveClientKey({ trustProxy: true, forwardedFor: "5.6.7.8, 10.0.0.1" });
  assert.equal(
    trustedA,
    trustedB,
    "spoofed leftmost entries sharing one proxy hop must share one bucket",
  );
  const trustedC = resolveClientKey({ trustProxy: true, forwardedFor: "1.2.3.4, 10.0.0.2" });
  assert.notEqual(trustedA, trustedC, "distinct proxy-appended hops get distinct buckets");

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
  // At capacity the oldest entry is evicted so newcomers are never locked out.
  assert.equal(store.take("c", 500), true, "a brand-new key evicts the oldest entry");
  assert.equal(store.size(), 2, "the map must never exceed maxEntries");

  // Once "b" and "c" expire, capacity should be reclaimed for a new key.
  assert.equal(store.take("d", 2000), true);
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

test("session token rotation does not create new pre-auth buckets", async () => {
  let lastStatus = 200;
  for (let i = 0; i < 121; i++) {
    const token = i % 2 ? "rotated-token" : `rotated-token-${i}`;
    const response = await app.request("/api/workspace", {
      headers: { Authorization: `Bearer ${token}` },
    });
    lastStatus = response.status;
  }
  assert.equal(lastStatus, 429, "rotating tokens from one connection must share one bucket");
});

test("unauthenticated requests cannot multiply buckets by spoofing X-Forwarded-For", async () => {
  let lastStatus = 200;
  for (let i = 0; i < 121; i++) {
    // /api/health and /api/ready are exempt (load-balancer probes), so exercise
    // a rate-limited route instead.
    const response = await app.request("/api/workspace", {
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

function limitedApp(options: Parameters<typeof rateLimit>[1]) {
  const app = new Hono();
  app.onError((error, c) =>
    c.json({ error: error.message }, "status" in error ? (error.status as 429) : 500),
  );
  app.use("/api/*", rateLimit(false, options));
  app.get("/api/ping", (c) => c.text("ok"));
  return app;
}

test("spoofed bearer tokens from one connection share a single bucket", async () => {
  let address = "203.0.113.1";
  const app = limitedApp({ maxRequests: 3, maxEntries: 5, getAddress: () => address });
  const statuses: number[] = [];
  for (let i = 0; i < 20; i++) {
    const response = await app.request("/api/ping", {
      headers: { Authorization: `Bearer fake-${i}` },
    });
    statuses.push(response.status);
  }
  assert.deepEqual(statuses.slice(0, 4), [200, 200, 200, 429]);
  assert.ok(statuses.slice(3).every((status) => status === 429));

  // Fake tokens did not consume the shared capacity: other connections still get in.
  address = "203.0.113.2";
  const other = await app.request("/api/ping", { headers: { Authorization: "Bearer fake-x" } });
  assert.equal(other.status, 200);
});

test("capacity exhaustion evicts the oldest entry instead of locking out", async () => {
  const addresses = ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"];
  let current = 0;
  const app = limitedApp({ maxEntries: 3, windowMs: 60_000, getAddress: () => addresses[current] });
  const statuses: number[] = [];
  for (current = 0; current < 4; current++) {
    statuses.push((await app.request("/api/ping")).status);
  }
  assert.deepEqual(
    statuses,
    [200, 200, 200, 200],
    "the fourth connection evicts the oldest entry instead of locking out",
  );
  current = 1;
  assert.equal((await app.request("/api/ping")).status, 200, "existing entries keep working");
});

test("an evicted entry restarts with a fresh budget", () => {
  const store = createRateLimitStore({ windowMs: 60_000, maxRequests: 1, maxEntries: 2 });
  assert.equal(store.take("a", 0), true);
  assert.equal(store.take("b", 0), true);
  // At capacity "c" evicts "a" (least recently used).
  assert.equal(store.take("c", 1), true);
  // The dropped key gets a fresh bucket rather than inheriting its old count.
  assert.equal(store.take("a", 2), true, "evicted key restarts at count 1");
  assert.equal(store.take("a", 3), false, "but the fresh bucket still enforces its limit");
});

test("recently active entries survive eviction over idle ones", () => {
  const store = createRateLimitStore({ windowMs: 60_000, maxRequests: 2, maxEntries: 3 });
  assert.equal(store.take("a", 0), true);
  assert.equal(store.take("a", 1), true, "a is now at its limit (count 2)");
  assert.equal(store.take("b", 2), true);
  assert.equal(store.take("c", 3), true);
  // Touch "b" so recency order is a, c, b; the next newcomer must evict "a".
  assert.equal(store.take("b", 4), true, "b reaches its limit (count 2)");
  assert.equal(store.take("d", 5), true, "newcomer evicts least-recently-active entry");
  // "a" was evicted and restarts fresh; "b" kept its exhausted count.
  assert.equal(store.take("a", 6), true, "evicted entry restarts fresh");
  assert.equal(store.take("b", 6), false, "recently active entry keeps its count");
});

test("capacity exhaustion reclaims expired entries", () => {
  const store = createRateLimitStore({ windowMs: 1000, maxEntries: 3 });
  for (const key of ["conn:a", "conn:b", "conn:c"]) assert.equal(store.take(key, 0), true);
  // At capacity the oldest entry is evicted for the newcomer.
  assert.equal(store.take("conn:d", 500), true);
  assert.equal(store.take("conn:d", 1500), true);
  assert.equal(store.size(), 1);
});
