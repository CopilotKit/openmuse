import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { config, fixture, ok } from "./helpers/computer.ts";

/**
 * These are ENDPOINT tests, not unit tests of the gate. The unit tests prove the
 * verdict function is correct; these prove the routes actually consult it — a
 * gate wired to nothing is indistinguishable from no gate.
 *
 * WHAT IS AND IS NOT NEW COVERAGE — measured, not assumed. `app.ts` already
 * rejects a request whose `Origin` is not in `allowedOrigins`, and
 * `config.publicUrl`'s origin is always in that set. So the plain cross-origin
 * case was NEVER open, and these tests do not claim to close it. The gate adds
 * two things the allowlist does not provide:
 *
 *   1. `Sec-Fetch-Site` refused with NO `Origin` header at all. The allowlist
 *      skips a missing Origin by design (native clients send none), so it has
 *      nothing to say here; the browser-driven gate does.
 *   2. A CORS-simple write from an origin that IS allowlisted. The allowlist
 *      answers "which site"; it cannot answer "was this preflighted". If
 *      `ALLOWED_ORIGINS` ever names a broad or attacker-reachable origin, the
 *      allowlist waves the write through and this is what still refuses it.
 */

async function appFor(t: TestContext, origin?: string) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-gate-"));
  const db = await createStore();
  // The fixture must be keyed to the session's owner; the helper's default
  // `"owner"` is not `"local-user"` and the computer refuses to attach across
  // owners (409), which is a different failure from the one under test.
  const docker = fixture({ command: async () => ok(), owner: "local-user" });
  const server = await createApp(db, { ...config, dataDir: directory }, { docker: docker.runner });
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const session = await server.auth.session();
  const headers = {
    Authorization: `Bearer ${session.token}`,
    "Content-Type": "application/json",
    ...(origin ? { Origin: origin } : {}),
  };
  return { server, docker, headers };
}

test("a cors-simple write is refused even from an origin the allowlist permits", async (t) => {
  const { server, docker, headers } = await appFor(t, new URL(config.publicUrl).origin);
  const attack = { ...headers, "Content-Type": "text/plain;charset=UTF-8" };
  for (const [path, body] of [
    ["/api/computer/commands", { command: "curl http://169.254.169.254/" }],
    ["/api/computer/start", {}],
    ["/api/computer/stop", {}],
    ["/api/computer/files/write", { path: "/workspace/x", text: "y" }],
    ["/api/browsers", { url: "https://example.com" }],
  ] as const) {
    const response = await server.app.request(path, {
      method: "POST",
      headers: attack,
      // Valid JSON in a CORS-simple envelope: exactly the shape a browser can
      // deliver without a preflight, and exactly what these routes parse.
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 403, path);
    assert.match((await response.json()).error, /Refused/, path);
  }
  // The refusal must happen BEFORE execution: no docker call at all.
  assert.equal(docker.calls.length, 0);
});

test("Sec-Fetch-Site: cross-site is refused with no Origin header present", async (t) => {
  const { server, docker, headers } = await appFor(t);
  const response = await server.app.request("/api/computer/commands", {
    method: "POST",
    headers: { ...headers, "Sec-Fetch-Site": "cross-site" },
    body: JSON.stringify({ command: "pwd" }),
  });
  assert.equal(response.status, 403);
  assert.equal(docker.calls.length, 0);
});

test("the gate does not shadow authentication: no session is still 401", async (t) => {
  const { server } = await appFor(t);
  // The gate must not become the thing that answers unauthenticated callers, or
  // a 403 here would confirm to an attacker that the route exists.
  const response = await server.app.request("/api/computer/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "pwd" }),
  });
  assert.equal(response.status, 401);
});

test("the same routes still serve the Expo client, which sends no Origin", async (t) => {
  const { server, docker, headers } = await appFor(t);
  // No Origin, no Sec-Fetch-Site: a native client. A gate that failed closed on
  // the absence of browser headers would break the product's own client.
  const started = await server.app.request("/api/computer/start", {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(started.status, 200);
  assert.ok(docker.calls.length > 0, "the gate must not block a legitimate caller");
});

test("a preflighted same-origin write is not refused", async (t) => {
  const { server, headers } = await appFor(t, new URL(config.publicUrl).origin);
  const response = await server.app.request("/api/computer/start", {
    method: "POST",
    headers: { ...headers, "Sec-Fetch-Site": "same-origin" },
    body: "{}",
  });
  assert.equal(response.status, 200);
});
