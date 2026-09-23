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
