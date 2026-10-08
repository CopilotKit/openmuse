import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Context } from "hono";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { resolveRequestKey } from "../apps/server/src/rate-limit.ts";
import {
  baseSecurityHeaders,
  contentSecurityPolicy,
  frameAncestorSources,
  isSignedRoute,
  permissionsPolicy,
} from "../apps/server/src/security-headers.ts";
import { createSamplePdf } from "../packages/integrations/src/pdf.ts";

let db: Store,
  app: Awaited<ReturnType<typeof createApp>>["app"],
  auth: Awaited<ReturnType<typeof createApp>>["auth"],
  agent: Awaited<ReturnType<typeof createApp>>["agent"],
  config: Config,
  token: string,
  directory: string;

const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-server-edge-"));
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
  ({ app, auth, agent } = await createApp(db, config));
  const response = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  token = (await response.json()).token;
});

after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

const framing = "frame-ancestors 'self' http://localhost:8081 http://localhost:8787";
const strictCsp = `default-src 'none'; base-uri 'none'; form-action 'none'; ${framing}`;

test("JSON responses carry the full hardening headers and no HSTS on plaintext", async () => {
  const response = await app.request("/api/health", { headers: headers() });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-security-policy"), strictCsp);
  assert.ok(
    response.headers.get("permissions-policy")?.includes("camera=()"),
    "powerful features are denied",
  );
  assert.equal(response.headers.get("strict-transport-security"), null);
});

