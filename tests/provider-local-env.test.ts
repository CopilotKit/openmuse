import assert from "node:assert/strict";
import test from "node:test";

// Set BEFORE the engine module loads. node:test runs each test file in its
// own process, so the module-load env read in providers.ts picks these up.
// No secrets involved - both values are plain endpoint/model identifiers.
process.env.LOCAL_LLM_MODEL = "llama3.2:1b";
process.env.LOCAL_LLM_BASE_URL = "http://127.0.0.1:9999/v1";

const { PROVIDER_CATALOG, LOCAL_LLM_MODEL, LOCAL_LLM_BASE_URL } = await import(
  "../apps/server/src/engine/providers.ts"
);

test("LOCAL_LLM_MODEL / LOCAL_LLM_BASE_URL override the local catalog defaults", () => {
  assert.equal(LOCAL_LLM_MODEL, "llama3.2:1b");
  assert.equal(LOCAL_LLM_BASE_URL, "http://127.0.0.1:9999/v1");
  const local = PROVIDER_CATALOG.find((entry) => entry.id === "local");
  assert.equal(local?.defaultModel, "llama3.2:1b");
  assert.equal(local?.defaultBaseUrl, "http://127.0.0.1:9999/v1");
  // Non-local entries are untouched by the override.
  const deepseek = PROVIDER_CATALOG.find((entry) => entry.id === "deepseek");
  assert.equal(deepseek?.defaultBaseUrl, "https://api.deepseek.com/v1");
});
