import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

/**
 * Endpoint tests for the pairing gate. The unit tests in `pairing.test.ts` prove
 * the state machine is correct; these prove the ROUTES enforce it — and the
 * rules they enforce are the ones a unit test cannot see:
 *
 *   - a device cannot pair ITSELF (minting needs an already-paired caller);
 *   - the first device bootstraps with the account access key, once only;
 *   - `deviceId` comes from the session, never the body.
 *
 * Sample mode is used throughout, so `verifyAccessKey` accepts any key — the
 * live-mode comparison is covered separately in `auth.test.ts`.
 */

let server: Awaited<ReturnType<typeof createApp>>;
let db: Store;

/**
 * An isolated PGlite store per test.
 *
 * Deliberately NOT one shared store: pairing is account-wide state, so the
 * bootstrap path is only reachable while NO device is paired. Sharing a store
 * across tests means the first test that bootstraps closes that door for every
 * test after it, and they fail for a reason that has nothing to do with what
 * they assert. Isolation makes each test's precondition true by construction.
 */
async function fixture(t: TestContext, over: Partial<Config> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pairing-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const server = await createApp(db, { ...config, dataDir: directory, ...over });
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { server, db };
}

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

/** A session bound to a device id — which is what every pairing route needs. */
async function sessionFor(deviceId: string, accessKey?: string): Promise<string> {
  const response = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // In live mode `/api/session` itself demands the access key, so the session
    // used to reach the pairing routes has to be minted with it. Passing it here
    // keeps that in one place rather than at every live-mode call site.
    body: JSON.stringify({ deviceId, ...(accessKey ? { accessKey } : {}) }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { token: string }).token;
}

async function register(deviceId: string, name: string): Promise<string> {
  const token = await sessionFor(deviceId);
  const response = await server.app.request("/api/agent/devices", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, capabilities: ["shell"] }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return token;
}

