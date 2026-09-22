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

function liveConfig(
  overrides: Partial<Pick<Config, "intelligenceApiKey" | "intelligenceLearningContainerId">> = {},
): Config {
  return {
    ...sampleConfig,
    mode: "live",
    agentBackend: "model",
    intelligenceApiKey: "test-project-key-never-sent",
    intelligenceLearningContainerId: "openmuse-assistant",
    ...overrides,
  };
}

const missingKeyMessage =
  "Live mode requires CPK_INTELLIGENCE_API_KEY for durable Rich Threads. " +
  "Run `npx copilotkit@latest login` and `npx copilotkit@latest project select`, " +
  "then set the generated server-only key. " +
  "See https://docs.copilotkit.ai/intelligence/connect-your-runtime";

const missingLearningContainerMessage =
  "Live mode requires CPK_INTELLIGENCE_LEARNING_CONTAINER_ID for Automatic Learning. " +
  "Create a focused container in the Intelligence project's Learning area, then set its stable ID. " +
  "See https://docs.copilotkit.ai/learning";

const invalidLearningContainerMessage =
  "CPK_INTELLIGENCE_LEARNING_CONTAINER_ID must contain 1-64 lowercase letters, numbers, or single hyphens, " +
  "with no leading, trailing, or repeated hyphen. " +
  "See https://docs.copilotkit.ai/learning";

test("live API configuration rejects a missing or blank Intelligence key", () => {
  for (const key of [undefined, "", " \t\n"]) {
    assert.throws(() => assertApiDeploymentConfig(liveConfig({ intelligenceApiKey: key })), {
      name: "Error",
      message: missingKeyMessage,
    });
  }
});

test("live API configuration reports the Intelligence key error before the Learning container ID error", () => {
  assert.throws(
    () =>
      assertApiDeploymentConfig(
        liveConfig({ intelligenceApiKey: " \t\n", intelligenceLearningContainerId: undefined }),
      ),
    {
      name: "Error",
      message: missingKeyMessage,
    },
  );
});

test("live API configuration rejects a missing or blank Learning container ID", () => {
  for (const containerId of [undefined, "", " \t\n"]) {
    assert.throws(
      () => assertApiDeploymentConfig(liveConfig({ intelligenceLearningContainerId: containerId })),
      {
        name: "Error",
        message: missingLearningContainerMessage,
      },
    );
  }
});

test("live API configuration rejects an invalid Learning container ID", () => {
  for (const containerId of [
    "OpenMuse",
    "openmuse_assistant",
    "-openmuse",
    "openmuse-",
    "openmuse--assistant",
    "a".repeat(65),
  ]) {
    assert.throws(
      () => assertApiDeploymentConfig(liveConfig({ intelligenceLearningContainerId: containerId })),
      {
        name: "Error",
        message: invalidLearningContainerMessage,
      },
    );
  }
});

test("live API configuration accepts a non-empty Intelligence key", () => {
  for (const containerId of ["openmuse", "openmuse-assistant", "assistant-2"]) {
    assert.doesNotThrow(() =>
      assertApiDeploymentConfig(liveConfig({ intelligenceLearningContainerId: containerId })),
    );
  }
});

test("sample API configuration remains key-free", () => {
  assert.doesNotThrow(() => assertApiDeploymentConfig(sampleConfig));
});

test("readConfig reads the Learning container ID from the environment", () => {
  const previous = process.env.CPK_INTELLIGENCE_LEARNING_CONTAINER_ID;
  process.env.CPK_INTELLIGENCE_LEARNING_CONTAINER_ID = "openmuse-assistant";
  try {
    assert.equal(readConfig().intelligenceLearningContainerId, "openmuse-assistant");
  } finally {
    if (previous === undefined) {
      delete process.env.CPK_INTELLIGENCE_LEARNING_CONTAINER_ID;
    } else {
      process.env.CPK_INTELLIGENCE_LEARNING_CONTAINER_ID = previous;
    }
  }
});
