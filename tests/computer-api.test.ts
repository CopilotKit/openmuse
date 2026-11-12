import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { config, fixture, ok } from "./helpers/computer.ts";

test("computer REST endpoints require session ownership and return persisted receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfuse-computer-api-"));
  const db = await createStore();
  const f = fixture({ command: async () => ok("actual output") });
  const server = await createApp(db, { ...config, dataDir: directory }, { docker: f.runner });
  try {
    assert.equal((await server.app.request("/api/computer")).status, 401);
    assert.equal(
      (
        await server.app.request("/api/computer/commands", {
          method: "POST",
          body: JSON.stringify({ command: "pwd" }),
        })
      ).status,
      401,
    );
    const session = await server.auth.session();
    const headers = {
      Authorization: `Bearer ${session.token}`,
      "Content-Type": "application/json",
    };
    const disabled = await createApp(db, { ...config, computerEnabled: false, dataDir: directory });
    const status = await disabled.app.request("/api/computer", { headers });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).status, "unconfigured");
    const invalid = await server.app.request("/api/computer/files/read", {
      method: "POST",
      headers,
      body: JSON.stringify({ path: "/etc/passwd" }),
    });
    assert.equal(invalid.status, 422);
    const missing = await server.app.request("/api/computer/files/import", {
      method: "POST",
      headers,
      body: JSON.stringify({ fileId: "belongs-to-another-owner", path: "/workspace/document.pdf" }),
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "File not found");
    assert.equal(f.calls.length, 0);
    // A fixture tied to another owner must never attach to the authenticated owner.
    const command = await server.app.request("/api/computer/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({ command: "pwd" }),
    });
    assert.equal(command.status, 409);
    assert.match((await command.json()).error, /ownership/);
    assert.ok(!f.calls.some((call) => call.args[0] === "exec"));
    const owned = await createApp(
      db,
      { ...config, dataDir: directory },
      { docker: fixture({ owner: "local-user", command: async () => ok("owner output") }).runner },
    );
    const response = await owned.app.request("/api/computer/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({ command: "pwd", owner: "attacker" }),
    });
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.equal(receipt.stdout, "owner output");
    assert.equal(receipt.status, "succeeded");
    assert.deepEqual(await db.get("local-user", "computer-commands", receipt.id), receipt);
    assert.equal(await db.get("attacker", "computer-commands", receipt.id), null);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
