import assert from "node:assert/strict";
import { test } from "node:test";
import { llmtrModelId, unknownProvider } from "../apps/server/src/engine/tanstack-agent.ts";

const spec = "deepseek/deepseek-v4.1-flash";

test("an llmtr model id keeps a hosted llmtr/ prefix and a routed vendor/model id", () => {
  assert.equal(llmtrModelId("qwen3-8-27b"), "llmtr/qwen3-8-27b");
  assert.equal(llmtrModelId("llmtr/qwen3-8-27b"), "llmtr/qwen3-8-27b");
  assert.equal(llmtrModelId("qwen/qwen3.8-27b-free"), "qwen/qwen3.8-27b-free");
});

test("an unknown provider suggests the openai/ prefix only when a gateway is set", () => {
  const gateway = unknownProvider("deepseek", spec, "https://gateway.test/v1");
  assert.match(
    gateway.message,
    /^Unknown provider "deepseek" in "deepseek\/deepseek-v4.1-flash"\./,
  );
  assert.match(gateway.message, /google \(gemini\), llmtr\./);
  assert.match(gateway.message, /use "openai\/deepseek\/deepseek-v4.1-flash"\.$/);

  for (const baseUrl of ["", "  "])
    assert.doesNotMatch(unknownProvider("deepseek", spec, baseUrl).message, /openai\//);
});

test("the unknown provider hint reads OPENAI_BASE_URL by default", () => {
  const previous = process.env.OPENAI_BASE_URL;
  try {
    delete process.env.OPENAI_BASE_URL;
    assert.doesNotMatch(unknownProvider("deepseek", spec).message, /openai\//);
    process.env.OPENAI_BASE_URL = "https://gateway.test/v1";
    assert.match(unknownProvider("deepseek", spec).message, /use "openai\//);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previous;
  }
});
