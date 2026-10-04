import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";

/**
 * The device work loop, over real HTTP.
 *
 * `device-work.test.ts` proves the selection logic. These prove the parts a
 * unit test structurally cannot: that the CAS actually resolves a race between
 * two devices, that a dead device's task is recovered rather than stranded, and
 * that every write is behind the pairing gate.
 *
 * Each test gets an isolated PGlite store: pairing and claim state are
 * account-wide, so a shared store would make these order-dependent.
 */

const config: Config = {
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: "",
  agentBackend: "model",
  intelligenceApiKey: "test-key",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
};

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-devicework-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const server = await createApp(db, { ...config, dataDir: directory });
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { server, db };
}

async function sessionFor(server: Awaited<ReturnType<typeof createApp>>, deviceId: string) {
  const response = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { token: string }).token;
}

async function post(
  server: Awaited<ReturnType<typeof createApp>>,
  token: string,
  path: string,
  body?: unknown,
) {
  return server.app.request(`/api/agent${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

/** Register a device and pair it via bootstrap (the first device in a store). */
async function pairedDevice(
  server: Awaited<ReturnType<typeof createApp>>,
  deviceId: string,
  capabilities: string[],
) {
  const token = await sessionFor(server, deviceId);
  const registered = await post(server, token, "/devices", { name: deviceId, capabilities });
  assert.equal(registered.status, 201, await registered.clone().text());
  const paired = await post(server, token, "/pairing/bootstrap", { accessKey: "test-key" });
  assert.equal(paired.status, 200, await paired.clone().text());
  return token;
}

/** Register a device paired by redeeming a code from an already-paired device. */
async function satelliteDevice(
  server: Awaited<ReturnType<typeof createApp>>,
  bootstrapToken: string,
  deviceId: string,
  capabilities: string[],
) {
  const token = await sessionFor(server, deviceId);
  const registered = await post(server, token, "/devices", { name: deviceId, capabilities });
  assert.equal(registered.status, 201, await registered.clone().text());
  const minted = await post(server, bootstrapToken, "/pairing/request", { deviceId });
  assert.equal(minted.status, 200, await minted.clone().text());
  const { code } = (await minted.json()) as { code: string };
  const verified = await post(server, token, "/pairing/verify", { code });
  assert.equal(verified.status, 200, await verified.clone().text());
  return token;
}

async function newTask(
  server: Awaited<ReturnType<typeof createApp>>,
  token: string,
  over: Record<string, unknown> = {},
) {
  const response = await post(server, token, "/tasks", {
    prompt: "device work",
    kind: "plan",
    ...over,
  });
  assert.equal(response.status, 201, await response.clone().text());
  return ((await response.json()) as { id: string }).id;
}

/** Force a task's lease into the past, as if its device vanished mid-task. */
async function expireLease(db: Awaited<ReturnType<typeof createStore>>, taskId: string) {
  const task = await db.get<{ id: string; leaseUntil?: string | null }>(
    "local-user",
    "tasks",
    taskId,
  );
  assert.ok(task, "task must exist before its lease can expire");
  await db.put("local-user", "tasks", {
    ...task,
    leaseUntil: new Date(Date.now() - 1000).toISOString(),
  });
}

type ClaimResponse = {
  task: { id: string; status: string } | null;
  reason?: string;
  lease?: { id: string; until: string };
};

test("an unpaired device can neither heartbeat nor report", async (t) => {
  // The pairing gate must cover every WRITE in the loop, not just the claim. A
  // gate on `/device/claim` alone would still let an unpaired device keep a
  // lease alive and close out a task it was never allowed to start.
  const { server } = await fixture(t);
  const desktop = await pairedDevice(server, "desktop", ["shell"]);
  const taskId = await newTask(server, desktop, { requiredCapabilities: ["shell"] });
  const claim = (await (await post(server, desktop, "/device/claim")).json()) as ClaimResponse;
  const leaseId = claim.lease?.id as string;

  const phoneToken = await sessionFor(server, "phone-gate");
  const registered = await post(server, phoneToken, "/devices", {
    name: "Phone",
    capabilities: ["shell"],
  });
  assert.equal(registered.status, 201, await registered.clone().text());

  const beat = await post(server, phoneToken, "/device/heartbeat", { taskId, leaseId });
  assert.equal(beat.status, 403, await beat.clone().text());

  const report = await post(server, phoneToken, "/device/report", {
    taskId,
    leaseId,
    outcome: "succeeded",
    result: "Closed a task it was never allowed to claim.",
  });
  assert.equal(report.status, 403, await report.clone().text());

  // The real holder's task is untouched.
  const readBack = await server.app.request(`/api/agent/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${desktop}` },
  });
  assert.equal(readBack.status, 200, await readBack.clone().text());
  const envelope = (await readBack.json()) as { task?: { status: string }; status?: string };
  // `/tasks/:id` returns the task inside an envelope; assert on the task itself
  // so a shape change here fails loudly instead of reading as `undefined`.
  const task = envelope.task ?? envelope;
  assert.equal(
    task.status,
    "running",
    `expected the task to still be running, got ${JSON.stringify(envelope)}`,
  );
});

test("a paired device claims eligible work and holds a lease", async (t) => {
  const { server } = await fixture(t);
  const desktop = await pairedDevice(server, "desktop", ["shell", "filesystem"]);
  const taskId = await newTask(server, desktop, { requiredCapabilities: ["shell"] });

  const response = await post(server, desktop, "/device/claim");
  assert.equal(response.status, 200, await response.clone().text());
  const claim = (await response.json()) as ClaimResponse;
  assert.equal(claim.task?.id, taskId);
  assert.equal(claim.task?.status, "running");
  assert.ok(claim.lease?.id, "a claim must carry a lease id");
  assert.ok(claim.lease?.until);
  assert.ok(Date.parse(claim.lease.until) > Date.now(), "the lease must be in the future");
});

test("an unpaired device cannot claim, even though it may read", async (t) => {
  const { server } = await fixture(t);
  const desktop = await pairedDevice(server, "desktop", ["shell"]);
  await newTask(server, desktop, { requiredCapabilities: ["shell"] });

  const phoneToken = await sessionFor(server, "phone-unpaired");
  const registered = await post(server, phoneToken, "/devices", {
    name: "Phone",
    capabilities: ["shell"],
  });
  assert.equal(registered.status, 201, await registered.clone().text());

  // Reading is allowed — `/sync` is the endpoint an unpaired device actually
  // uses to follow the change feed, so it is the read side of this contrast.
  const readable = await server.app.request("/api/agent/sync?since=0", {
    headers: { Authorization: `Bearer ${phoneToken}` },
  });
  assert.equal(readable.status, 200, await readable.clone().text());
  const feed = (await readable.json()) as { changes: unknown[]; cursor: number };
  assert.ok(Array.isArray(feed.changes));
  assert.equal(typeof feed.cursor, "number");

  // ...claiming is not. A claim IS execution.
  const claim = await post(server, phoneToken, "/device/claim");
  assert.equal(claim.status, 403, await claim.clone().text());
  assert.match((await claim.json()).error, /[Pp]air/);
});

test("two devices racing for one task: exactly one wins", async (t) => {
  const { server } = await fixture(t);
  const desktop = await pairedDevice(server, "desktop", ["shell"]);
  const laptop = await satelliteDevice(server, desktop, "laptop", ["shell", "filesystem"]);
  const taskId = await newTask(server, desktop, { requiredCapabilities: ["shell"] });

  // Fired together, so neither can win by arriving first in a way the other
  // cannot see. Both resolve; the CAS inside decides the single winner.
  const [a, b] = await Promise.all([
    post(server, desktop, "/device/claim"),
    post(server, laptop, "/device/claim"),
  ]);
  const claims = [(await a.json()) as ClaimResponse, (await b.json()) as ClaimResponse];
  const winners = claims.filter((c) => c.task !== null);
  assert.equal(winners.length, 1, `exactly one device must win the race, got ${winners.length}`);
  assert.equal(winners[0]?.task?.id, taskId);
  const loser = claims.find((c) => c.task === null);
  assert.equal(
    loser?.reason,
    "no-eligible-work",
    "the loser is told there is nothing, not an error",
  );
});

test("a claimed task is not claimable again while its lease is live", async (t) => {
  const { server } = await fixture(t);
  const desktop = await pairedDevice(server, "desktop", ["shell"]);
  const laptop = await satelliteDevice(server, desktop, "laptop", ["shell"]);
  await newTask(server, desktop, { requiredCapabilities: ["shell"] });

  assert.ok(((await (await post(server, desktop, "/device/claim")).json()) as ClaimResponse).task);
  const second = (await (await post(server, laptop, "/device/claim")).json()) as ClaimResponse;
  assert.equal(second.task, null, "a live lease must block a second claim");
});

test("a device reports success and the task closes", async (t) => {
  const { server } = await fixture(t);
  const desktop = await pairedDevice(server, "desktop", ["shell"]);
  const taskId = await newTask(server, desktop, { requiredCapabilities: ["shell"] });
  const claim = (await (await post(server, desktop, "/device/claim")).json()) as ClaimResponse;

  const reported = await post(server, desktop, "/device/report", {
    taskId,
    leaseId: claim.lease?.id,
    outcome: "succeeded",
    result: "Did the thing.",
  });
  assert.equal(reported.status, 200, await reported.clone().text());
  const task = (await reported.json()) as {
    status: string;
    result: string;
    leaseId: string | null;
  };
  assert.equal(task.status, "succeeded");
  assert.equal(task.result, "Did the thing.");
  assert.equal(task.leaseId, null, "a closed task must not keep a lease");

  // And it is not claimable a second time.
  const again = (await (await post(server, desktop, "/device/claim")).json()) as ClaimResponse;
  assert.equal(again.task, null);
});

test("a device cannot report on a task whose lease it lost", async (t) => {
  const { server, db } = await fixture(t);
  const desktop = await pairedDevice(server, "desktop", ["shell"]);
  const laptop = await satelliteDevice(server, desktop, "laptop", ["shell"]);
  const taskId = await newTask(server, desktop, { requiredCapabilities: ["shell"] });
  const claim = (await (await post(server, desktop, "/device/claim")).json()) as ClaimResponse;
  const leaseId = claim.lease?.id as string;

  // Expire the lease so the task is recoverable, then let the other device take it.
  await expireLease(db, taskId);
  await post(server, laptop, "/device/claim");
  const takenOver = (await (await post(server, laptop, "/device/claim")).json()) as ClaimResponse;

  // The original holder still believes it is working. Reporting now must fail:
  // two devices must not write results for one task.
  const stale = await post(server, desktop, "/device/report", {
    taskId,
    leaseId,
    outcome: "succeeded",
    result: "Stale result from a device that lost its lease.",
  });
  assert.equal(stale.status, 409, await stale.clone().text());
  assert.match((await stale.json()).error, /lease/i);
  if (takenOver.task) assert.notEqual(takenOver.task.id, taskId);
});

test("a dead device's task is requeued, not stranded", async (t) => {
  const { server, db } = await fixture(t);
  const desktop = await pairedDevice(server, "desktop", ["shell"]);
  const laptop = await satelliteDevice(server, desktop, "laptop", ["shell"]);
  const taskId = await newTask(server, desktop, { requiredCapabilities: ["shell"] });

  // The desktop claims, then vanishes mid-task: the lease runs out and nothing
  // else ever heartbeats it.
  const claim = (await (await post(server, desktop, "/device/claim")).json()) as ClaimResponse;
  assert.equal(claim.task?.id, taskId);
  await expireLease(db, taskId);

  // The laptop pulls. Recovery must run first, or the task stays invisible
  // forever behind a dead lease and is silently lost.
  const recovered = (await (await post(server, laptop, "/device/claim")).json()) as ClaimResponse;
  assert.equal(recovered.task?.id, taskId, "a lapsed lease must return the task to the queue");

  // And the task is running under the NEW lease, not the dead one.
  assert.notEqual(recovered.lease?.id, claim.lease?.id);
  const task = (await db.get("local-user", "tasks", taskId)) as { status: string; error?: string };
  assert.equal(task.status, "running");
});

test("heartbeat extends a live lease and refuses one it does not hold", async (t) => {
  const { server, db } = await fixture(t);
  const desktop = await pairedDevice(server, "desktop", ["shell"]);
  const taskId = await newTask(server, desktop, { requiredCapabilities: ["shell"] });
  const claim = (await (await post(server, desktop, "/device/claim")).json()) as ClaimResponse;
  const leaseId = claim.lease?.id as string;

  const held = (await (
    await post(server, desktop, "/device/heartbeat", { taskId, leaseId })
  ).json()) as { ok: boolean; leaseUntil: string | null };
  assert.equal(held.ok, true);
  assert.ok(Date.parse(held.leaseUntil as string) > Date.now());

  // A heartbeat naming a lease nobody holds must not keep the task alive. The
  // lease id is the bearer capability — it is generated with a CSPRNG and only
  // ever returned to the device that won the claim, so knowing it IS holding
  // it. There is deliberately no second factor: `deviceId` is not consulted,
  // because a device that has the lease is the one that won the claim.
  const wrong = (await (
    await post(server, desktop, "/device/heartbeat", { taskId, leaseId: "not-a-lease" })
  ).json()) as { ok: boolean };
  assert.equal(wrong.ok, false, "a bogus lease must not extend anything");

  // A paired satellite that does NOT hold the lease cannot extend it either.
  const laptop = await satelliteDevice(server, desktop, "laptop", ["shell"]);
  const notMine = (await (
    await post(server, laptop, "/device/heartbeat", { taskId, leaseId: "guessing-again" })
  ).json()) as { ok: boolean };
  assert.equal(notMine.ok, false, "a paired device still needs the actual lease");

  // And the lease survives a failed heartbeat: a rejected extension must not
  // silently clear or shorten it.
  const stillHeld = await db.get<{ leaseId: string | null }>("local-user", "tasks", taskId);
  assert.equal(stillHeld?.leaseId, leaseId);
});

test("a device with no eligible work is told so plainly", async (t) => {
  const { server } = await fixture(t);
  const phone = await pairedDevice(server, "phone", ["browser"]);
  await newTask(server, phone, { requiredCapabilities: ["shell"] });
  const response = await post(server, phone, "/device/claim");
  assert.equal(response.status, 200, "no eligible work is a normal answer, not an error");
  const claim = (await response.json()) as ClaimResponse;
  assert.equal(claim.task, null);
  assert.equal(claim.reason, "no-eligible-work");
});
