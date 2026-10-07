import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  assertApiDeploymentConfig,
  browserWorkerUrl,
  type Config,
  readConfig,
  shadowedEnvKeys,
} from "../apps/server/src/config.ts";

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

test("web search is enabled by default with an explicit opt-out", (t) => {
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.WORKSPACE_MODE = "sample";
  process.env.AGENT_BACKEND = "model";
  process.env.HOST = "127.0.0.1";
  process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
  delete process.env.WEB_SEARCH_ENABLED;
  assert.equal(readConfig().webSearchEnabled, true);
  for (const value of ["true", "", "1", "TRUE"]) {
    process.env.WEB_SEARCH_ENABLED = value;
    assert.equal(readConfig().webSearchEnabled, true);
  }
  process.env.WEB_SEARCH_ENABLED = "false";
  assert.equal(readConfig().webSearchEnabled, false);
});

test("Jev mode is off by default and validates explicit modes", async () => {
  const { readConfig } = await import("../apps/server/src/config.ts");
  const old = {
    JEV_MODE: process.env.JEV_MODE,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    CPK_INTELLIGENCE_API_KEY: process.env.CPK_INTELLIGENCE_API_KEY,
  };
  try {
    process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
    delete process.env.JEV_MODE;
    assert.equal(readConfig().jevMode, "off");
    process.env.JEV_MODE = "sample";
    assert.equal(readConfig().jevMode, "sample");
    process.env.JEV_MODE = "live";
    delete process.env.TYPESAFE_API_KEY;
    assert.throws(() => readConfig(), /TYPESAFE_API_KEY/);
    process.env.TYPESAFE_API_KEY = "fixture-key";
    assert.equal(readConfig().typesafeApiKey, "fixture-key");
    process.env.JEV_MODE = "invalid";
    assert.throws(() => readConfig(), /JEV_MODE/);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
  const env = { OPENAI_API_KEY: "sk-proj-system", MODEL: "openai/gpt-5", EMPTY: "set" };
  assert.deepEqual(shadowedEnvKeys(file, env), ["OPENAI_API_KEY", "EMPTY"]);
  assert.deepEqual(shadowedEnvKeys(file, {}), []);
});

test("computer provider defaults to Docker and e2b-desktop requires a server-side key", async () => {
  const { readConfig } = await import("../apps/server/src/config.ts");
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
    process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
    for (const key of keys.slice(0, 5)) delete process.env[key];
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

const configEnvKeys = [
  "WORKSPACE_MODE",
  "AGENT_BACKEND",
  "PORT",
  "PUBLIC_API_URL",
  "HOST",
  "DATA_DIR",
  "OPENMUSE_ACCESS_KEY",
  "TOKEN_ENCRYPTION_KEY",
  "CPK_INTELLIGENCE_API_KEY",
  "ALLOWED_ORIGINS",
  "JEV_MODE",
  "TYPESAFE_API_KEY",
  "COMPUTER_PROVIDER",
  "COMPUTER_ENABLED",
  "E2B_API_KEY",
  "COMPUTER_DEPLOYMENT_ID",
] as const;

function withEnv(env: Record<string, string | undefined>, run: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of configEnvKeys) {
    saved.set(key, process.env[key]);
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const key of configEnvKeys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function sampleEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  return {
    WORKSPACE_MODE: "sample",
    AGENT_BACKEND: "sample",
    CPK_INTELLIGENCE_API_KEY: "test-project-key-never-sent",
    ...extra,
  } as Record<string, string>;
}

test("readConfig rejects out-of-range or non-numeric ports", () => {
  for (const port of ["abc", "", "0", "-1", "65536", "99999", "8.5", "NaN"]) {
    withEnv(sampleEnv({ PORT: port }), () => {
      assert.throws(() => readConfig(), { message: /PORT must be an integer between 1 and 65535/ });
    });
  }
  withEnv(sampleEnv({ PORT: "8790" }), () => {
    assert.equal(readConfig().port, 8790);
  });
});

test("readConfig normalizes the public URL and derives callback links from it", () => {
  withEnv(sampleEnv({ PUBLIC_API_URL: "https://example.com/" }), () => {
    const config = readConfig();
    assert.equal(config.publicUrl, "https://example.com");
    assert.equal(config.googleRedirectUri, "https://example.com/api/google/callback");
  });
  withEnv(sampleEnv({ PUBLIC_API_URL: "https://example.com:8443/" }), () => {
    const config = readConfig();
    assert.equal(config.publicUrl, "https://example.com:8443");
  });
  for (const url of ["not a url", "ftp://example.com", "example.com"]) {
    withEnv(sampleEnv({ PUBLIC_API_URL: url }), () => {
      assert.throws(() => readConfig(), { message: /PUBLIC_API_URL/ });
    });
  }
});

test("readConfig rejects credentials, queries, fragments, and subpaths in the public URL", () => {
  for (const url of [
    "https://user@example.com",
    "https://user:pass@example.com",
    "https://example.com?x=1",
    "https://example.com#fragment",
    "https://example.com/subpath",
    "https://example.com/subpath/",
  ]) {
    withEnv(sampleEnv({ PUBLIC_API_URL: url }), () => {
      assert.throws(() => readConfig(), { message: /PUBLIC_API_URL/ });
    });
  }
});

test("readConfig trims, filters, and deduplicates allowed origins", () => {
  withEnv(
    sampleEnv({ ALLOWED_ORIGINS: "https://a.example, https://b.example ,,https://a.example/" }),
    () => {
      assert.deepEqual(readConfig().allowedOrigins, ["https://a.example", "https://b.example"]);
    },
  );
  withEnv(sampleEnv({ ALLOWED_ORIGINS: "not a url" }), () => {
    assert.throws(() => readConfig(), { message: /ALLOWED_ORIGINS/ });
  });
});

test("readConfig rejects live deployments without a 32-byte encryption key", () => {
  const accessKey = "a".repeat(24);
  withEnv(
    sampleEnv({
      WORKSPACE_MODE: "live",
      AGENT_BACKEND: "model",
      OPENMUSE_ACCESS_KEY: accessKey,
      TOKEN_ENCRYPTION_KEY: "too-short",
    }),
    () => {
      assert.throws(() => readConfig(), {
        message: /TOKEN_ENCRYPTION_KEY.*32-byte base64/,
      });
    },
  );
  withEnv(
    sampleEnv({
      WORKSPACE_MODE: "live",
      AGENT_BACKEND: "model",
      OPENMUSE_ACCESS_KEY: accessKey,
      TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    }),
    () => {
      const config = readConfig();
      assert.equal(config.mode, "live");
      assert.equal(config.accessKey, accessKey);
    },
  );
});
