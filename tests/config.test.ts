import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { assertApiDeploymentConfig, type Config, readConfig } from "../apps/server/src/config.ts";

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

const missingKeyMessage =
  "OpenMuse requires CPK_INTELLIGENCE_API_KEY. " +
  "Run `npx copilotkit@latest login` and `npx copilotkit@latest project select`, " +
  "then set the generated server-only key. " +
  "See https://docs.copilotkit.ai/intelligence/connect-your-runtime";

test("every API mode rejects a missing or blank Intelligence key", () => {
  for (const mode of [sampleConfig, liveConfig()]) {
    for (const key of [undefined, "", " \t\n"]) {
      assert.throws(() => assertApiDeploymentConfig({ ...mode, intelligenceApiKey: key }), {
        name: "Error",
        message: missingKeyMessage,
      });
    }
  }
});

test("every API mode accepts a non-empty Intelligence key", () => {
  for (const mode of [sampleConfig, liveConfig()]) {
    assert.doesNotThrow(() =>
      assertApiDeploymentConfig({ ...mode, intelligenceApiKey: "test-project-key-never-sent" }),
    );
  }
});

const configEnvKeys = [
  "WORKSPACE_MODE",
  "AGENT_BACKEND",
  "PORT",
  "PUBLIC_API_URL",
  "HOST",
  "DATA_DIR",
  "OPENMUSE_ACCESS_KEY",
  "TOKEN_ENCRYPTION_KEY",
  "CPK_INTELLIGENCE_API_KEY",
  "ALLOWED_ORIGINS",
] as const;

function withEnv(env: Record<string, string | undefined>, run: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of configEnvKeys) {
    saved.set(key, process.env[key]);
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const key of configEnvKeys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function sampleEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  return {
    WORKSPACE_MODE: "sample",
    AGENT_BACKEND: "sample",
    CPK_INTELLIGENCE_API_KEY: "test-project-key-never-sent",
    ...extra,
  } as Record<string, string>;
}

test("readConfig rejects out-of-range or non-numeric ports", () => {
  for (const port of ["abc", "", "0", "-1", "65536", "99999", "8.5", "NaN"]) {
    withEnv(sampleEnv({ PORT: port }), () => {
      assert.throws(() => readConfig(), { message: /PORT must be an integer between 1 and 65535/ });
    });
  }
  withEnv(sampleEnv({ PORT: "8790" }), () => {
    assert.equal(readConfig().port, 8790);
  });
});

test("readConfig normalizes the public URL and derives callback links from it", () => {
  withEnv(sampleEnv({ PUBLIC_API_URL: "https://example.com/" }), () => {
    const config = readConfig();
    assert.equal(config.publicUrl, "https://example.com");
    assert.equal(config.googleRedirectUri, "https://example.com/api/google/callback");
  });
  for (const url of ["not a url", "ftp://example.com", "example.com"]) {
    withEnv(sampleEnv({ PUBLIC_API_URL: url }), () => {
      assert.throws(() => readConfig(), { message: /PUBLIC_API_URL/ });
    });
  }
});

test("readConfig trims, filters, and deduplicates allowed origins", () => {
  withEnv(
    sampleEnv({ ALLOWED_ORIGINS: "https://a.example, https://b.example ,,https://a.example/" }),
    () => {
      assert.deepEqual(readConfig().allowedOrigins, ["https://a.example", "https://b.example"]);
    },
  );
  withEnv(sampleEnv({ ALLOWED_ORIGINS: "not a url" }), () => {
    assert.throws(() => readConfig(), { message: /ALLOWED_ORIGINS/ });
  });
});

test("readConfig rejects live deployments without a 32-byte encryption key", () => {
  const accessKey = "a".repeat(24);
  withEnv(
    sampleEnv({
      WORKSPACE_MODE: "live",
      AGENT_BACKEND: "model",
      OPENMUSE_ACCESS_KEY: accessKey,
      TOKEN_ENCRYPTION_KEY: "too-short",
    }),
    () => {
      assert.throws(() => readConfig(), {
        message: /TOKEN_ENCRYPTION_KEY.*32-byte base64/,
      });
    },
  );
  withEnv(
    sampleEnv({
      WORKSPACE_MODE: "live",
      AGENT_BACKEND: "model",
      OPENMUSE_ACCESS_KEY: accessKey,
      TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    }),
    () => {
      const config = readConfig();
      assert.equal(config.mode, "live");
      assert.equal(config.accessKey, accessKey);
    },
  );
});
