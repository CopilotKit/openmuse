import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";
import { agentConfigured } from "../apps/server/src/agent.ts";
import type { Config } from "../apps/server/src/config.ts";
import { providerKeyCreateSchema } from "../apps/server/src/connectors/provider-keys/schemas.ts";
import {
  type ModelsFetcher,
  ProviderKeyService,
} from "../apps/server/src/connectors/provider-keys/service.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import {
  applyProviderSelection,
  clearProviderSelection,
  getSelectedProvider,
  PROVIDER_CATALOG,
  PROVIDER_SELECTION_ID,
  PROVIDER_SELECTION_KIND,
} from "../apps/server/src/engine/providers.ts";

// Fake keys only — never real secrets in tests.
const FAKE_DEEPSEEK_KEY = "sk-test-deepseek-0001abcd";
const FAKE_ANTHROPIC_KEY = "sk-test-anthropic-0002wxyz";
const FAKE_KEY = "sk-test-rotated-0003mnop";

const OWNER = "test-owner";
const VAULT_KEY = randomBytes(32).toString("base64");

let db: Store;
let config: Config;

// Snapshot the process env slots we touch so the full suite stays green.
const ENV_SLOTS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_BASE_URL",
] as const;
const savedEnv: Record<string, string | undefined> = {};

before(async () => {
  db = await createStore();
  for (const name of ENV_SLOTS) savedEnv[name] = process.env[name];
  config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: ":memory:",
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    encryptionKey: VAULT_KEY,
    model: "openai/deepseek-chat",
  };
});

after(async () => {
  for (const name of ENV_SLOTS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  await db.close();
});

const fetchCalls: { url: string; headers: Record<string, string> }[] = [];
let nextResponse: { ok: boolean; status: number; body: string } = {
  ok: true,
  status: 200,
  body: '{"data":[]}',
};

const fakeFetcher: ModelsFetcher = async (url, init) => {
  fetchCalls.push({ url, headers: init.headers });
  const body = nextResponse.body;
  return {
    ok: nextResponse.ok,
    status: nextResponse.status,
    text: async () => body,
  };
};

const service = () => new ProviderKeyService(db, config, fakeFetcher);

test("catalog covers the expected providers", () => {
  const ids = PROVIDER_CATALOG.map((entry) => entry.id);
  for (const id of [
    "openai",
    "anthropic",
    "google",
    "deepseek",
    "xai",
    "mistral",
    "custom",
    "local",
  ])
    assert.ok(ids.includes(id as never), `catalog missing ${id}`);
  const local = PROVIDER_CATALOG.find((entry) => entry.id === "local");
  assert.equal(local?.defaultBaseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(local?.keyRequired, false);
  // Every catalog entry is agent-chat capable through a known SDK prefix.
  for (const entry of PROVIDER_CATALOG) {
    assert.equal(entry.agentChatSupported, true, entry.id);
    assert.ok(["openai", "anthropic", "google"].includes(entry.sdkPrefix), entry.id);
  }
});

test("CRUD round-trip with metadata-only responses", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "deepseek",
    label: "DeepSeek main",
    model: "deepseek-chat",
    apiKey: FAKE_DEEPSEEK_KEY,
  });
  assert.equal(created.provider, "deepseek");
  assert.equal(created.keyHint, "…abcd");
  assert.equal(created.hasKey, true);

  const listed = await svc.list(OWNER);
  assert.equal(listed.length, 1);
  // No key material anywhere in a metadata response.
  const serialised = JSON.stringify(listed);
  assert.ok(!serialised.includes(FAKE_DEEPSEEK_KEY), "key leaked into list response");
  assert.ok(!serialised.includes("secret"), "vault envelope leaked into list response");
  const raw = await db.get(OWNER, "provider-keys", created.id);
  assert.ok(!JSON.stringify(raw).includes(FAKE_DEEPSEEK_KEY), "key leaked into DB row");

  const updated = await svc.update(OWNER, created.id, { label: "DeepSeek renamed" });
  assert.equal(updated.label, "DeepSeek renamed");
  assert.equal(updated.keyHint, "…abcd");

  await svc.delete(OWNER, created.id);
  assert.deepEqual(await svc.list(OWNER), []);
});

