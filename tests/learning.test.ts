import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CopilotKitIntelligence,
  LearningContainerSelectorInput,
} from "@copilotkit/runtime/v2";
import type { Config } from "../apps/server/src/config.ts";
import {
  createIntelligence,
  learnedSkillsFor,
  selectLearningContainer,
} from "../apps/server/src/learning.ts";

const baseConfig: Config = {
  mode: "live",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: ".openmuse",
  agentBackend: "model",
  intelligenceApiKey: "test-project-key-never-sent",
  intelligenceLearningContainerId: "openmuse-assistant",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
};

function selectorInput(agentId: string): LearningContainerSelectorInput {
  return {
    surface: "web",
    user: { id: "local-user", name: "OpenMuse user" },
    agentId,
    input: {
      threadId: "thread-1",
      runId: "run-1",
      messages: [],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    },
  };
}

test("selectLearningContainer scopes the configured live container to the default agent", () => {
  assert.equal(selectLearningContainer(baseConfig, selectorInput("default")), "openmuse-assistant");
  assert.equal(selectLearningContainer(baseConfig, selectorInput("planner")), undefined);
  assert.equal(
    selectLearningContainer({ ...baseConfig, mode: "sample" }, selectorInput("default")),
    undefined,
  );
});

test("createIntelligence returns no client without a project key", () => {
  assert.equal(createIntelligence({ ...baseConfig, intelligenceApiKey: undefined }), undefined);
  assert.equal(createIntelligence({ ...baseConfig, intelligenceApiKey: "" }), undefined);
});

test("createIntelligence delegates its learning selector to focused default-agent selection", async () => {
  const intelligence = createIntelligence(baseConfig);
  assert.ok(intelligence);
  assert.equal(
    await intelligence.ɵgetLearningContainerId()?.(selectorInput("default")),
    "openmuse-assistant",
  );
  assert.equal(await intelligence.ɵgetLearningContainerId()?.(selectorInput("worker")), undefined);
  assert.equal(
    await createIntelligence({ ...baseConfig, mode: "sample" })?.ɵgetLearningContainerId()?.(
      selectorInput("default"),
    ),
    undefined,
  );
});

test("learnedSkillsFor returns built-in agent options only for live model learning", () => {
  const intelligence = createIntelligence(baseConfig) as CopilotKitIntelligence;
  assert.deepEqual(learnedSkillsFor(baseConfig, intelligence), {
    client: intelligence,
    containerId: "openmuse-assistant",
  });
  assert.equal(learnedSkillsFor({ ...baseConfig, mode: "sample" }, intelligence), undefined);
  assert.equal(learnedSkillsFor({ ...baseConfig, agentBackend: "agui" }, intelligence), undefined);
  assert.equal(
    learnedSkillsFor({ ...baseConfig, intelligenceLearningContainerId: undefined }, intelligence),
    undefined,
  );
  assert.equal(learnedSkillsFor(baseConfig, undefined), undefined);
});
