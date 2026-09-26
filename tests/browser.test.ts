import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { Auth } from "../apps/server/src/auth.ts";
import { BrowserService } from "../apps/server/src/browser.ts";
import { Files } from "../apps/server/src/files.ts";
import { capturePdfDownload, readDownloadFailures } from "../apps/worker/src/downloads.ts";
import { isPublicIp, validatePublicUrl } from "../apps/worker/src/network.ts";
import { startEgressProxy } from "../apps/worker/src/proxy.ts";
import { createWorkerServer } from "../apps/worker/src/server.ts";
import type { BrowserSession } from "../packages/domain/src/index.ts";
import { browserFixture } from "./helpers/browser.ts";

const sessionId = "00000000-0000-4000-8000-000000000001";
const savedSession: BrowserSession = {
  id: sessionId,
  title: "Saved page",
  url: "https://example.com/",
  status: "active",
  updatedAt: "2026-09-15T00:00:00.000Z",
};

test("browser API reopens an owned profile at the edited address and renews console access", async (t) => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const { db, config } = await browserFixture(t, (path, body) => {
    calls.push({ path, body });
    return { data: { ...savedSession, url: body.url } };
  });
  const { app, auth, agent } = await createApp(db, config);
  t.after(() => agent.stop());
  const { token } = await auth.session();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  await db.put("local-user", "browsers", { ...savedSession, status: "closed" });
  const path = `/api/browsers/${sessionId}`;
  const opened = await app.request(`${path}/reopen`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: "https://example.org/" }),
  });
  assert.equal(opened.status, 200);
  assert.equal((await opened.json()).url, "https://example.org/");
  assert.deepEqual(calls[0], {
    path: "/sessions",
    body: { id: sessionId, url: "https://example.org/" },
  });
  assert.equal((await app.request(`${path}/reopen`, { method: "POST", headers })).status, 200);
  assert.equal(
    calls[1]?.body.url,
    "https://example.org/",
    "bodyless reopen keeps the saved address",
  );

  const start = Date.now();
  const clock = t.mock.method(Date, "now", () => start);
  const previous: BrowserSession = await (await app.request(path, { headers })).json();
  assert.ok(previous.consoleUrl);
  clock.mock.mockImplementation(() => start + 16 * 60_000);
  assert.equal((await app.request(previous.consoleUrl)).status, 401);
  const renewed: BrowserSession = await (await app.request(path, { headers })).json();
  assert.ok(renewed.consoleUrl);
  assert.notEqual(renewed.consoleUrl, previous.consoleUrl);
  const console = await app.request(renewed.consoleUrl);
  assert.equal(console.status, 200);
  assert.match(await console.text(), /Text to type in browser/);
  assert.equal((await app.request(path)).status, 401);
  const hiddenId = "00000000-0000-4000-8000-000000000099";
  await db.put("someone-else", "browsers", { ...savedSession, id: hiddenId });
  assert.equal((await app.request(`/api/browsers/${hiddenId}`, { headers })).status, 404);
  assert.equal(
    (await app.request(`/api/browsers/${hiddenId}/reopen`, { method: "POST", headers, body: "{}" }))
      .status,
    404,
  );
  assert.equal(calls.length, 2, "renewal and rejected requests never navigate the browser");
});

test("server reopens the same worker UUID regardless of stale local session status", async (t) => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const { db, service } = await browserFixture(t, (path, body) => {
    calls.push({ path, body });
    return { data: { ...savedSession, url: body.url } };
  });
  for (const status of ["active", "closed", "idle", "error"] as const) {
    await db.put("owner", "browsers", { ...savedSession, status });
    const opened = await service.navigate("owner", sessionId, "https://example.org/");
    assert.equal(opened.id, sessionId);
    assert.deepEqual(calls.at(-1), {
      path: "/sessions",
      body: { id: sessionId, url: "https://example.org/" },
    });
    assert.equal((await service.get("owner", sessionId)).url, "https://example.org/");
  }
  await assert.rejects(service.navigate("stranger", sessionId, "https://example.org/"), {
    status: 404,
  });
  assert.equal(calls.length, 4);
});

test("console input persists the worker's current page title and URL", async (t) => {
  const updated = { ...savedSession, title: "New page", url: "https://example.org/" };
  const { db, service } = await browserFixture(t, () => ({ data: updated }));
  await db.put("owner", "browsers", savedSession);
  const result = await service.input("owner", sessionId, { type: "key", key: "Enter" });
  assert.equal(result.title, updated.title);
  assert.deepEqual(await service.get("owner", sessionId), updated);
});

