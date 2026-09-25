import assert from "node:assert/strict";
import { test } from "node:test";
import { assertApiDeploymentConfig, type Config } from "../apps/server/src/config.ts";

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

test("Jev mode is off by default and validates explicit modes", async () => {
  const { readConfig } = await import("../apps/server/src/config.ts");
  const old = {
    JEV_MODE: process.env.JEV_MODE,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    CPK_INTELLIGENCE_API_KEY: process.env.CPK_INTELLIGENCE_API_KEY,
  };
  try {
    process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
    delete process.env.JEV_MODE;
    assert.equal(readConfig().jevMode, "off");
    process.env.JEV_MODE = "sample";
    assert.equal(readConfig().jevMode, "sample");
    process.env.JEV_MODE = "live";
    delete process.env.TYPESAFE_API_KEY;
    assert.throws(() => readConfig(), /TYPESAFE_API_KEY/);
    process.env.TYPESAFE_API_KEY = "fixture-key";
    assert.equal(readConfig().typesafeApiKey, "fixture-key");
    process.env.JEV_MODE = "invalid";
    assert.throws(() => readConfig(), /JEV_MODE/);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