async function pairing(token: string) {
  const response = await server.app.request("/api/agent/pairing", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as { paired: boolean; challengeOutstanding: boolean };
}

/**
 * Register a desktop and pair it via the bootstrap path, returning its token.
 * A paired caller is the precondition for every mint, so any test that mints a
 * code needs one.
 */
async function pairedDesktop(deviceId: string, name = "Desktop"): Promise<string> {
  const token = await register(deviceId, name);
  const response = await post(token, "/pairing/bootstrap", { accessKey: "test-key" });
  assert.equal(response.status, 200, await response.clone().text());
  return token;
}

async function post(token: string, path: string, body: unknown) {
  return server.app.request(`/api/agent${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("an unregistered session cannot pair: pairing status needs a device row", async (t) => {
  ({ server } = await fixture(t));
  const token = await sessionFor("never-registered-device");
  const response = await server.app.request("/api/agent/pairing", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  // Fail CLOSED: a device the server has never heard of reads as unpaired.
  assert.equal(((await response.json()) as { paired: boolean }).paired, false);
});

test("a device cannot pair itself: minting needs an already-paired caller", async (t) => {
  ({ server } = await fixture(t));
  const phone = await register(`phone-selfpair-${Date.now()}`, "Phone");
  const refused = await post(phone, "/pairing/request", { deviceId: "some-other-device" });
  // 403, not 404: the route exists, and a caller that cannot use it should learn
  // that rather than be told the device is missing.
  assert.equal(refused.status, 403, await refused.clone().text());
  assert.match((await refused.json()).error, /[Pp]air/);
  assert.equal((await pairing(phone)).paired, false);
});

test("the first device bootstraps with the access key, then cannot bootstrap again", async (t) => {
  ({ server, db } = await fixture(t));
  const desktop = await register("desktop-bootstrap", "Desktop");
  // Nothing is paired yet (this test owns a fresh store), so bootstrap is open.
  const first = await post(desktop, "/pairing/bootstrap", { accessKey: "test-key" });
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(((await first.json()) as { paired: boolean }).paired, true);
  assert.equal((await pairing(desktop)).paired, true);

  // A second device must NOT be able to bootstrap — that would make the OTP
  // path optional and let anyone holding the access key add devices silently.
  const second = await register("phone-bootstrap-2", "Phone");
  const blocked = await post(second, "/pairing/bootstrap", { accessKey: "test-key" });
  assert.equal(blocked.status, 409, await blocked.clone().text());
  assert.equal((await pairing(second)).paired, false);
});

test("a paired device mints a code that pairs another device", async (t) => {
  ({ server, db } = await fixture(t));
  const desktop = await pairedDesktop("desktop-mint");
  const phone = await register("phone-mint", "Phone");

  const minted = await post(desktop, "/pairing/request", { deviceId: "phone-mint" });
  assert.equal(minted.status, 200, await minted.clone().text());
  const { code } = (await minted.json()) as { code: string };
  assert.match(code, /^\d{6}$/);
  assert.equal((await pairing(phone)).paired, false);

  const wrong = await post(phone, "/pairing/verify", { code: "000000" });
  assert.equal(wrong.status, 422, await wrong.clone().text());
  assert.equal((await pairing(phone)).paired, false);

  const verified = await post(phone, "/pairing/verify", { code });
  assert.equal(verified.status, 200, await verified.clone().text());
  assert.equal(((await verified.json()) as { paired: boolean }).paired, true);
  assert.equal((await pairing(phone)).paired, true);
});

test("the minting response never contains the code it stored", async (t) => {
  ({ server, db } = await fixture(t));
  const desktop = await pairedDesktop("desktop-noleak");
  await register("phone-noleak", "Phone");
  const response = await post(desktop, "/pairing/request", { deviceId: "phone-noleak" });
  const { code, status } = (await response.json()) as {
    code: string;
    status: { challengeOutstanding: boolean };
  };
  assert.equal(status.challengeOutstanding, true);
  // The persisted row must hold a hash, not the code a later verify compares.
  const stored = await db.pairingState("local-user", "phone-noleak");
  assert.ok(!JSON.stringify(stored).includes(code));
});

test("pairing is per device: verifying on one device does not pair another", async (t) => {
  ({ server, db } = await fixture(t));
  const desktop = await pairedDesktop("desktop-scoped");
  const phone = await register("phone-scoped", "Phone");
  const sibling = await register("phone-sibling", "Sibling");
  const minted = await post(desktop, "/pairing/request", { deviceId: "phone-scoped" });
  const { code } = (await minted.json()) as { code: string };
  await post(phone, "/pairing/verify", { code });
  assert.equal((await pairing(phone)).paired, true);
  assert.equal((await pairing(sibling)).paired, false);
});

test("revoking a pairing stops the device pairing again on its own", async (t) => {
  ({ server, db } = await fixture(t));
  const desktop = await pairedDesktop("desktop-revoke");
  const phone = await register("phone-revoke", "Phone");
  const minted = await post(desktop, "/pairing/request", { deviceId: "phone-revoke" });
  const { code } = (await minted.json()) as { code: string };
  await post(phone, "/pairing/verify", { code });
  assert.equal((await pairing(phone)).paired, true);

  const revoked = await post(phone, "/pairing/revoke", {});
  assert.equal(revoked.status, 200, await revoked.clone().text());
  assert.equal((await pairing(phone)).paired, false);

  // And the old code is spent, so replaying it does not re-pair.
  const replay = await post(phone, "/pairing/verify", { code });
  assert.equal(replay.status, 422, await replay.clone().text());
  assert.equal((await pairing(phone)).paired, false);
});

test("a wrong code is rate-limited and then the challenge is burned", async (t) => {
  ({ server, db } = await fixture(t));
  const desktop = await pairedDesktop("desktop-burst");
  const phone = await register("phone-burst", "Phone");
  const minted = await post(desktop, "/pairing/request", { deviceId: "phone-burst" });
  const { code } = (await minted.json()) as { code: string };
  for (let i = 0; i < 4; i += 1) {
    const attempt = await post(phone, "/pairing/verify", { code: "111111" });
    assert.equal(attempt.status, 422, `attempt ${i + 1}`);
  }
  const exhausted = await post(phone, "/pairing/verify", { code: "111111" });
  // 429 once the budget is gone: a rate-limit fact the client can act on. 403
  // would read as "this device may never pair", which is not what happened.
  assert.equal(exhausted.status, 429, await exhausted.clone().text());
  // Even the CORRECT code now fails, because the challenge was burned.
  const correct = await post(phone, "/pairing/verify", { code });
  assert.equal(correct.status, 422, await correct.clone().text());
  assert.equal((await pairing(phone)).paired, false);
});

test("an expired challenge is refused and reported as needing a new code", async (t) => {
  ({ server, db } = await fixture(t));
  const desktop = await pairedDesktop("desktop-expired");
  const phone = await register("phone-expired", "Phone");
  const minted = await post(desktop, "/pairing/request", { deviceId: "phone-expired" });
  const { code } = (await minted.json()) as { code: string };
  // Force expiry in the persisted row rather than waiting out the 5-minute TTL.
  const state = await db.pairingState("local-user", "phone-expired");
  assert.ok(state.challenge);
  await db.savePairingState("local-user", "phone-expired", {
    ...state,
    challenge: state.challenge ? { ...state.challenge, expiresAt: Date.now() - 1 } : null,
  });
  const response = await post(phone, "/pairing/verify", { code });
  assert.equal(response.status, 422, await response.clone().text());
  assert.match((await response.json()).error, /expired/i);
  assert.equal((await pairing(phone)).paired, false);
});

test("runnable-on reports pairing separately from a capability gap", async (t) => {
  ({ server, db } = await fixture(t));
  // Two devices, both offering `shell`, but only one paired. The pairing
  // failure must be distinguishable: "needs a code typed in" and "needs a
  // different machine" send the operator to different places, and collapsing
  // them into one boolean would send them to the wrong one.
  const desktop = await pairedDesktop("desktop-runnable");
  const unpairedPhone = await register("phone-runnable", "Phone");
  const created = await server.app.request("/api/agent/tasks", {
    method: "POST",
    headers: { Authorization: `Bearer ${desktop}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: "check placement",
      kind: "plan",
      requiredCapabilities: ["shell"],
    }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const taskId = ((await created.json()) as { id: string }).id;

  const response = await server.app.request(`/api/agent/tasks/${taskId}/runnable-on`, {
    headers: { Authorization: `Bearer ${desktop}` },
  });
  assert.equal(response.status, 200, await response.clone().text());
  const report = (await response.json()) as {
    selected: { id: string } | null;
    devices: { id: string; ok: boolean; paired: boolean; reason?: string; missing?: string[] }[];
  };
  const phone = report.devices.find((d) => d.id === "phone-runnable");
  const desk = report.devices.find((d) => d.id === "desktop-runnable");
  assert.ok(phone && desk);
  // Unpaired but fully capable: refused, and `paired` is the reason. `reason`
  // stays ABSENT because there is no capability shortfall — the task needs
  // nothing this phone cannot do.
  assert.equal(phone.ok, false);
  assert.equal(phone.paired, false);
  assert.equal(phone.reason, undefined);
  // And the paired one is selected, so pairing is what changed the outcome.
  assert.equal(desk.ok, true);
  assert.equal(desk.paired, true);
  assert.equal(report.selected?.id, "desktop-runnable");

  // The selection must exclude unpaired devices too. Asserting only "selected
  // is not the phone" is too weak: with a paired desktop present, an
  // implementation that ignored pairing would select the DESKTOP and the
  // assertion would still pass. So the unpaired phone is the ONLY device that
  // can run this task — if selection ignores the gate, it is chosen, and this
  // fails.
  const unpairedOnly = await sessionFor("phone-only-capable");
  const registered = await server.app.request("/api/agent/devices", {
    method: "POST",
    headers: { Authorization: `Bearer ${unpairedOnly}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Lab", capabilities: ["filesystem"] }),
  });
  assert.equal(registered.status, 201, await registered.clone().text());

  const labTask = await server.app.request("/api/agent/tasks", {
    method: "POST",
    headers: { Authorization: `Bearer ${desktop}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: "lab work",
      kind: "plan",
      requiredCapabilities: ["filesystem"],
    }),
  });
  assert.equal(labTask.status, 201, await labTask.clone().text());
  const labId = ((await labTask.json()) as { id: string }).id;
  const labReport = (await (
    await server.app.request(`/api/agent/tasks/${labId}/runnable-on`, {
      headers: { Authorization: `Bearer ${desktop}` },
    })
  ).json()) as {
    selected: { id: string } | null;
    devices: { id: string; ok: boolean; paired: boolean; reason?: string; missing?: string[] }[];
  };
  const lab = labReport.devices.find((d) => d.id === "phone-only-capable");
  assert.equal(lab?.paired, false);
  // Capable, yet unrunnable: the pairing gate, not a capability gap.
  assert.equal(lab?.ok, false);
  assert.equal(lab?.reason, undefined, "capability is satisfied; only pairing blocks it");
  // And because it is the only device that CAN run this, refusing to select it
  // is the correct answer — the task has no legal execution target yet.
  assert.equal(
    labReport.selected,
    null,
    "an unpaired device must never be selected, even when it is the only capable one",
  );
  assert.ok(unpairedPhone.length > 0);
});
/**
 * The bootstrap's access-key check, in LIVE mode.
 *
 * Separate from the sample-mode tests above, and deliberately so: in sample
 * mode `verifyAccessKey` returns true for anything, because the access key is
 * not a credential there. A test written only against sample mode therefore
 * cannot see whether the check works at all — which is exactly the gap a
 * mutation found. The control is only meaningful where a key exists.
 */
