import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string, token: string;
const OWNER = "local-user";
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

/** A session bound to a device id, which is what device registration requires. */
async function tokenFor(deviceId: string): Promise<string> {
  const response = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { token: string }).token;
}

type Device = {
  id: string;
  name: string;
  capabilities: string[];
  lastSeenAt: string;
  available?: boolean;
  unsupported?: string[];
};

/** Register a device through the API, as a real client would. */
async function register(deviceId: string, name: string, capabilities: string[]): Promise<Device> {
  const deviceToken = await tokenFor(deviceId);
  const response = await server.app.request("/api/agent/devices", {
    method: "POST",
    headers: { Authorization: `Bearer ${deviceToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, capabilities }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json() as Promise<Device>;
}

/**
 * Register a device and pair it.
 *
 * These tests are about CAPABILITY negotiation, so their devices are paired —
 * otherwise `runnable-on` would report every device as unrunnable and the
 * capability assertions below would measure pairing instead. `paired: false`
 * is covered in `pairing-api.test.ts`.
 */
let bootstrapOwnerToken: string | null = null;

/**
 * Register a device and pair it.
 *
 * These tests are about CAPABILITY negotiation, so their devices are paired —
 * otherwise `runnable-on` reports every device as unrunnable and the capability
 * assertions below would measure pairing instead. `paired: false` is covered in
 * `pairing-api.test.ts`.
 *
 * Pairing is account-wide, and this suite shares one owner, so only ONE device
 * can bootstrap; the rest are paired by redeeming a code that device minted.
 * That is the real flow, so the helper follows it rather than resetting the
 * store between tests and hiding the coupling.
 */
/**
 * Pair a device that already exists (registered by an earlier test).
 *
 * Idempotent: a device an earlier test already paired stays paired, and the
 * server correctly refuses to mint a code for it.
 */
async function pairExisting(deviceId: string): Promise<void> {
  assert.ok(bootstrapOwnerToken, "a device must bootstrap before others can pair");
  const minted = await server.app.request("/api/agent/pairing/request", {
    method: "POST",
    headers: { Authorization: `Bearer ${bootstrapOwnerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  if (minted.status === 409) return; // already paired
  assert.equal(minted.status, 200, await minted.clone().text());
  const { code } = (await minted.json()) as { code: string };
  const verified = await server.app.request("/api/agent/pairing/verify", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await tokenFor(deviceId)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code }),
  });
  assert.equal(verified.status, 200, await verified.clone().text());
}

async function registerPaired(deviceId: string, name: string, capabilities: string[]) {
  await register(deviceId, name, capabilities);
  const deviceToken = await tokenFor(deviceId);
  if (bootstrapOwnerToken === null) {
    const bootstrap = await server.app.request("/api/agent/pairing/bootstrap", {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey: "test-key" }),
    });
    assert.equal(
      bootstrap.status,
      200,
      `bootstrap failed (${bootstrap.status}): ${await bootstrap.clone().text()}`,
    );
    bootstrapOwnerToken = deviceToken;
    return deviceToken;
  }
  // Mint from the already-paired device, then redeem as the new device.
  // Must be the PAIRED device's own session: pairing is device-bound, so the
  // shared suite token (minted with no deviceId) is refused here by design.
  assert.ok(bootstrapOwnerToken);
  const minted = await server.app.request("/api/agent/pairing/request", {
    method: "POST",
    headers: { Authorization: `Bearer ${bootstrapOwnerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  assert.equal(minted.status, 200, await minted.clone().text());
  const { code } = (await minted.json()) as { code: string };
  const verified = await server.app.request("/api/agent/pairing/verify", {
    method: "POST",
    headers: { Authorization: `Bearer ${deviceToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  assert.equal(verified.status, 200, await verified.clone().text());
  return deviceToken;
}

async function newTask(prompt: string, over: Record<string, unknown> = {}): Promise<string> {
  const response = await server.app.request("/api/agent/tasks", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ prompt, kind: "plan", ...over }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return ((await response.json()) as AgentTask).id;
}

async function read<T>(path: string, init?: RequestInit, status = 200): Promise<T> {
  const response = await server.app.request(`/api/agent${path}`, { headers: headers(), ...init });
  assert.equal(response.status, status, await response.clone().text());
  return response.json() as Promise<T>;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-devices-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    intelligenceApiKey: "test-key",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  server = await createApp(db, config);
  // Clear before minting a session: `clearAll` wipes the store the session lives
  // in, so a token fetched beforehand would be rejected as expired.
  await db.clearAll();
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  token = ((await session.json()) as { token: string }).token;
});

after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("a device registers with the capabilities it declares", async () => {
  const device = await register("dev-phone", "Pixel", ["browser", "screen"]);
  assert.equal(device.id, "dev-phone");
  assert.deepEqual(device.capabilities, ["browser", "screen"]);
  const listed = await read<Device[]>("/devices");
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0]?.capabilities, ["browser", "screen"]);
});