test("rejected origins still receive the hardening headers", async () => {
  const response = await app.request("/api/workspace", {
    headers: { ...headers(), Origin: "https://unrelated.example" },
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-security-policy"), strictCsp);
});

test("signed file bytes allow first-party framing but no content directives", async () => {
  const bytes = await createSamplePdf();
  const file = await agent.files.import("local-user", "edge.pdf", bytes, "fixture");
  const url = new URL(auth.sign("local-user", `/api/files/${file.id}/content`));
  const response = await app.request(`${url.pathname}${url.search}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("content-security-policy"), framing);
  // The iframe PDF viewer needs fullscreen; JSON responses keep it denied.
  assert.equal(
    response.headers.get("permissions-policy")?.includes("fullscreen"),
    false,
    "file downloads must not deny fullscreen",
  );
  const json = await app.request("/api/health", { headers: headers() });
  assert.ok(json.headers.get("permissions-policy")?.includes("fullscreen=()"));
});

test("readiness reports the database instead of a static ok", async () => {
  const response = await app.request("/api/ready");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, mode: "sample", database: "up" });
});

test("readiness fails closed when the database is unreachable", async (t) => {
  t.mock.method(db, "ping", async () => {
    throw new Error("postgres gone");
  });
  const response = await app.request("/api/ready");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, mode: "sample", database: "down" });
});

test("readiness times out instead of queueing behind a slow query", async (t) => {
  t.mock.method(db, "ping", () => new Promise<void>(() => {}));
  const started = Date.now();
  const response = await app.request("/api/ready");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, mode: "sample", database: "down" });
  assert.ok(Date.now() - started < 5000, "the probe must be bounded");
});

test("concurrent readiness checks share one in-flight probe", async (t) => {
  // Fresh app: the timeout test above leaves the shared app's coalesced probe
  // pending forever (its mocked ping never resolves), so isolation matters here.
  let sharedDb: Store | undefined;
  let sharedDirectory = "";
  try {
    sharedDirectory = await mkdtemp(join(tmpdir(), "openmuse-server-edge-shared-"));
    sharedDb = await createStore();
    const sharedConfig: Config = { ...config, dataDir: sharedDirectory };
    const { app: shared } = await createApp(sharedDb, sharedConfig);
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.mock.method(sharedDb, "ping", async () => {
      calls += 1;
      await gate;
    });
    const first = shared.request("/api/ready");
    const second = shared.request("/api/ready");
    setTimeout(() => release?.(), 50);
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(calls, 1, "concurrent checks must not queue extra database queries");
  } finally {
    await sharedDb?.close();
    if (sharedDirectory) await rm(sharedDirectory, { recursive: true, force: true });
  }
});

test("health and readiness stay outside the shared rate budget", async () => {
  let probeDb: Store | undefined;
  let probeDirectory = "";
  try {
    probeDirectory = await mkdtemp(join(tmpdir(), "openmuse-server-edge-probe-"));
    probeDb = await createStore();
    const probeConfig: Config = { ...config, dataDir: probeDirectory };
    const { app: probe } = await createApp(probeDb, probeConfig);
    for (let i = 0; i < 130; i += 1) await probe.request("/api/workspace");
    assert.equal((await probe.request("/api/workspace")).status, 429);
    assert.equal((await probe.request("/api/health")).status, 200);
    assert.equal((await probe.request("/api/ready")).status, 200);
  } finally {
    await probeDb?.close();
    if (probeDirectory) await rm(probeDirectory, { recursive: true, force: true });
  }
});

test("sign-in attempts are budgeted per client instead of globally", async () => {
  let liveDb: Store | undefined;
  let liveDirectory = "";
  try {
    liveDirectory = await mkdtemp(join(tmpdir(), "openmuse-server-edge-live-"));
    liveDb = await createStore();
    const liveConfig: Config = {
      ...config,
      mode: "live",
      agentBackend: "model",
      dataDir: liveDirectory,
      accessKey: "a".repeat(24),
      trustProxy: true,
    };
    const { app: live } = await createApp(liveDb, liveConfig);
    const signIn = (ip: string) =>
      live.request("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: "{}",
      });
    // Wrong keys still count (the limiter runs before auth), but cheaply: no
    // workspace warmup happens on a 401 path.
    for (let attempt = 0; attempt < 10; attempt += 1)
      assert.equal((await signIn("203.0.113.7")).status, 401);
    assert.equal((await signIn("203.0.113.7")).status, 429);
    // A different address is unaffected: the old global limiter would have
    // locked this client out too.
    assert.equal((await signIn("198.51.100.9")).status, 401);
    // Spoofed leftmost entries share the proxy-appended hop, so no new bucket.
    for (let attempt = 0; attempt < 10; attempt += 1)
      assert.equal((await signIn(`10.9.9.${attempt}, 198.51.100.77`)).status, 401);
    assert.equal((await signIn("198.51.100.77")).status, 429);
  } finally {
    await liveDb?.close();
    if (liveDirectory) await rm(liveDirectory, { recursive: true, force: true });
  }
});

test("sign-in flood monitor warns instead of locking everyone out", async () => {
  let capDb: Store | undefined;
  let capDirectory = "";
  try {
    capDirectory = await mkdtemp(join(tmpdir(), "openmuse-server-edge-cap-"));
    capDb = await createStore();
    const capConfig: Config = {
      ...config,
      mode: "live",
      agentBackend: "model",
      dataDir: capDirectory,
      accessKey: "a".repeat(24),
      trustProxy: true,
    };
    const { app: capped } = await createApp(capDb, capConfig);
    const signIn = (ip: string) =>
      capped.request("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: "{}",
      });
    // A hard overall cap would let a few addresses lock everyone else out, so
    // the flood monitor only logs: 101 distinct clients all still get through
    // to auth (401), and per-client budgets still block repeat offenders.
    for (let i = 0; i < 100; i += 1) assert.equal((await signIn(`198.51.100.${i}`)).status, 401);
    assert.equal((await signIn("203.0.113.99")).status, 401);
    for (let attempt = 0; attempt < 10; attempt += 1)
      assert.equal((await signIn("203.0.113.7")).status, 401);
    assert.equal((await signIn("203.0.113.7")).status, 429);
  } finally {
    await capDb?.close();
    if (capDirectory) await rm(capDirectory, { recursive: true, force: true });
  }
});

test("HSTS is advertised only when the public URL is https", async () => {
  let httpsDb: Store | undefined;
  let httpsDirectory = "";
  try {
    httpsDirectory = await mkdtemp(join(tmpdir(), "openmuse-server-edge-https-"));
    httpsDb = await createStore();
    const httpsConfig: Config = {
      ...config,
      publicUrl: "https://example.com",
      googleRedirectUri: "https://example.com/api/google/callback",
      dataDir: httpsDirectory,
    };
    const { app: https } = await createApp(httpsDb, httpsConfig);
    const response = await https.request("/api/health");
    assert.equal(
      response.headers.get("strict-transport-security"),
      "max-age=15552000; includeSubDomains",
    );
    assert.equal(
      response.headers.get("content-security-policy"),
      `default-src 'none'; base-uri 'none'; form-action 'none'; ` +
        `frame-ancestors 'self' http://localhost:8081 https://example.com`,
    );
  } finally {
    await httpsDb?.close();
    if (httpsDirectory) await rm(httpsDirectory, { recursive: true, force: true });
  }
});

test("contentSecurityPolicy keeps console allowances and framing per route", () => {
  const consolePolicy = contentSecurityPolicy("GET", "/api/browsers/abc/console", config);
  assert.ok(consolePolicy.includes("script-src 'unsafe-inline'"));
  assert.ok(consolePolicy.includes(framing));
  assert.equal(contentSecurityPolicy("GET", "/api/browsers/abc/preview", config), framing);
  assert.equal(contentSecurityPolicy("GET", "/api/files/abc/content", config), framing);
  assert.equal(contentSecurityPolicy("POST", "/api/browsers/abc/console", config), strictCsp);
  assert.equal(contentSecurityPolicy("GET", "/api/workspace", config), strictCsp);
});

test("frameAncestorSources trims, dedupes, and drops unparseable entries", () => {
  assert.deepEqual(frameAncestorSources(config), [
    "'self'",
    "http://localhost:8081",
    "http://localhost:8787",
  ]);
  assert.deepEqual(
    frameAncestorSources({
      ...config,
      allowedOrigins: [" https://a.example/extra ,", "https://a.example", "not a url", ""],
    }),
    ["'self'", "https://a.example", "http://localhost:8787"],
  );
});

test("baseSecurityHeaders gates HSTS on the public scheme", () => {
  assert.equal(baseSecurityHeaders(config)["Strict-Transport-Security"], undefined);
  assert.equal(
    baseSecurityHeaders({ ...config, publicUrl: "https://example.com" })[
      "Strict-Transport-Security"
    ],
    "max-age=15552000; includeSubDomains",
  );
});

test("resolveRequestKey honors proxy headers only when trusted", () => {
  const context = (forwardedFor?: string) =>
    ({
      req: { header: (name: string) => (name === "x-forwarded-for" ? forwardedFor : null) },
    }) as unknown as Context;
  assert.ok(resolveRequestKey(context("203.0.113.7"), true).includes("203.0.113.7"));
  assert.equal(resolveRequestKey(context("203.0.113.7"), false).includes("203.0.113.7"), false);
});

test("signed routes share one list between auth and headers", () => {
  assert.equal(isSignedRoute("/api/files/abc/content"), true);
  assert.equal(isSignedRoute("/api/browsers/abc/preview"), true);
  assert.equal(isSignedRoute("/api/browsers/abc/console"), true);
  assert.equal(isSignedRoute("/api/workspace"), false);
  assert.equal(isSignedRoute("/api/files/abc/fill"), false);
});

test("permissionsPolicy keeps fullscreen for file downloads only", () => {
  assert.equal(permissionsPolicy("GET", "/api/files/abc/content").includes("fullscreen"), false);
  assert.ok(permissionsPolicy("GET", "/api/workspace").includes("fullscreen=()"));
  assert.ok(permissionsPolicy("GET", "/api/browsers/abc/preview").includes("fullscreen=()"));
});