test("first created entry becomes the selected provider", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "deepseek",
    label: "Auto-select me",
    model: "deepseek-chat",
    apiKey: FAKE_DEEPSEEK_KEY,
  });
  const selection = await svc.getSelection(OWNER);
  assert.equal(selection?.id, created.id);
  assert.equal(config.model, "openai/deepseek-chat");
  assert.equal(process.env.OPENAI_API_KEY, FAKE_DEEPSEEK_KEY);
  assert.equal(process.env.OPENAI_BASE_URL, "https://api.deepseek.com/v1");
  await svc.delete(OWNER, created.id);
});

test("key rotation re-encrypts and recomputes the hint", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "openai",
    label: "OpenAI",
    model: "gpt-5",
    apiKey: FAKE_DEEPSEEK_KEY,
  });
  const updated = await svc.update(OWNER, created.id, { apiKey: FAKE_KEY });
  assert.equal(updated.keyHint, "…mnop");
  const serialised = JSON.stringify(await svc.list(OWNER));
  assert.ok(!serialised.includes(FAKE_KEY), "rotated key leaked into list response");
  await svc.delete(OWNER, created.id);
});

test("local entries need no key and carry keyHint 'none'", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "local",
    label: "Ollama box",
    model: "qwen3:1.7b",
  });
  assert.equal(created.hasKey, false);
  assert.equal(created.keyHint, "none");
  await svc.delete(OWNER, created.id);
});

test("test endpoint calls {baseUrl}/models with the key, never generating", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "deepseek",
    label: "DeepSeek",
    model: "deepseek-chat",
    apiKey: FAKE_DEEPSEEK_KEY,
  });
  fetchCalls.length = 0;
  nextResponse = { ok: true, status: 200, body: '{"data":[{"id":"deepseek-chat"}]}' };
  const result = await svc.test(OWNER, created.id);
  assert.equal(result.ok, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://api.deepseek.com/v1/models");
  assert.equal(fetchCalls[0].headers.Authorization, `Bearer ${FAKE_DEEPSEEK_KEY}`);
  await svc.delete(OWNER, created.id);
});

test("test endpoint sanitises untrusted provider error bodies", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "mistral",
    label: "Mistral",
    model: "mistral-large-latest",
    apiKey: FAKE_KEY,
  });
  fetchCalls.length = 0;
  nextResponse = {
    ok: false,
    status: 401,
    // Oversized + control characters: must come back truncated and cleaned.
    body: `{"error":"bad key"}\n\r\t${"x".repeat(5000)}`,
  };
  const result = await svc.test(OWNER, created.id);
  assert.equal(result.ok, false);
  assert.ok(result.detail, "detail expected");
  assert.ok(result.detail.length <= 420, `detail too long: ${result.detail.length}`);
  assert.ok(!/\p{Cc}/u.test(result.detail), "control chars leaked into detail");
  assert.ok(!result.detail.includes(FAKE_KEY), "key leaked into detail");
  await svc.delete(OWNER, created.id);
});

test("anthropic probe uses x-api-key, not Bearer", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "anthropic",
    label: "Claude",
    model: "claude-sonnet-4.5",
    apiKey: FAKE_ANTHROPIC_KEY,
  });
  fetchCalls.length = 0;
  nextResponse = { ok: true, status: 200, body: '{"data":[]}' };
  const result = await svc.test(OWNER, created.id);
  assert.equal(result.ok, true);
  assert.equal(fetchCalls[0].headers["x-api-key"], FAKE_ANTHROPIC_KEY);
  assert.ok(!fetchCalls[0].headers.Authorization, "anthropic must not use Bearer");
  await svc.delete(OWNER, created.id);
});

