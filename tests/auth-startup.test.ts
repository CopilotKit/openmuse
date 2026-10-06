import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAuth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import type { Store } from "../apps/server/src/db.ts";

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
