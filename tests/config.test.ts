import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  loadServerSecrets,
  MIGRATED_SERVER_SECRETS,
} from "../apps/server/src/config/server-secrets.ts";
import { assertApiDeploymentConfig, type Config, readConfig } from "../apps/server/src/config.ts";
import type { Store } from "../apps/server/src/db.ts";
import { encryptSecret } from "../packages/integrations/src/vault.ts";

const sampleConfig: Config = {
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: ".openmuse",
  agentBackend: "sample",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
};

function liveConfig(intelligenceApiKey?: string): Config {
  return {
    ...sampleConfig,
    mode: "live",
    agentBackend: "model",
    intelligenceApiKey,
  };
}

test("live API configuration warns but does not throw without an Intelligence key", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    for (const key of [undefined, "", " \t\n"]) {
      assert.doesNotThrow(() => assertApiDeploymentConfig(liveConfig(key)));
    }
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /CPK_INTELLIGENCE_API_KEY is not set/);
});

test("live API configuration accepts a non-empty Intelligence key", () => {
  assert.doesNotThrow(() => assertApiDeploymentConfig(liveConfig("test-project-key-never-sent")));
});

test("sample API configuration remains key-free", () => {
  assert.doesNotThrow(() => assertApiDeploymentConfig(sampleConfig));
});

// ---------------------------------------------------------------------------
// TRACK C: server-secrets vault (loadServerSecrets)
// ---------------------------------------------------------------------------

/** In-memory fake for the Store interface (get/put only). */
class FakeStore {
  private data = new Map<string, unknown>();
  async get<T>(owner: string, kind: string, id: string): Promise<T | null> {
    return (this.data.get(`${owner}/${kind}/${id}`) as T | undefined) ?? null;
  }
  async put<T extends { id: string }>(owner: string, kind: string, value: T): Promise<T> {
    this.data.set(`${owner}/${kind}/${value.id}`, value);
    return value;
  }
}

function fakeMasterKey(): string {
  return randomBytes(32).toString("base64");
}

const SECRET_ENV_NAMES = [...MIGRATED_SERVER_SECRETS, "WORKSPACE_MODE", "TOKEN_ENCRYPTION_KEY"];

function snapshotEnv(): Map<string, string | undefined> {
  return new Map(SECRET_ENV_NAMES.map((n) => [n, process.env[n]]));
}