test("capabilities this build does not know are refused, not stored", async () => {
  const device = await register("dev-newer", "Future Phone", ["telepathy", "browser"]);
  // Storing an unknown capability would let a task be dispatched against
  // something this server cannot honour.
  assert.deepEqual(device.capabilities, ["browser"]);
  assert.deepEqual(
    device.unsupported,
    ["telepathy"],
    "the client is told it is ahead of the server",
  );
});

test("registering without a device id is a 400", async () => {
  const response = await server.app.request("/api/agent/devices", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ name: "Nameless", capabilities: [] }),
  });
  assert.equal(response.status, 400, await response.clone().text());
});

test("a task requiring shell is refused on a browser-only phone", async () => {
  await registerPaired("dev-phone2", "Phone", ["browser"]);
  await registerPaired("dev-desktop", "Desktop", ["shell", "browser"]);
  const taskId = await newTask("reindex the codebase", { requiredCapabilities: ["shell"] });
  const answer = await read<{
    required: string[];
    selected: { id: string; name: string } | null;
    devices: { id: string; ok: boolean; reason?: string; missing?: string[] }[];
  }>(`/tasks/${taskId}/runnable-on`);
  assert.deepEqual(answer.required, ["shell"]);
  // Devices from earlier tests in this suite are still registered, so the
  // selection is asserted against the set of devices that CAN run it rather than
  // against one hardcoded id: the point of the test is the cross-device case,
  // not which of several capable desktops won.
  assert.ok(
    answer.devices.some((d) => d.ok),
    "at least one device must be able to run a shell task",
  );
  assert.ok(answer.selected, "a capable device must be selected");
  assert.notEqual(answer.selected?.id, "dev-phone2");
  const phone = answer.devices.find((d) => d.id === "dev-phone2");
  assert.equal(phone?.ok, false);
  assert.equal(phone?.reason, "missing");
  assert.deepEqual(phone?.missing, ["shell"]);
});

test("a task with no requirements is runnable anywhere, including a phone", async () => {
  // With no `requiredCapabilities`, the gate is pairing alone: every device must
  // be paired for this task to be runnable everywhere. Devices registered by
  // earlier tests in this suite are paired here so the `every` below measures
  // what it claims to — that a requirement-free task is not pinned to one
  // machine — rather than incidentally re-testing pairing coverage.
  // Devices earlier tests registered UNPAIRED are paired here, so the `every`
  // below measures what it claims: that a requirement-free task is not pinned
  // to one machine, not that unpaired devices can run things.
  const alreadyListed = new Set((await read<Device[]>("/devices")).map((d) => d.id));
  for (const id of ["dev-phone", "dev-phone2", "dev-newer"]) {
    if (alreadyListed.has(id)) await pairExisting(id); // no-op if already paired
  }
  await registerPaired("dev-phone-any", "Phone", ["browser"]);
  const taskId = await newTask("just summarise this");
  const answer = await read<{ required: string[]; devices: { id: string; ok: boolean }[] }>(
    `/tasks/${taskId}/runnable-on`,
  );
  assert.deepEqual(answer.required, []);
  assert.ok(
    answer.devices.every((d) => d.ok),
    "a task needing nothing device-local must not be pinned to one machine",
  );
});

test("runnable-on for an unknown task is a 404", async () => {
  await read("/tasks/nope/runnable-on", undefined, 404);
});

test("a task keeps its requirements even if the jsonb is hand-edited", async () => {
  const taskId = await newTask("needs something exotic", { requiredCapabilities: ["shell"] });
  const row = (await db.get<AgentTask>(OWNER, "tasks", taskId)) as AgentTask;
  await db.put(OWNER, "tasks", {
    ...row,
    // Simulates a row written by an older/newer build. Honouring it would let a
    // task claim a capability nothing can provide.
    requiredCapabilities: ["shell", "wormhole"] as never,
  });
  const answer = await read<{ required: string[] }>(`/tasks/${taskId}/runnable-on`);
  assert.deepEqual(answer.required, ["shell"], "unknown entries are dropped, not trusted");
});

test("a device can be removed so it stops being a migration target", async () => {
  await register("dev-temp", "Loaner", ["shell"]);
  await expectRemoved("dev-temp");
  const answer = await read<Device[]>("/devices");
  assert.equal(
    answer.find((d) => d.id === "dev-temp"),
    undefined,
  );
});

async function expectRemoved(deviceId: string): Promise<void> {
  const response = await server.app.request(`/api/agent/devices/${deviceId}`, {
    method: "DELETE",
    headers: headers(),
  });
  assert.equal(response.status, 200, await response.clone().text());
}

test("/tasks/board still routes before /tasks/:id", async () => {
  // A regression guard: `/tasks/board` must be registered ahead of `/tasks/:id`
  // or the id route captures it and returns 404.
  const board = await read<{ columns: unknown[] }>("/tasks/board");
  assert.equal(board.columns.length, 6);
});
