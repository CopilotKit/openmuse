import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { GoogleAuth } from "../apps/server/src/google-auth.ts";
import { encryptSecret } from "../packages/integrations/src/vault.ts";

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Promise was not initialized");
  };
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function oauthConfig(): Config {
  return {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: "unused",
    agentBackend: "model",
    intelligenceUserId: "local-user",
    allowedOrigins: [],
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    googleClientId: "synthetic-client",
    googleClientSecret: "synthetic-secret",
    encryptionKey: randomBytes(32).toString("base64"),
  };
}

test("old refresh cannot overwrite a newly connected Google account", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const key = randomBytes(32).toString("base64");
  const config: Config = {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: "unused",
    agentBackend: "model",
    intelligenceUserId: "local-user",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    encryptionKey: key,
  };
  const a = {
    connectionId: "connection-a",
    accessToken: "old-a",
    refreshToken: "refresh-a",
    expiresAt: 0,
    scopes: [],
    account: "a@example.com",
  };
  const b = {
    ...a,
    connectionId: "connection-b",
    accessToken: "new-b",
    account: "b@example.com",
    expiresAt: Date.now() + 3600000,
  };
  await db.put("owner", "credentials", {
    id: "google",
    connectionId: a.connectionId,
    secret: encryptSecret(JSON.stringify(a), key),
  });
  let release: ((response: Response) => void) | undefined;
  let started: (() => void) | undefined;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  t.mock.method(globalThis, "fetch", () => {
    started?.();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const auth = new GoogleAuth(db, config);
  const refresh = auth.accessToken("owner", "connection-a");
  await requested;
  await db.put("owner", "credentials", {
    id: "google",
    connectionId: b.connectionId,
    secret: encryptSecret(JSON.stringify(b), key),
  });
  release?.(Response.json({ access_token: "refreshed-a", expires_in: 3600 }));
  await assert.rejects(refresh, /account changed/i);
  assert.equal((await auth.tokens("owner"))?.account, "b@example.com");
  await assert.rejects(auth.accessToken("owner", "connection-a"), /connection changed/i);
});

test("OAuth callbacks require a known, single-use state", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const config: Config = {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: "unused",
    agentBackend: "model",
    intelligenceUserId: "local-user",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
  const auth = new GoogleAuth(db, config);
  await assert.rejects(auth.callback("unknown-state", "untrusted-code"), /expired/);
  await db.put("system", "oauth", {
    id: "expired",
    owner: "owner",
    verifier: "example",
    scopes: [],
    expiresAt: Date.now() - 1,
  });
  await assert.rejects(auth.callback("expired", "untrusted-code"), /expired/);
  assert.equal(await db.get("system", "oauth", "expired"), null);
});

for (const stage of ["token", "profile"]) {
  test(`disconnect invalidates an OAuth callback suspended during ${stage}`, async (t) => {
    const db = await createStore();
    t.after(() => db.close());
    const auth = new GoogleAuth(db, oauthConfig());
    const { url } = await auth.connect("callback-race", true);
    const state = new URL(url).searchParams.get("state");
    assert.ok(state);
    const started = deferred<void>();
    const release = deferred<void>();
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const isToken = String(input).includes("/token");
      if (isToken === (stage === "token")) {
        started.resolve();
        await release.promise;
      }
      return Response.json(
        isToken
          ? { access_token: "callback-access", refresh_token: "callback-refresh", expires_in: 3600 }
          : { emailAddress: "callback@example.com" },
      );
    });
    const callback = auth.callback(state, "synthetic-code");
    await started.promise;
    await auth.disconnect("callback-race");
    release.resolve();
    await assert.rejects(callback, /disconnect|expired|changed/i);
    assert.equal(await auth.tokens("callback-race"), null);
  });
}

test("disconnect invalidates pending OAuth state before a callback contacts Google", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const auth = new GoogleAuth(db, oauthConfig());
  const { url } = await auth.connect("pending-owner", false);
  const state = new URL(url).searchParams.get("state");
  assert.ok(state);
  await auth.disconnect("pending-owner");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    calls++;
    return Response.json(
      String(input).includes("/token")
        ? { access_token: "unused", expires_in: 3600 }
        : { emailAddress: "unused@example.com" },
    );
  });
  await assert.rejects(auth.callback(state, "synthetic-code"), /disconnect|expired|changed/i);
  assert.equal(calls, 0);
});

test("a newer connect attempt invalidates an older callback already exchanging its code", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const auth = new GoogleAuth(db, oauthConfig());
  const first = new URL((await auth.connect("reconnect-owner", false)).url).searchParams.get(
    "state",
  );
  assert.ok(first);
  const started = deferred<void>();
  const release = deferred<void>();
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/token")) {
      const old = new URLSearchParams(String(init?.body)).get("code") === "old-code";
      if (old) {
        started.resolve();
        await release.promise;
      }
      return Response.json({ access_token: old ? "old-access" : "new-access", expires_in: 3600 });
    }
    return Response.json({ emailAddress: "new@example.com" });
  });
  const oldCallback = auth.callback(first, "old-code");
  await started.promise;
  const second = new URL((await auth.connect("reconnect-owner", true)).url).searchParams.get(
    "state",
  );
  assert.ok(second);
  await auth.callback(second, "new-code");
  release.resolve();
  await assert.rejects(oldCallback, /disconnect|expired|changed/i);
  assert.equal((await auth.tokens("reconnect-owner"))?.accessToken, "new-access");
});

test("an in-flight refresh cannot restore credentials after disconnect", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const config = oauthConfig();
  assert.ok(config.encryptionKey);
  await db.put("refresh-disconnect", "credentials", {
    id: "google",
    connectionId: "old-connection",
    secret: encryptSecret(
      JSON.stringify({
        connectionId: "old-connection",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: 0,
        scopes: [],
        account: "me@example.com",
      }),
      config.encryptionKey,
    ),
  });
  const started = deferred<void>();
  const release = deferred<void>();
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input).includes("/revoke")) return new Response(null, { status: 200 });
    started.resolve();
    await release.promise;
    return Response.json({ access_token: "refreshed", expires_in: 3600 });
  });
  const auth = new GoogleAuth(db, config);
  const refresh = auth.accessToken("refresh-disconnect");
  await started.promise;
  await auth.disconnect("refresh-disconnect");
  release.resolve();
  await assert.rejects(refresh, /disconnected/i);
  assert.equal(await auth.tokens("refresh-disconnect"), null);
});