function restoreEnv(snap: Map<string, string | undefined>): void {
  for (const [name, value] of snap) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function clearSecretEnv(): void {
  for (const name of SECRET_ENV_NAMES) delete process.env[name];
}

test("server secrets round-trip: encrypt -> store -> load -> materialize into process.env", async () => {
  const snap = snapshotEnv();
  try {
    const masterKey = fakeMasterKey();
    const store = new FakeStore();
    const plaintexts = new Map<string, string>();
    for (const name of MIGRATED_SERVER_SECRETS) {
      const plaintext = `test-value-${name}-${randomBytes(8).toString("hex")}`;
      plaintexts.set(name, plaintext);
      await store.put("server", "server-secrets", {
        id: name,
        encrypted: encryptSecret(plaintext, masterKey),
        updatedAt: new Date().toISOString(),
      });
    }
    clearSecretEnv();
    const loaded = await loadServerSecrets(store as unknown as Store, masterKey);
    assert.deepEqual([...loaded].sort(), [...MIGRATED_SERVER_SECRETS].sort());
    for (const name of MIGRATED_SERVER_SECRETS) {
      assert.equal(process.env[name], plaintexts.get(name));
    }
  } finally {
    restoreEnv(snap);
  }
});

test("loadServerSecrets throws a clear key-naming error when vault and env are both empty", async () => {
  const snap = snapshotEnv();
  try {
    clearSecretEnv();
    const store = new FakeStore();
    await assert.rejects(
      () => loadServerSecrets(store as unknown as Store, fakeMasterKey()),
      (err: unknown) => {
        assert.match((err as Error).message, /OPENAI_API_KEY/);
        assert.match((err as Error).message, /server-secrets/);
        return true;
      },
    );
  } finally {
    restoreEnv(snap);
  }
});

test("loadServerSecrets throws naming TOKEN_ENCRYPTION_KEY when the master key is missing", async () => {
  const snap = snapshotEnv();
  try {
    clearSecretEnv();
    const store = new FakeStore();
    await assert.rejects(
      () => loadServerSecrets(store as unknown as Store, undefined),
      /TOKEN_ENCRYPTION_KEY/,
    );
  } finally {
    restoreEnv(snap);
  }
});

test("loadServerSecrets names the key (never the value) when a vault record fails to decrypt", async () => {
  const snap = snapshotEnv();
  try {
    clearSecretEnv();
    const store = new FakeStore();
    // Record encrypted with a DIFFERENT master key: auth must fail.
    await store.put("server", "server-secrets", {
      id: "OPENAI_API_KEY",
      encrypted: encryptSecret("another-key-ciphertext", fakeMasterKey()),
      updatedAt: new Date().toISOString(),
    });
    await assert.rejects(
      () => loadServerSecrets(store as unknown as Store, fakeMasterKey()),
      (err: unknown) => {
        const message = (err as Error).message;
        assert.match(message, /OPENAI_API_KEY/);
        assert.match(message, /failed to decrypt/);
        assert.doesNotMatch(message, /another-key-ciphertext/);
        return true;
      },
    );
  } finally {
    restoreEnv(snap);
  }
});

test("loadServerSecrets keeps the .env value with a warning when the vault is empty (pre-migration)", async () => {
  const snap = snapshotEnv();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    clearSecretEnv();
    process.env.OPENAI_API_KEY = "pre-migration-env-value";
    process.env.WHATSAPP_SIDECAR_TOKEN = "pre-migration-env-value";
    process.env.OPENMUSE_ACCESS_KEY = "pre-migration-env-value-24+chars!!";
    const store = new FakeStore();
    const loaded = await loadServerSecrets(store as unknown as Store, fakeMasterKey());
    assert.deepEqual([...loaded].sort(), [...MIGRATED_SERVER_SECRETS].sort());
    assert.equal(process.env.OPENAI_API_KEY, "pre-migration-env-value");
    assert.equal(warnings.length, MIGRATED_SERVER_SECRETS.length);
    for (const name of MIGRATED_SERVER_SECRETS) {
      assert.ok(
        warnings.some((w) => w.includes(name)),
        `expected a warning naming ${name}`,
      );
    }
    assert.ok(!warnings.some((w) => w.includes("pre-migration-env-value")));
  } finally {
    console.warn = originalWarn;
    restoreEnv(snap);
  }
});

test("readConfig() live-mode gates pass with vault-materialized secrets", async () => {
  const snap = snapshotEnv();
  try {
    const masterKey = fakeMasterKey();
    const store = new FakeStore();
    // Simulate the post-migration state: keys absent from the environment.
    clearSecretEnv();
    const accessKey = `test-access-key-${randomBytes(12).toString("hex")}`;
    assert.ok(accessKey.length >= 24);
    await store.put("server", "server-secrets", {
      id: "OPENMUSE_ACCESS_KEY",
      encrypted: encryptSecret(accessKey, masterKey),
      updatedAt: new Date().toISOString(),
    });
    await store.put("server", "server-secrets", {
      id: "OPENAI_API_KEY",
      encrypted: encryptSecret("vault-openai-key", masterKey),
      updatedAt: new Date().toISOString(),
    });
    await store.put("server", "server-secrets", {
      id: "WHATSAPP_SIDECAR_TOKEN",
      encrypted: encryptSecret("vault-sidecar-token", masterKey),
      updatedAt: new Date().toISOString(),
    });
    await loadServerSecrets(store as unknown as Store, masterKey);
    process.env.WORKSPACE_MODE = "live";
    process.env.TOKEN_ENCRYPTION_KEY = masterKey;
    const config = readConfig();
    assert.equal(config.accessKey, accessKey);
    assert.equal(config.encryptionKey, masterKey);
    assert.equal(process.env.OPENAI_API_KEY, "vault-openai-key");
    assert.equal(process.env.WHATSAPP_SIDECAR_TOKEN, "vault-sidecar-token");
  } finally {
    restoreEnv(snap);
  }
});
