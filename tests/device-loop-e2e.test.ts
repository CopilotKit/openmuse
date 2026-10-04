import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { DeviceAgentLoop, type LoopTimers } from "../apps/mobile/src/device-agent-loop.ts";
import {
  type AgentRequester,
  agentExecutor,
  deviceTransport,
} from "../apps/mobile/src/device-protocol.ts";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

/**
 * The mobile work loop against a real server.
 *
 * The unit tests in `device-agent-loop.test.ts` use a fake transport and can only
 * prove the client agrees with itself. This one points the same client code at a
 * real `createApp` instance, so it also proves the client and the server agree:
 * the endpoint paths, the payload shapes, the pairing gate, the lease CAS, and the
 * `409` that tells a device it has been taken over.
 *
 * Requests go through `app.request` rather than a listening socket, which is the
 * same code path minus the port.
 */

const config: Config = {
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: "",
  agentBackend: "sample",
  intelligenceApiKey: "test-key",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
};

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-deviceloop-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const server = await createApp(db, { ...config, dataDir: directory });
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { server, db };
}

type Server = Awaited<ReturnType<typeof createApp>>;

/** A `MuseApi`-shaped requester bound to one device's session token. */
function requester(server: Server, token: string): AgentRequester {
  return {
    async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
      // `body` is omitted rather than set to `undefined`: under
      // `exactOptionalPropertyTypes` an explicit `undefined` is not assignable to
      // `BodyInit | null`.
      const response = await server.app.request(
        path,
        body === undefined
          ? { method: method ?? "GET", headers: { Authorization: `Bearer ${token}` } }
          : {
              method: method ?? "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      const payload = await response.json();
      if (!response.ok)
        throw new Error(
          typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`,
        );
      return payload as T;
    },
  };
}

async function sessionFor(server: Server, deviceId: string) {
  const response = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { token: string }).token;
}

/** Register a device and pair it via bootstrap (the first device in a store). */
async function pairedDevice(server: Server, deviceId: string, capabilities: string[]) {
  const token = await sessionFor(server, deviceId);
  const registered = await server.app.request("/api/agent/devices", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: deviceId, capabilities, formFactor: "desktop" }),
  });
  assert.equal(registered.status, 201, await registered.clone().text());
  const paired = await server.app.request("/api/agent/pairing/bootstrap", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey: "test-key" }),
  });
  assert.equal(paired.status, 200, await paired.clone().text());
  return token;
}

async function newTask(server: Server, token: string, over: Record<string, unknown> = {}) {
  const response = await server.app.request("/api/agent/tasks", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "device work", kind: "plan", ...over }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return ((await response.json()) as { id: string }).id;
}

/**
 * Real timers, at real (tiny) intervals.
 *
 * Deliberately NOT a hand-driven clock: this test talks to a real server over
 * real async IO, so microtask draining cannot decide when the loop has finished
 * a round trip. The loop's own unit tests cover timing with a fake clock; this
 * one is about the protocol agreeing, so it should wait on the real thing.
 */
function liveTimers(): LoopTimers {
  return {
    setTimeout: (fn, ms) => setTimeout(fn, Math.max(ms, 1)),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  };
}

/** Wait until `check` holds, or fail loudly rather than hanging the suite. */
async function waitFor(check: () => boolean, what: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

test("the mobile loop claims, runs and reports a task to a real server", async (t) => {
  const { server, db } = await fixture(t);
  const token = await pairedDevice(server, "phone-1", ["screen"]);
  const taskId = await newTask(server, token);

  const loop = new DeviceAgentLoop(
    deviceTransport(requester(server, token)),
    agentExecutor(async (task) => {
      assert.equal(task.id, taskId);
      return "the result the device produced";
    }),
    { idlePollMs: 5, maxIdlePollMs: 20, heartbeatFraction: 1 / 3, minHeartbeatMs: 5 },
    liveTimers(),
  );
  loop.start();
  t.after(() => loop.shutdown());
  await waitFor(() => loop.getSnapshot().completed === 1, "the device to report a result");
  const task = await db.get<{ status: string; result: string }>("local-user", "tasks", taskId);
  assert.equal(task?.status, "succeeded");
  assert.equal(task?.result, "the result the device produced");
});

test("an unpaired device cannot claim, and the loop says so", async (t) => {
  const { server } = await fixture(t);
  // Registered but never paired: the bootstrap above belongs to another fixture,
  // so this device is unpaired in a store of its own.
  const token = await sessionFor(server, "phone-2");
  const registered = await server.app.request("/api/agent/devices", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "phone-2", capabilities: ["screen"], formFactor: "desktop" }),
  });
  assert.equal(registered.status, 201, await registered.clone().text());

  const loop = new DeviceAgentLoop(
    deviceTransport(requester(server, token)),
    agentExecutor(async () => "unused"),
    { idlePollMs: 5, maxIdlePollMs: 20, heartbeatFraction: 1 / 3, minHeartbeatMs: 5 },
    liveTimers(),
  );
  loop.start();
  t.after(() => loop.shutdown());
  await waitFor(() => loop.getSnapshot().unpaired, "the pairing gate to be surfaced");

  const snapshot = loop.getSnapshot();
  assert.equal(snapshot.unpaired, true, "the pairing gate must be surfaced, not swallowed");
  assert.equal(snapshot.completed, 0);
});

test("a device that loses its lease to the server reports nothing", async (t) => {
  const { server, db } = await fixture(t);
  const token = await pairedDevice(server, "phone-3", ["screen"]);
  const taskId = await newTask(server, token);

  const stolen = deferred();
  const loop = new DeviceAgentLoop(
    deviceTransport(requester(server, token)),
    agentExecutor(async () => {
      // Steal the task the way a second device would: expire our lease mid-run,
      // then claim it, so the task belongs to somebody else by the time we finish.
      // Typed as AgentTask, not `Record<string, unknown>`: `put<T extends {id:
      // string}>` infers T from the object literal, and spreading a loose record
      // collapses it back to `{id: string}` so the extra field is rejected.
      const current = await db.get<AgentTask>("local-user", "tasks", taskId);
      assert.ok(current, "the claimed task must exist before its lease can expire");
      const ours = current.leaseId;
      await db.put<AgentTask>("local-user", "tasks", {
        ...current,
        leaseUntil: new Date(Date.now() - 1000).toISOString(),
      });
      const other = await server.app.request("/api/agent/device/claim", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(other.status, 200, await other.clone().text());
      const taken = (await other.json()) as {
        task: { id: string } | null;
        lease?: { id: string };
      };
      assert.ok(taken.task, "the task should have been requeued and re-claimed");
      assert.notEqual(taken.lease?.id, ours, "the thief must hold a different lease");
      stolen.resolve();
      return "a result written after we lost the task";
    }),
    { idlePollMs: 5, maxIdlePollMs: 20, heartbeatFraction: 1 / 3, minHeartbeatMs: 5 },
    liveTimers(),
  );
  loop.start();
  t.after(() => loop.shutdown());
  await stolen.promise;
  // The report is refused by the server's CAS on the lease we no longer hold.
  // Wait for the loop to leave `running`, which happens only once the report has
  // been attempted — waiting on our own completion counter would be circular,
  // since a refused report deliberately does not increment it.
  await waitFor(() => loop.getSnapshot().phase !== "running", "the refused report to settle");

  // The decisive assertion: our result must not be on the task. The CAS is keyed
  // on the lease, so a report from a device that lost it is either refused (the
  // server's 409) or, if the guard were removed, would overwrite the new holder.
  const task = await db.get<{ status: string; leaseId: string | null; result: string }>(
    "local-user",
    "tasks",
    taskId,
  );
  assert.notEqual(task?.result, "a result written after we lost the task");
  assert.equal(task?.status, "running", "the thief's task is still running, not closed by us");
});

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("the loop refuses a destructive task on a handheld, as the server does", async (t) => {
  const { server } = await fixture(t);
  const token = await sessionFor(server, "phone-4");
  const registered = await server.app.request("/api/agent/devices", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "phone-4", capabilities: ["screen"], formFactor: "handheld" }),
  });
  assert.equal(registered.status, 201, await registered.clone().text());
  const bootstrapped = await server.app.request("/api/agent/pairing/bootstrap", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey: "test-key" }),
  });
  assert.equal(bootstrapped.status, 200, await bootstrapped.clone().text());

  const destructive = await newTask(server, token, {
    requiredCapabilities: ["destructive"],
    prompt: "send this email",
  });

  const loop = new DeviceAgentLoop(
    deviceTransport(requester(server, token)),
    agentExecutor(async () => "must never run"),
    { idlePollMs: 5, maxIdlePollMs: 20, heartbeatFraction: 1 / 3, minHeartbeatMs: 5 },
    liveTimers(),
  );
  loop.start();
  t.after(() => loop.shutdown());
  // Give the loop long enough to have claimed it, had the rule not held.
  await new Promise((done) => setTimeout(done, 300));

  assert.equal(loop.getSnapshot().completed, 0, "a phone must never claim destructive work");
  const still = await server.app.request(`/api/agent/tasks/${destructive}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await still.json()) as { task: { status: string } };
  assert.equal(body.task.status, "queued");
});