test("selection apply sets in-memory env only, never .env", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "deepseek",
    label: "DeepSeek",
    model: "deepseek-chat",
    apiKey: FAKE_DEEPSEEK_KEY,
  });
  // Clear what create() auto-applied so the apply call below is the one tested.
  await clearProviderSelection(db, config, OWNER);
  assert.equal(config.model, "openai/deepseek-chat"); // snapshot restored

  await db.put(OWNER, PROVIDER_SELECTION_KIND, {
    id: PROVIDER_SELECTION_ID,
    providerKeyId: created.id,
  });
  const applied = await applyProviderSelection(db, config, OWNER);
  assert.equal(applied?.modelSpec, "openai/deepseek-chat");
  assert.equal(process.env.OPENAI_API_KEY, FAKE_DEEPSEEK_KEY);
  assert.equal(process.env.OPENAI_BASE_URL, "https://api.deepseek.com/v1");
  assert.equal(config.model, "openai/deepseek-chat");
  await svc.delete(OWNER, created.id);
});

test("anthropic selection applies the native anthropic/... prefix", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "anthropic",
    label: "Claude",
    model: "claude-sonnet-4.5",
    apiKey: FAKE_ANTHROPIC_KEY,
  });
  // create() auto-selected it and applied — verify the native wiring.
  assert.equal(config.model, "anthropic/claude-sonnet-4.5");
  assert.equal(process.env.ANTHROPIC_API_KEY, FAKE_ANTHROPIC_KEY);
  await svc.delete(OWNER, created.id);
});

test("local selection applies openai/... with the Ollama base URL and no key", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "local",
    label: "Ollama box",
    model: "qwen3:1.7b",
  });
  assert.equal(config.model, "openai/qwen3:1.7b");
  assert.equal(process.env.OPENAI_BASE_URL, "http://127.0.0.1:11434/v1");
  await svc.delete(OWNER, created.id);
});

test("no entries: applyProviderSelection is a strict no-op", async () => {
  const before = {
    model: config.model,
    key: process.env.OPENAI_API_KEY,
    base: process.env.OPENAI_BASE_URL,
    anthropic: process.env.ANTHROPIC_API_KEY,
    google: process.env.GOOGLE_API_KEY,
  };
  const applied = await applyProviderSelection(db, config, OWNER);
  assert.equal(applied, null);
  assert.equal(config.model, before.model);
  assert.equal(process.env.OPENAI_API_KEY, before.key);
  assert.equal(process.env.OPENAI_BASE_URL, before.base);
  assert.equal(process.env.ANTHROPIC_API_KEY, before.anthropic);
  assert.equal(process.env.GOOGLE_API_KEY, before.google);
});

test("deleting the selected entry clears selection and restores env safely", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "xai",
    label: "xAI",
    model: "grok-3",
    apiKey: FAKE_KEY,
  });
  assert.equal((await getSelectedProvider(db, OWNER))?.providerKeyId, created.id);
  await svc.delete(OWNER, created.id);
  assert.equal(await getSelectedProvider(db, OWNER), null);
  assert.equal(await svc.getSelection(OWNER), null);
  // Env snapshot restored: no trace of the deleted key remains in memory.
  assert.notEqual(process.env.OPENAI_API_KEY, FAKE_KEY);
});

test("custom provider requires a baseUrl; local rejects apiKey", () => {
  assert.throws(
    () =>
      providerKeyCreateSchema.parse({
        provider: "custom",
        label: "Mine",
        model: "m",
      }),
    /baseUrl/,
  );
  assert.throws(
    () =>
      providerKeyCreateSchema.parse({
        provider: "local",
        label: "Ollama",
        model: "qwen3:1.7b",
        apiKey: "nope",
      }),
    /no API key/,
  );
  assert.throws(
    () =>
      providerKeyCreateSchema.parse({
        provider: "openai",
        label: "OpenAI",
        model: "gpt-5",
      }),
    /requires an API key/,
  );
});

