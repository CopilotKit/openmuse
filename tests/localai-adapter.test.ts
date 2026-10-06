import assert from "node:assert/strict";
import { test } from "node:test";
import { adapter } from "../apps/server/src/engine/tanstack-agent.ts";

process.env.OPENAI_API_KEY = "test-key";

test("local provider requires a device ID", () => {
  assert.throws(() => adapter("local/qwen3-8b"), /device ID/);
});

test("local provider with device ID does not throw", () => {
  const a = adapter("local/qwen3-8b", "device-123");
  assert.ok(a);
});

test("meaty is an alias for local", () => {
  const a = adapter("meaty/qwen3-8b", "device-123");
  assert.ok(a);
});

test("unknown provider still throws unknownProvider", () => {
  assert.throws(() => adapter("ollama/qwen3-8b"), /Unknown provider/);
});
