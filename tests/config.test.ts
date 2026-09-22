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
  "Live mode requires CPK_INTELLIGENCE_API_KEY for durable Rich Threads. " +
  "Run `npx copilotkit@latest login` and `npx copilotkit@latest project select`, " +
  "then set the generated server-only key. " +
  "See https://docs.copilotkit.ai/intelligence/connect-your-runtime";

test("live API configuration rejects a missing or blank Intelligence key", () => {
  for (const key of [undefined, "", " \t\n"]) {
    assert.throws(() => assertApiDeploymentConfig(liveConfig(key)), {
      name: "Error",
      message: missingKeyMessage,
    });
  }
});

test("live API configuration accepts a non-empty Intelligence key", () => {
  assert.doesNotThrow(() => assertApiDeploymentConfig(liveConfig("test-project-key-never-sent")));
});

test("sample API configuration remains key-free", () => {
  assert.doesNotThrow(() => assertApiDeploymentConfig(sampleConfig));
});