const liveConfig = {
  mode: "live",
  accessKey: "correct-horse-battery-staple-32chars",
  encryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
} as const;

test("bootstrap refuses a wrong access key in live mode", async (t) => {
  ({ server } = await fixture(t, liveConfig));
  const token = await sessionFor("live-desktop", liveConfig.accessKey);
  await server.app.request("/api/agent/devices", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Desktop", capabilities: ["shell"] }),
  });

  const wrong = await post(token, "/pairing/bootstrap", { accessKey: "not-the-key" });
  assert.equal(wrong.status, 401, await wrong.clone().text());
  assert.match((await wrong.json()).error, /[Aa]ccess key/);
  assert.equal((await pairing(token)).paired, false);

  const right = await post(token, "/pairing/bootstrap", {
    accessKey: liveConfig.accessKey,
  });
  assert.equal(right.status, 200, await right.clone().text());
  assert.equal(((await right.json()) as { paired: boolean }).paired, true);
});

test("bootstrap refuses a missing access key in live mode", async (t) => {
  ({ server } = await fixture(t, liveConfig));
  const token = await sessionFor("live-desktop-nokey", liveConfig.accessKey);
  const response = await post(token, "/pairing/bootstrap", {});
  // 422 from the schema, not 401: the body is missing a required field, and the
  // client needs to be told that rather than told its key was wrong.
  assert.equal(response.status, 422, await response.clone().text());
  assert.equal((await pairing(token)).paired, false);
});

test("sample mode accepts any bootstrap key, because none is a credential", async (t) => {
  ({ server } = await fixture(t));
  const token = await register("sample-bootstrap", "Desktop");
  const response = await post(token, "/pairing/bootstrap", { accessKey: "anything" });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(((await response.json()) as { paired: boolean }).paired, true);
});