test("failed creation remains app-visible and can be retried with its original UUID", async (t) => {
  let failing = true;
  let requestedId: unknown;
  const { db, service } = await browserFixture(t, (_path, body) => {
    requestedId = body.id;
    return failing
      ? { status: 502, data: { error: { code: "NAVIGATION_FAILED", message: "Page unavailable" } } }
      : { data: { ...savedSession, id: body.id, url: body.url } };
  });
  await assert.rejects(service.create("owner", "https://example.org/"), /Page unavailable/);
  const sessions = await db.list<BrowserSession>("owner", "browsers");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.id, requestedId);
  assert.equal(sessions[0]?.status, "error");
  assert.equal(sessions[0]?.url, "https://example.org/");
  failing = false;
  const result = await service.reopen("owner", sessions[0].id);
  assert.equal(result.id, sessions[0]?.id);
  assert.equal(result.status, "active");
});

test("browser observations reuse an owned profile and reject unowned reads", async (t) => {
  const calls: string[] = [];
  const read = {
    url: "https://example.org/",
    title: "Observed",
    text: "Public page text",
    truncated: false,
  };
  const { db, service } = await browserFixture(t, (path, body) => {
    calls.push(path);
    return {
      data: path.endsWith("/read") ? read : { ...savedSession, id: body.id, url: body.url },
    };
  });
  await db.put("owner", "browsers", savedSession);
  assert.deepEqual(await service.observe("owner", read.url, sessionId), { sessionId, ...read });
  assert.deepEqual(calls, ["/sessions", `/sessions/${sessionId}/read`]);
  assert.equal((await service.get("owner", sessionId)).title, read.title);
  await assert.rejects(service.read("stranger", sessionId), { status: 404 });
  await assert.rejects(service.observe("stranger", read.url, sessionId), { status: 404 });
  assert.equal(calls.length, 2);
  const fresh = await service.observe("owner", read.url);
  assert.notEqual(fresh.sessionId, sessionId);
  assert.equal(fresh.text, read.text);
});

test("cancelled task-style browser observations stop before a follow-up read", async (t) => {
  const controller = new AbortController();
  const calls: string[] = [];
  const { db, service } = await browserFixture(t, (path, body) => {
    calls.push(path);
    controller.abort();
    return { data: { ...savedSession, id: body.id, url: body.url } };
  });
  await assert.rejects(service.observe("owner", savedSession.url, undefined, controller.signal), {
    name: "AbortError",
  });
  assert.deepEqual(calls, ["/sessions"]);
  const [saved] = await db.list<BrowserSession>("owner", "browsers");
  assert.equal(saved?.status, "idle", "cancellation must not persist a browser failure");
});

test("chat browser reads reuse a persisted owned profile across turns and service restarts", async (t) => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let currentUrl = savedSession.url;
  const { db, service, config } = await browserFixture(t, (path, body) => {
    calls.push({ path, body });
    if (path.endsWith("/read"))
      return {
        data: { url: currentUrl, title: "Read page", text: "x".repeat(30_001), truncated: false },
      };
    currentUrl = String(body.url);
    return { data: { ...savedSession, id: body.id, url: currentUrl } };
  });
  const first = await service.observeForThread("owner", "chat-thread", "https://example.org/first");
  assert.equal(first.text.length, 30_000);
  assert.equal(first.truncated, true);
  const auth = new Auth(db, config, "test-signing-key");
  const restarted = new BrowserService(db, config, auth, new Files(db, config, auth));
  for (const status of ["active", "closed", "error", "idle"] as const) {
    await db.put("owner", "browsers", { ...(await service.get("owner", first.sessionId)), status });
    const next = await restarted.observeForThread(
      "owner",
      "chat-thread",
      `https://example.org/${status}`,
    );
    assert.equal(next.sessionId, first.sessionId);
    assert.equal(next.url, `https://example.org/${status}`);
  }
  assert.equal((await db.list("owner", "browsers")).length, 1);
  assert.equal(calls.filter((call) => call.path === "/sessions").length, 5);
  const otherOwner = await restarted.observeForThread("stranger", "chat-thread", savedSession.url);
  assert.notEqual(otherOwner.sessionId, first.sessionId);
  await assert.rejects(restarted.get("stranger", first.sessionId), { status: 404 });
});

test("chat browser retries failed navigation using the reserved profile", async (t) => {
  const ids: unknown[] = [];
  let failing = true;
  const { db, service } = await browserFixture(t, (path, body) => {
    if (path.endsWith("/read"))
      return {
        data: {
          url: savedSession.url,
          title: "Read page",
          text: "Actual contents",
          truncated: true,
        },
      };
    ids.push(body.id);
    return failing
      ? { status: 502, data: { error: { message: "Page unavailable" } } }
      : { data: { ...savedSession, id: body.id } };
  });
  await assert.rejects(
    service.observeForThread("owner", "chat-thread", savedSession.url),
    /Page unavailable/,
  );
  assert.equal((await db.list<BrowserSession>("owner", "browsers"))[0]?.status, "error");
  failing = false;
  const result = await service.observeForThread("owner", "chat-thread", savedSession.url);
  assert.deepEqual(ids, [result.sessionId, result.sessionId]);
  assert.equal(result.text, "Actual contents");
  assert.equal(result.truncated, true);
});

