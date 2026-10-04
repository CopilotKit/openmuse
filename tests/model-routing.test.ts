import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolDefinition } from "@copilotkit/runtime/v2";
import { z } from "zod";
import type { Config } from "../apps/server/src/config.ts";
import { filterTools } from "../apps/server/src/engine/conversation.ts";
import { selectTaskModel } from "../apps/server/src/engine/model.ts";
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
test("selectTaskModel: device overrides take priority over server config", () => {
  const config: Config = {
    ...baseConfig,
    model: "openai/base",
    taskModel: "openai/qwen3-32b",
    simpleTaskModel: "openai/qwen3-4b",
  };
  const overrides = {
    chatModel: "openai/mobile-chat-8b",
    taskModel: "openai/mobile-task-14b",
    simpleTaskModel: "openai/mobile-simple-3b",
  };
  // Device override wins for simple tasks.
  const simple = selectTaskModel(config, makeTask("finance"), overrides);
  assert.equal(simple.model, "openai/mobile-simple-3b");
  assert.equal(simple.maxSteps, 6);
  // Device override wins for complex tasks.
  const complex = selectTaskModel(config, makeTask("agent"), overrides);
  assert.equal(complex.model, "openai/mobile-task-14b");
  assert.equal(complex.maxSteps, 16);
});
test("selectTaskModel: device overrides fill gaps via server fallback chain", () => {
  // Only override the chat model — simple tasks should still use server config.
  const config: Config = {
    ...baseConfig,
    chatModel: "openai/qwen3-8b",
    taskModel: "openai/qwen3-32b",
    simpleTaskModel: "openai/qwen3-4b",
  };
  const overrides = { chatModel: "openai/mobile-8b" };
  const complex = selectTaskModel(config, makeTask("document"), overrides);
  assert.equal(complex.model, "openai/qwen3-32b"); // falls through to server config
  const simple = selectTaskModel(config, makeTask("monitor"), overrides);
  assert.equal(simple.model, "openai/qwen3-4b"); // falls through to server config
});
test("selectTaskModel: undefined overrides produce same result as no argument", () => {
  const config: Config = { ...baseConfig, model: "openai/test" };
  const without = selectTaskModel(config, makeTask("agent"));
  const withUndef = selectTaskModel(config, makeTask("agent"), undefined);
  assert.equal(withUndef.model, without.model);
  assert.equal(withUndef.maxSteps, without.maxSteps);
});
test("selectTaskModel: device maxSteps overrides take priority over env", () => {
  const config: Config = {
    ...baseConfig,
    model: "openai/base",
    taskMaxSteps: 20,
    simpleTaskMaxSteps: 8,
  };
  const overrides = {
    simpleTaskModel: "openai/mobile-simple",
    taskModel: "openai/mobile-task",
    taskMaxSteps: 10,
    simpleTaskMaxSteps: 4,
  };
  const complex = selectTaskModel(config, makeTask("agent"), overrides);
  assert.equal(complex.model, "openai/mobile-task");
  assert.equal(complex.maxSteps, 10);
  const simple = selectTaskModel(config, makeTask("monitor"), overrides);
  assert.equal(simple.model, "openai/mobile-simple");
  assert.equal(simple.maxSteps, 4);
});

function makeTool(name: string): ToolDefinition {
  return { name, description: "", parameters: z.object({}), execute: async () => null };
}

const allToolNames = [
  "computer_status",
  "start_computer",
  "stop_computer",
  "run_computer_command",
  "list_computer_files",
  "read_computer_file",
  "write_computer_file",
  "mkdir_computer",
  "import_computer_pdf",
  "export_computer_pdf",
  "search_mail",
  "read_mail_thread",
  "delegate_task",
  "agent_status",
  "create_goal",
  "watch_page",
  "remember_fact",
  "capture_note",
];

test("filterTools: undefined allowlist returns all tools", () => {
  const tools = allToolNames.map(makeTool);
  assert.equal(filterTools(tools, undefined).length, allToolNames.length);
});

test("filterTools: empty allowlist returns all tools", () => {
  const tools = allToolNames.map(makeTool);
  assert.equal(filterTools(tools, []).length, allToolNames.length);
});

test("filterTools: exact names keep only matched tools", () => {
  const tools = allToolNames.map(makeTool);
  const filtered = filterTools(tools, ["delegate_task", "agent_status", "remember_fact"]);
  assert.equal(filtered.length, 3);
  assert.deepEqual(
    filtered.map((t) => t.name),
    ["delegate_task", "agent_status", "remember_fact"],
  );
});

test("filterTools: prefix glob keeps all matching tools", () => {
  const tools = allToolNames.map(makeTool);
  const filtered = filterTools(tools, ["computer_*"]);
  // Only "computer_status" starts with "computer_"; other tools contain
  // "_computer_" but have different prefixes (start_computer, etc.).
  assert.equal(filtered.length, 1);
  assert.deepEqual(
    filtered.map((t) => t.name),
    ["computer_status"],
  );
});

test("filterTools: wildcard keeps everything", () => {
  const tools = allToolNames.map(makeTool);
  const filtered = filterTools(tools, ["*"]);
  // Every tool in the list, so this tracks `allToolNames` rather than a count
  // that has to be bumped by hand each time a tool is added.
  assert.equal(filtered.length, allToolNames.length);
});

test("filterTools: mixed exact and glob patterns", () => {
  const tools = allToolNames.map(makeTool);
  const filtered = filterTools(tools, ["delegate_task", "computer_status", "search_*"]);
  const names = filtered.map((t) => t.name);
  assert.equal(names.length, 3);
  assert.deepEqual(names, ["computer_status", "search_mail", "delegate_task"]);
});
test("filterTools: mobile-friendly allowlist keeps a small subset for a 3B model", () => {
  const tools = allToolNames.map(makeTool);
  // A small mobile model gets only delegation + status + memory tools.
  const filtered = filterTools(tools, ["delegate_task", "agent_status", "remember_fact"]);
  assert.equal(filtered.length, 3);
  assert.deepEqual(
    filtered.map((t) => t.name),
    ["delegate_task", "agent_status", "remember_fact"],
  );
});
