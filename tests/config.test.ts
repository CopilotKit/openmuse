import assert from "node:assert/strict";
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

function withEnv<T>(overrides: Record<string, string>, run: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = overrides[key];
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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

const invalidLearningContainerMessage =
  "CPK_INTELLIGENCE_LEARNING_CONTAINER_ID must contain 1-64 lowercase letters, numbers, or single hyphens, " +
  "with no leading, trailing, or repeated hyphen. " +
  "See https://docs.copilotkit.ai/learning";

const keyed = (config: Config, intelligenceLearningContainerId?: string): Config => ({
  ...config,
  intelligenceApiKey: "test-project-key-never-sent",
  intelligenceLearningContainerId,
});

test("Automatic Learning is opt-in: a missing or blank container ID is accepted", () => {
  for (const mode of [sampleConfig, liveConfig()]) {
    for (const containerId of [undefined, "", " \t\n"]) {
      assert.doesNotThrow(() => assertApiDeploymentConfig(keyed(mode, containerId)));
    }
  }
});

test("the Intelligence key error is reported before a Learning container ID error", () => {
  assert.throws(
    () => assertApiDeploymentConfig({ ...keyed(liveConfig(), "Bad_ID"), intelligenceApiKey: "" }),
    { name: "Error", message: missingKeyMessage },
  );
});

test("a configured Learning container ID must be valid", () => {
  for (const containerId of [
    "OpenMuse",
    "openmuse_assistant",
    "-openmuse",
    "openmuse-",
    "openmuse--assistant",
    " openmuse ",
    "a".repeat(65),
  ]) {
    assert.throws(() => assertApiDeploymentConfig(keyed(liveConfig(), containerId)), {
      name: "Error",
      message: invalidLearningContainerMessage,
    });
  }
});

test("a valid Learning container ID is accepted", () => {
  for (const containerId of ["openmuse", "openmuse-assistant", "assistant-2", "a".repeat(64)]) {
    assert.doesNotThrow(() => assertApiDeploymentConfig(keyed(liveConfig(), containerId)));
  }
});

test("readConfig reads the Learning container ID from the environment", () => {
  withEnv(
    {
      AGENT_BACKEND: "sample",
      CPK_INTELLIGENCE_API_KEY: "test-project-key-never-sent",
      CPK_INTELLIGENCE_LEARNING_CONTAINER_ID: "openmuse-assistant",
      HOST: "127.0.0.1",
      WORKSPACE_MODE: "sample",
    },
    () => {
      assert.equal(readConfig().intelligenceLearningContainerId, "openmuse-assistant");
    },
  );
});
