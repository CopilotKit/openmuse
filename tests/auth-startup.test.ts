import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createAuth } from "../apps/server/src/auth.ts";
import { computerIdentity, resolveComputerDeployment } from "../apps/server/src/computer.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

function config(dataDir: string): Config {
  return {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir,
    agentBackend: "sample",
    allowedOrigins: [],
    googleRedirectUri: "http://localhost:8787/api/google/callback",
  };
}

test("concurrent first startups share one complete signing key", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-auth-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const instances = await Promise.all(
    Array.from({ length: 16 }, () => createAuth({} as Store, config(directory))),
  );
  const key = await readFile(join(directory, "session-signing-key"), "utf8");
  assert.equal(Buffer.from(key, "base64").length, 32);
  for (const signer of instances) {
    const url = new URL(signer.sign("owner", "/api/files/example/content"));
    for (const verifier of instances) assert.equal(verifier.verify(url), "owner");
  }
  assert.deepEqual(await readdir(directory), ["session-signing-key"]);
});

test("startup preserves an existing signing key and its links", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-auth-existing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = Buffer.alloc(32, 7).toString("base64");
  await writeFile(join(directory, "session-signing-key"), key, { mode: 0o600 });
  const first = await createAuth({} as Store, config(directory));
  const url = new URL(first.sign("owner", "/api/files/example/content"));
  const second = await createAuth({} as Store, config(directory));
  assert.equal(second.verify(url), "owner");
  assert.equal(await readFile(join(directory, "session-signing-key"), "utf8"), key);
  assert.deepEqual(await readdir(directory), ["session-signing-key"]);
});

test("new installs get their own computer name, shared by concurrent first starts", async (t) => {
  const first = await mkdtemp(join(tmpdir(), "openmuse-deployment-a-"));
  const second = await mkdtemp(join(tmpdir(), "openmuse-deployment-b-"));
  t.after(() => rm(first, { recursive: true, force: true }));
  t.after(() => rm(second, { recursive: true, force: true }));
  const starts = Array.from({ length: 8 }, () => config(first));
  await Promise.all(starts.map(resolveComputerDeployment));
  const id = await readFile(join(first, "computer-deployment-id"), "utf8");
  assert.match(id, /^[0-9a-f]{32}$/);
  for (const start of starts) assert.equal(start.computerDeploymentId, id);
  // Same PUBLIC_API_URL on one Docker engine no longer means the same container and volume.
  const other = config(second);
  await resolveComputerDeployment(other);
  assert.notEqual(
    computerIdentity(other, "local-user").volume,
    computerIdentity(starts[0], "local-user").volume,
  );
  assert.deepEqual(await readdir(first), ["computer-deployment-id"]);
});

test("a new install keeps its computer name after restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-deployment-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names: (string | undefined)[] = [];
  for (let start = 0; start < 2; start++) {
    const db = await createStore();
    t.after(() => db.close());
    const started = { ...config(directory), intelligenceApiKey: "test-project-key-never-sent" };
    await createApp(db, started);
    names.push(started.computerDeploymentId);
  }
  assert.match(names[0] ?? "", /^[0-9a-f]{32}$/);
  assert.equal(names[1], names[0]);
});

test("existing installs and explicit names keep their computer", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-deployment-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "session-signing-key"), Buffer.alloc(32, 7).toString("base64"));
  const legacy = config(directory);
  const before = computerIdentity(legacy, "local-user");
  await resolveComputerDeployment(legacy);
  assert.equal(legacy.computerDeploymentId, undefined);
  assert.deepEqual(computerIdentity(legacy, "local-user"), before);
  const named = { ...config(directory), computerDeploymentId: "fixture-deployment" };
  await resolveComputerDeployment(named);
  assert.equal(named.computerDeploymentId, "fixture-deployment");
  assert.deepEqual(await readdir(directory), ["session-signing-key"]);
});