test("concurrent chat reads keep each navigation paired with its page read", async (t) => {
  let currentUrl = savedSession.url;
  const { db, service } = await browserFixture(t, (path, body) => {
    if (path.endsWith("/read"))
      return { data: { url: currentUrl, title: currentUrl, text: currentUrl, truncated: false } };
    currentUrl = String(body.url);
    return { data: { ...savedSession, id: body.id, url: currentUrl } };
  });
  const urls = ["https://example.org/one", "https://example.org/two"];
  const results = await Promise.all(
    urls.map((url) => service.observeForThread("owner", "chat-thread", url)),
  );
  assert.deepEqual(
    results.map((result) => result.text),
    urls,
  );
  assert.equal(results[0].sessionId, results[1].sessionId);
  assert.equal((await db.list("owner", "browsers")).length, 1);
});

test("cancelled chat browser requests do not start navigation or a follow-up read", async (t) => {
  const controller = new AbortController();
  const calls: string[] = [];
  const { db, service } = await browserFixture(t, (path, body) => {
    calls.push(path);
    controller.abort();
    return { data: { ...savedSession, id: body.id } };
  });
  await assert.rejects(
    service.observeForThread("owner", "chat-thread", savedSession.url, controller.signal),
    { name: "AbortError" },
  );
  assert.deepEqual(calls, ["/sessions"]);
  await assert.rejects(
    service.observeForThread("owner", "other-thread", savedSession.url, controller.signal),
    { name: "AbortError" },
  );
  assert.deepEqual(calls, ["/sessions"]);
  assert.equal((await db.list("owner", "browsers")).length, 1);
});

test("browser read fails on missing page text instead of inventing observation content", async (t) => {
  const { db, service } = await browserFixture(t, () => ({
    data: { url: savedSession.url, title: savedSession.title },
  }));
  await db.put("owner", "browsers", savedSession);
  await assert.rejects(service.read("owner", sessionId));
});

test("browser imports return rejected downloads even when no PDF was accepted", async (t) => {
  const failure = {
    id: "00000000-0000-4000-8000-000000000005",
    name: "oversized.pdf",
    code: "DOWNLOAD_TOO_LARGE",
    message: "The download exceeds 10 MiB.",
    createdAt: "2026-09-15T00:00:00.000Z",
  };
  const { db, service } = await browserFixture(t, () => ({
    data: { downloads: [], failures: [failure] },
  }));
  await db.put("owner", "browsers", savedSession);
  assert.deepEqual(await service.imports("owner", sessionId), { files: [], failures: [failure] });
});

test("worker persists unsupported, oversized and interrupted download outcomes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-download-outcomes-"));
  try {
    const cases = [
      { name: "notes.txt", contents: Buffer.from("not a PDF"), code: "UNSUPPORTED_DOWNLOAD" },
      {
        name: "large.pdf",
        contents: Buffer.alloc(10 * 1024 * 1024 + 1),
        code: "DOWNLOAD_TOO_LARGE",
      },
      { name: "cancelled.pdf", contents: null, code: "DOWNLOAD_INTERRUPTED" },
    ];
    for (const item of cases) {
      await capturePdfDownload({
        directory,
        tempDirectory: directory,
        limitReached: false,
        download: {
          suggestedFilename: () => item.name,
          createReadStream: async () => {
            if (!item.contents) throw new Error("Interrupted download");
            return Readable.from([item.contents]);
          },
          cancel: async () => {},
          delete: async () => {},
        },
      });
    }
    const failures = await readDownloadFailures(directory);
    assert.equal(failures.length, 3);
    for (const item of cases) {
      assert.equal(failures.find((failure) => failure.name === item.name)?.code, item.code);
    }
    assert(failures.every((failure) => failure.message && failure.createdAt));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser rejects private, special-use and encoded IP addresses", async () => {
  const blocked = [
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.254",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.51.100.2",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "fc00::1",
    "fd00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "2001::1",
    "2002:7f00:1::1",
    "3fff::1",
  ];
  for (const address of blocked) assert.equal(isPublicIp(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isPublicIp(address), true, address);
  }
  for (const url of [
    "http://2130706433",
    "http://0x7f000001",
    "http://0177.0.0.1",
    "http://127.1",
    "http://[::ffff:127.0.0.1]",
    "http://localhost.",
    "http://host.local",
    "file:///etc/passwd",
    "data:text/html,hello",
    "javascript:alert(1)",
    "https://user:password@example.com",
    "http://example.com:22",
  ])
    await assert.rejects(validatePublicUrl(url), { code: "BLOCKED_URL" }, url);
});

