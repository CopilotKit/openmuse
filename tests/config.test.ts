import assert from "node:assert/strict";
import { test } from "node:test";
import { browserWorkerUrl, readConfig, shadowedEnvKeys } from "../apps/server/src/config.ts";

// Environment keys touched by readConfig. Each test saves, mutates, and
// restores them so the suite stays isolated from the developer's .env / shell.
const envKeys = [
  "CPK_INTELLIGENCE_API_KEY",
  "WORKSPACE_MODE",
  "AGENT_BACKEND",
  "COMPUTER_PROVIDER",
  "COMPUTER_ENABLED",
  "E2B_API_KEY",
  "COMPUTER_E2B_TEMPLATE",
  "COMPUTER_DEPLOYMENT_ID",
  "OPENMUSE_ACCESS_KEY",
  "TOKEN_ENCRYPTION_KEY",
  "OPENAI_API_FORMAT",
];

function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const old = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  try {
    for (const k of envKeys) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("CPK_INTELLIGENCE_API_KEY is optional in every workspace mode (Rich Threads off)", () => {
  // Sample mode runs self-contained without the key.
  withEnv({ WORKSPACE_MODE: "sample", AGENT_BACKEND: "sample" }, () => {
    const config = readConfig();
    assert.equal(config.intelligenceApiKey, undefined);
    assert.equal(config.mode, "sample");
  });
  // Live mode also starts without the key; only the access key and the
  // encryption key gate live mode, not CopilotKit Intelligence.
  withEnv(
    {
      WORKSPACE_MODE: "live",
      AGENT_BACKEND: "model",
      OPENMUSE_ACCESS_KEY: "0123456789abcdef0123456789abcdef",
      TOKEN_ENCRYPTION_KEY: "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=",
    },
    () => {
      const config = readConfig();
      assert.equal(config.intelligenceApiKey, undefined);
      assert.equal(config.mode, "live");
    },
  );
});

test("readConfig reads a non-empty Intelligence key when one is set", () => {
  withEnv(
    {
      WORKSPACE_MODE: "sample",
      AGENT_BACKEND: "sample",
      CPK_INTELLIGENCE_API_KEY: "  sk-project-key  ",
    },
    () => {
      assert.equal(readConfig().intelligenceApiKey, "sk-project-key");
    },
  );
});

test("browser worker URL keeps an existing scheme and adds http to host:port", () => {
  assert.equal(browserWorkerUrl(undefined), undefined);
  assert.equal(browserWorkerUrl("  "), undefined);
  assert.equal(browserWorkerUrl("http://127.0.0.1:8790"), "http://127.0.0.1:8790");
  assert.equal(browserWorkerUrl("https://browser.internal:8790"), "https://browser.internal:8790");
  assert.equal(browserWorkerUrl("openmuse-browser-h4fx:8790"), "http://openmuse-browser-h4fx:8790");
});

test("environment variables that override a different .env value are reported by name", () => {
  const file = { OPENAI_API_KEY: "sk-or-file", MODEL: "openai/gpt-5", PORT: "8787", EMPTY: "" };
  const env = { OPENAI_API_KEY: "«redacted:sk-…»", MODEL: "openai/gpt-5", EMPTY: "set" };
  assert.deepEqual(shadowedEnvKeys(file, env), ["OPENAI_API_KEY", "EMPTY"]);
  assert.deepEqual(shadowedEnvKeys(file, {}), []);
});

test("computer provider defaults to Docker and e2b-desktop requires a server-side key", async () => {
  // readConfig() reads process.env on each call, so the static import above is
  // sufficient; no per-test re-import is needed.
  const keys = [
    "COMPUTER_PROVIDER",
    "COMPUTER_ENABLED",
    "E2B_API_KEY",
    "COMPUTER_E2B_TEMPLATE",
    "COMPUTER_DEPLOYMENT_ID",
    "CPK_INTELLIGENCE_API_KEY",
  ];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    // No Intelligence key is required to read config now; this exercises only
    // the computer-provider validation path.
    for (const key of keys) delete process.env[key];
    assert.equal(readConfig().computerProvider, "docker");
    process.env.COMPUTER_PROVIDER = "k8s";
    assert.throws(() => readConfig(), /COMPUTER_PROVIDER/);
    process.env.COMPUTER_PROVIDER = "e2b-desktop";
    process.env.COMPUTER_ENABLED = "true";
    process.env.E2B_API_KEY = " ";
    assert.throws(() => readConfig(), /E2B_API_KEY/);
    process.env.E2B_API_KEY = "fixture-key";
    // A team-wide sandbox namespace needs an explicit, unique deployment id.
    assert.throws(() => readConfig(), /COMPUTER_DEPLOYMENT_ID/);
    process.env.COMPUTER_DEPLOYMENT_ID = "fixture-deployment";
    const config = readConfig();
    assert.equal(config.computerProvider, "e2b-desktop");
    assert.equal(config.computerE2bTemplate, "desktop");
    assert.equal(config.e2bApiKey, "fixture-key");
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
