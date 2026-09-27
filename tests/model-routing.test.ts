import assert from "node:assert/strict";
import { test } from "node:test";
import { selectTaskModel } from "../apps/server/src/engine/model.ts";
import type { Config } from "../apps/server/src/config.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

const baseConfig: Config = {
  mode: "live",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: ".openmuse",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  agentBackend: "model",
  allowedOrigins: [],
  intelligenceApiKey: "test-key",
};

function makeTask(kind: AgentTask["kind"]): AgentTask {
  return {
    id: "t1",
    title: "test",
    prompt: "do something",
    kind,
    status: "queued",
    evidence: [],
    input: {},
    state: {},
    plan: [],
    artifactIds: [],
    createdAt: "",
    updatedAt: "",
    attempts: 0,
    leaseId: null,
    leaseUntil: null,
  };
}

test("selectTaskModel: simple tasks use simpleTaskModel with fewer steps", () => {
  const config: Config = {
    ...baseConfig,
    model: "openai/deepseek-qwen",
    chatModel: "openai/qwen3-8b",
    taskModel: "openai/qwen3-32b",
    simpleTaskModel: "openai/qwen3-4b",
  };
  for (const kind of ["monitor", "finance"] as const) {
    const result = selectTaskModel(config, makeTask(kind));
    assert.equal(result.model, "openai/qwen3-4b", `kind=${kind}`);
    assert.equal(result.maxSteps, 6, `kind=${kind}`);
  }
});

test("selectTaskModel: complex tasks use taskModel with full steps", () => {
  const config: Config = {
    ...baseConfig,
    model: "openai/deepseek-qwen",
    chatModel: "openai/qwen3-8b",
    taskModel: "openai/qwen3-32b",
    simpleTaskModel: "openai/qwen3-4b",
  };
  for (const kind of ["agent", "document", "plan"] as const) {
    const result = selectTaskModel(config, makeTask(kind));
    assert.equal(result.model, "openai/qwen3-32b", `kind=${kind}`);
    assert.equal(result.maxSteps, 16, `kind=${kind}`);
  }
});

test("selectTaskModel: falls back to chatModel when taskModel is unset", () => {
  const config: Config = {
    ...baseConfig,
    model: "openai/base",
    chatModel: "openai/small",
  };
  const result = selectTaskModel(config, makeTask("agent"));
  assert.equal(result.model, "openai/base");
  assert.equal(result.maxSteps, 16);

  const resultSimple = selectTaskModel(config, makeTask("monitor"));
  assert.equal(resultSimple.model, "openai/small");
  assert.equal(resultSimple.maxSteps, 6);
});

test("selectTaskModel: unconfigured sentinel when no model set", () => {
  const config: Config = { ...baseConfig };
  const result = selectTaskModel(config, makeTask("agent"));
  assert.equal(result.model, "openai/unconfigured");
  assert.equal(result.maxSteps, 16);
});

test("selectTaskModel: respects custom maxSteps env overrides", () => {
  const config: Config = {
    ...baseConfig,
    model: "openai/base",
    taskMaxSteps: 8,
    simpleTaskMaxSteps: 3,
    chatMaxSteps: 4,
  };
  const complex = selectTaskModel(config, makeTask("agent"));
  assert.equal(complex.maxSteps, 8);
  const simple = selectTaskModel(config, makeTask("finance"));
  assert.equal(simple.maxSteps, 3);
});

test("selectTaskModel: model-only config uses same model for all kinds", () => {
  const config: Config = { ...baseConfig, model: "openai/single" };
  for (const kind of ["monitor", "finance", "agent", "document", "plan"] as const) {
    const result = selectTaskModel(config, makeTask(kind));
    assert.equal(result.model, "openai/single", `kind=${kind}`);
  }
});