test("browser rejects DNS answers containing any private address and pins public resolution", async () => {
  await assert.rejects(
    validatePublicUrl("https://example.com", async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
    { code: "BLOCKED_URL" },
  );
  const result = await validatePublicUrl("https://example.com/a", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  assert.equal(result.address, "93.184.216.34");
  assert.equal(result.url.href, "https://example.com/a");
});

test("worker protects all controls, validates before launch, and health reveals no sessions", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-worker-"));
  const savedId = "00000000-0000-4000-8000-000000000002";
  const downloadId = "00000000-0000-4000-8000-000000000003";
  const pendingId = "00000000-0000-4000-8000-000000000004";
  const downloadFolder = join(dataDir, savedId, "downloads");
  const outcomeFolder = join(dataDir, savedId, "download-outcomes");
  await mkdir(downloadFolder, { recursive: true });
  await mkdir(outcomeFolder, { recursive: true });
  await writeFile(
    join(outcomeFolder, `${pendingId}.json`),
    JSON.stringify({
      id: pendingId,
      name: "unfinished.pdf",
      status: "pending",
      code: "DOWNLOAD_INTERRUPTED",
      message: "The download was interrupted.",
      createdAt: "2026-09-15T00:00:00.000Z",
    }),
  );
  await writeFile(
    join(dataDir, savedId, "session.json"),
    JSON.stringify({
      id: savedId,
      title: "Saved",
      url: "https://example.com",
      status: "active",
      updatedAt: new Date().toISOString(),
    }),
  );
  await writeFile(
    join(downloadFolder, `${downloadId}.json`),
    JSON.stringify({
      id: downloadId,
      name: "large.pdf",
      size: 10 * 1024 * 1024 + 1,
      mimeType: "application/pdf",
    }),
  );
  await writeFile(join(downloadFolder, `${downloadId}.pdf`), "");
  await truncate(join(downloadFolder, `${downloadId}.pdf`), 10 * 1024 * 1024 + 1);
  const worker = await createWorkerServer({
    token: "test-worker-token-at-least-32-characters",
    dataDir,
  });
  worker.server.listen(0, "127.0.0.1");
  await once(worker.server, "listening");
  const address = worker.server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(`${base}/health`);
    assert.deepEqual(await health.json(), { status: "ok" });
    for (const path of [
      "/sessions",
      "/sessions/invalid/screenshot",
      `/sessions/${savedId}/read`,
      "/anything",
    ]) {
      assert.equal((await fetch(`${base}${path}`)).status, 401);
    }
    const headers = {
      authorization: "Bearer test-worker-token-at-least-32-characters",
      "content-type": "application/json",
    };
    assert.equal((await fetch(`${base}/sessions`, { headers })).status, 200);
    const restored = await (await fetch(`${base}/sessions`, { headers })).json();
    assert.equal(
      restored[0].status,
      "closed",
      "restart must not report a closed browser as active",
    );
    const closedRead = await fetch(`${base}/sessions/${savedId}/read`, { headers });
    assert.equal(closedRead.status, 409);
    assert.equal((await closedRead.json()).error.code, "SESSION_CLOSED");
    const outcomes = await (
      await fetch(`${base}/sessions/${savedId}/downloads`, { headers })
    ).json();
    assert.equal(outcomes.downloads.length, 1);
    assert.equal(outcomes.failures[0]?.code, "DOWNLOAD_INTERRUPTED");
    const oversized = await fetch(`${base}/sessions/${savedId}/downloads/${downloadId}`, {
      headers,
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, "DOWNLOAD_TOO_LARGE");
    const invalidDownload = await fetch(`${base}/sessions/${savedId}/downloads/not-a-uuid`, {
      headers,
    });
    assert.equal(invalidDownload.status, 400);
    const blocked = await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "00000000-0000-4000-8000-000000000001", url: "http://127.0.0.1" }),
    });
    assert.equal(blocked.status, 400);
    assert.equal((await blocked.json()).error.code, "BLOCKED_URL");
    const invalid = await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "../../escape", url: "https://example.com" }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await worker.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("egress proxy blocks HTTP and CONNECT traffic to local network destinations", async () => {
  const proxy = await startEgressProxy();
  const address = new URL(proxy.url);
  try {
    for (const method of ["GET", "CONNECT"]) {
      const status = await new Promise<number>((resolve, reject) => {
        const outgoing = request({
          hostname: address.hostname,
          port: address.port,
          method,
          path: method === "CONNECT" ? "127.0.0.1:443" : "http://127.0.0.1/health",
        });
        outgoing.on("response", (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        outgoing.on("connect", (response, socket) => {
          socket.destroy();
          resolve(response.statusCode ?? 0);
        });
        outgoing.on("error", reject);
        outgoing.end();
      });
      assert.equal(status, 403, method);
    }
  } finally {
    await proxy.close();
  }
});