// ---------------------------------------------------------------------------
// TRACK D gap-fill tests: native Google shaping, custom-key honouring,
// keyless placeholder, echoed-secret redaction, and the deepseek-chat default.
test("google selection applies the native google/... prefix and base URL", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "google",
    label: "Gemini",
    model: "gemini-2.5-pro",
    apiKey: FAKE_KEY,
  });
  assert.equal(config.model, "google/gemini-2.5-pro");
  assert.equal(process.env.GOOGLE_API_KEY, FAKE_KEY);
  assert.equal(
    process.env.GOOGLE_GENERATIVE_AI_BASE_URL,
    "https://generativelanguage.googleapis.com/v1beta",
  );
  await svc.delete(OWNER, created.id);
});

test("google probe uses x-goog-api-key against the native models endpoint", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "google",
    label: "Gemini",
    model: "gemini-2.5-pro",
    apiKey: FAKE_KEY,
  });
  fetchCalls.length = 0;
  nextResponse = { ok: true, status: 200, body: '{"models":[]}' };
  const result = await svc.test(OWNER, created.id);
  assert.equal(result.ok, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://generativelanguage.googleapis.com/v1beta/models");
  assert.equal(fetchCalls[0].headers["x-goog-api-key"], FAKE_KEY);
  assert.ok(!fetchCalls[0].headers.Authorization, "google must not use Bearer");
  await svc.delete(OWNER, created.id);
});

test("google probe falls back to Bearer when the base URL is overridden", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "google",
    label: "Gemini proxy",
    model: "gemini-2.5-pro",
    apiKey: FAKE_KEY,
    baseUrl: "https://proxy.example.com/v1",
  });
  fetchCalls.length = 0;
  nextResponse = { ok: true, status: 200, body: '{"data":[]}' };
  const result = await svc.test(OWNER, created.id);
  assert.equal(result.ok, true);
  assert.equal(fetchCalls[0].url, "https://proxy.example.com/v1/models");
  assert.equal(fetchCalls[0].headers.Authorization, `Bearer ${FAKE_KEY}`);
  await svc.delete(OWNER, created.id);
});

test("custom entry with a key: chat-time env receives the real key", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "custom",
    label: "Proxy",
    model: "my-model",
    apiKey: FAKE_KEY,
    baseUrl: "https://proxy.example.com/v1",
  });
  // create() auto-selects the first entry and applies it; the stored key
  // must drive the runtime (a supplied custom key must not be dropped).
  assert.equal(config.model, "openai/my-model");
  assert.equal(process.env.OPENAI_API_KEY, FAKE_KEY);
  assert.equal(process.env.OPENAI_BASE_URL, "https://proxy.example.com/v1");
  await svc.delete(OWNER, created.id);
});

test("keyless custom selection uses the inert placeholder and passes agentConfigured", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "custom",
    label: "Keyless proxy",
    model: "my-model",
    baseUrl: "https://proxy.example.com/v1",
  });
  assert.equal(process.env.OPENAI_API_KEY, "none");
  assert.equal(process.env.OPENAI_BASE_URL, "https://proxy.example.com/v1");
  assert.equal(agentConfigured(config), true);
  await svc.delete(OWNER, created.id);
});

test("keyless local selection uses the inert placeholder and passes agentConfigured", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "local",
    label: "Ollama box",
    model: "qwen3:1.7b",
  });
  assert.equal(process.env.OPENAI_API_KEY, "none");
  assert.equal(process.env.OPENAI_BASE_URL, "http://127.0.0.1:11434/v1");
  assert.equal(agentConfigured(config), true);
  await svc.delete(OWNER, created.id);
});

test("probe redacts the key when a provider echoes it in an error body", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "deepseek",
    label: "DeepSeek",
    model: "deepseek-chat",
    apiKey: FAKE_DEEPSEEK_KEY,
  });
  fetchCalls.length = 0;
  nextResponse = {
    ok: false,
    status: 401,
    body: `{"error":"invalid key ${FAKE_DEEPSEEK_KEY} rejected"}`,
  };
  const result = await svc.test(OWNER, created.id);
  assert.equal(result.ok, false);
  assert.ok(result.detail && !result.detail.includes(FAKE_DEEPSEEK_KEY), "key leaked into detail");
  assert.ok(result.detail.includes("[redacted]"), "redaction marker missing");
  await svc.delete(OWNER, created.id);
});

test("probe redacts the key when a network error echoes it", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "openai",
    label: "OpenAI",
    model: "gpt-5",
    apiKey: FAKE_KEY,
  });
  const throwing: ModelsFetcher = async () => {
    throw new Error(`socket hangup while sending ${FAKE_KEY}`);
  };
  const throwingSvc = new ProviderKeyService(db, config, throwing);
  const result = await throwingSvc.test(OWNER, created.id);
  assert.equal(result.ok, false);
  assert.ok(result.detail && !result.detail.includes(FAKE_KEY), "key leaked into detail");
  assert.ok(result.detail.includes("[redacted]"), "redaction marker missing");
  await svc.delete(OWNER, created.id);
});

test("deepseek-chat stays the cost-control default model", async () => {
  const deepseek = PROVIDER_CATALOG.find((entry) => entry.id === "deepseek");
  assert.equal(deepseek?.defaultModel, "deepseek-chat");
  // No selection: the suite default (mirroring .env MODEL=openai/deepseek-chat)
  // is untouched by applyProviderSelection.
  const applied = await applyProviderSelection(db, config, OWNER);
  assert.equal(applied, null);
  assert.equal(config.model, "openai/deepseek-chat");
});

test("metadata responses never carry the secret or its envelope", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "deepseek",
    label: "DeepSeek",
    model: "deepseek-chat",
    apiKey: FAKE_DEEPSEEK_KEY,
  });
  const listed = await svc.list(OWNER);
  const seen = JSON.stringify(listed);
  assert.ok(!seen.includes(FAKE_DEEPSEEK_KEY), "secret in list output");
  assert.ok(!seen.includes("gcm") && !seen.includes("iv"), "envelope in list output");
  const one = listed.find((row) => row.id === created.id);
  assert.equal(one?.keyHint, `\u2026${FAKE_DEEPSEEK_KEY.slice(-4)}`);
  await svc.delete(OWNER, created.id);
});

test("local test probe hits the mocked Ollama /models with no auth header", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "local",
    label: "Ollama box",
    model: "qwen3:1.7b",
  });
  fetchCalls.length = 0;
  nextResponse = { ok: true, status: 200, body: '{"data":[{"id":"qwen3:1.7b"}]}' };
  const result = await svc.test(OWNER, created.id);
  assert.equal(result.ok, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "http://127.0.0.1:11434/v1/models");
  assert.ok(!fetchCalls[0].headers.Authorization, "local probe must not send an auth header");
  await svc.delete(OWNER, created.id);
});

test("local probe connection failure yields the friendly Ollama message", async () => {
  const refusingFetcher: ModelsFetcher = async () => {
    throw new Error("fetch failed");
  };
  const svc = new ProviderKeyService(db, config, refusingFetcher);
  const created = await svc.create(OWNER, {
    provider: "local",
    label: "Ollama box",
    model: "qwen3:1.7b",
  });
  const result = await svc.test(OWNER, created.id);
  assert.equal(result.ok, false);
  assert.ok(
    result.detail?.includes("http://127.0.0.1:11434/v1"),
    `unexpected detail: ${result.detail}`,
  );
  await svc.delete(OWNER, created.id);
});

test("local selection stores no key: OPENAI_API_KEY gets the inert placeholder", async () => {
  const svc = service();
  const created = await svc.create(OWNER, {
    provider: "local",
    label: "Ollama box",
    model: "qwen3:1.7b",
  });
  // create() auto-selects the first entry: the agent is now on the local model
  // with the Ollama base URL and an inert placeholder key (Ollama ignores it).
  assert.equal(config.model, "openai/qwen3:1.7b");
  assert.equal(process.env.OPENAI_BASE_URL, "http://127.0.0.1:11434/v1");
  assert.equal(process.env.OPENAI_API_KEY, "none");
  await svc.delete(OWNER, created.id);
});
