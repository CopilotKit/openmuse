import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { defineTool } from "@copilotkit/runtime/v2";
import type { z } from "zod";
import type { Config } from "../config.ts";
import { createStore, type Store } from "../db.ts";
import { discoverPlugins } from "./discovery.ts";
import { loadPlugins } from "./loader.ts";
import type { PluginRegistry } from "./registry.ts";

const FIXTURES = join(import.meta.dirname, "test/fixtures/plugins");
const OWNER = "owner-1";

let db: Store;
let registry: PluginRegistry;
let config: Config;

const workerHost = {
  defineTool: <T extends z.ZodType>(
    name: string,
    description: string,
    parameters: T,
    execute: (args: z.output<T>) => Promise<unknown>,
  ) =>
    defineTool({
      name,
      description,
      parameters,
      execute: (args) => execute(args as z.output<T>),
    }),
  addEvidence: async (_entry: {
    id: string;
    kind: string;
    title: string;
    url: string;
    excerpt: string;
  }) => {},
};

before(async () => {
  db = await createStore();
  config = {
    encryptionKey: randomBytes(32).toString("base64"),
  } as Config;
  const { plugins, errors } = await discoverPlugins([FIXTURES]);
  assert.deepEqual(
    errors.map((error) => error.dir.split("/").pop()).sort(),
    [
      "bad-id",
      "config-group-mismatch",
      "extra-key",
      "invalid-json",
      "risky-tool-no-approval",
      "skills-traversal",
      "writeonly-no-password",
    ].sort(),
  );
  registry = await loadPlugins({
    db,
    config,
    bindings: {},
    discovered: plugins,
    discoveryErrors: errors,
  });
  assert.ok(registry.getLoaded("fixture-good"), "fixture-good should load");
});

after(async () => {
  await db.close();
});

test("a declared-but-unregistered tool fails the load (reported, not thrown)", () => {
  // fixture-no-export has a valid manifest but its plugin.ts registers nothing.
  assert.equal(registry.getLoaded("fixture-no-export")?.status, "error");
  assert.ok(
    registry.errors().some((error) => error.pluginId === "fixture-no-export"),
    "expected a load error for fixture-no-export",
  );
});

test("enable/disable flips chat tool availability", async () => {
  const names = async () => (await registry.chatTools(OWNER)).map((tool) => tool.name);
  assert.ok((await names()).includes("fixture_echo"));
  await registry.updateConfig(OWNER, "fixture-good", { enabled: false });
  assert.ok(!(await names()).includes("fixture_echo"));
  await registry.updateConfig(OWNER, "fixture-good", { enabled: true });
  assert.ok((await names()).includes("fixture_echo"));
});

test("enable/disable flips worker tool availability", async () => {
  const names = async () =>
    (await registry.workerTools(OWNER, workerHost)).map((tool) => tool.name);
  assert.ok((await names()).includes("fixture_worker_echo"));
  await registry.updateConfig(OWNER, "fixture-good", { enabled: false });
  assert.ok(!(await names()).includes("fixture_worker_echo"));
  await registry.updateConfig(OWNER, "fixture-good", { enabled: true });
  assert.ok((await names()).includes("fixture_worker_echo"));
});

test("PATCH with an unknown config key is rejected", async () => {
  await assert.rejects(
    () => registry.updateConfig(OWNER, "fixture-good", { config: { bogus: 1 } }),
    /unknown config key "bogus"/,
  );
});

test("PATCH with an invalid config value is rejected without echoing secrets", async () => {
  await assert.rejects(
    () => registry.updateConfig(OWNER, "fixture-good", { config: { apiKey: 12345 } }),
    (error: Error) => {
      assert.match(error.message, /expected string/);
      assert.ok(!error.message.includes("12345"));
      return true;
    },
  );
});

test("GET config never returns writeOnly values", async () => {
  await registry.updateConfig(OWNER, "fixture-good", {
    config: { nickname: "tester", apiKey: "s3cret-value" },
  });
  const view = (await registry.publicConfig(OWNER, "fixture-good")) as {
    config: Record<string, unknown>;
  };
  assert.equal(view.config.nickname, "tester");
  assert.equal(view.config.apiKey, "", "writeOnly values must be redacted to empty string");
  // The stored value is the encrypted envelope, not the plaintext.
  const state = await db.getPluginState(OWNER, "fixture-good");
  const stored = state?.config?.apiKey;
  assert.equal(typeof stored, "string");
  assert.ok((stored as string).startsWith("v1."));
  assert.ok(!(stored as string).includes("s3cret-value"));
});

test("writeOnly empty string on PATCH leaves the stored secret unchanged", async () => {
  const before = await db.getPluginState(OWNER, "fixture-good");
  await registry.updateConfig(OWNER, "fixture-good", { config: { apiKey: "" } });
  const after = await db.getPluginState(OWNER, "fixture-good");
  assert.equal(after?.config?.apiKey, before?.config?.apiKey);
});

test("dataBinding invoke validates params and is owner-scoped", async () => {
  const result = await registry.invokeBinding(OWNER, "fixture-good", "ping", {});
  assert.deepEqual(result, { pong: true });
  await assert.rejects(
    () => registry.invokeBinding(OWNER, "fixture-good", "ping", { extra: 1 }),
    /unknown param/,
  );
  await assert.rejects(
    () => registry.invokeBinding(OWNER, "fixture-good", "nope", {}),
    /Unknown data binding/,
  );
});

test("invoke rejects oversized binding results (metadata-only cap)", async () => {
  await assert.rejects(() => registry.invokeBinding(OWNER, "fixture-good", "big", {}), /256 KB/);
});

test("invoke on a disabled plugin is refused", async () => {
  await registry.updateConfig(OWNER, "fixture-good", { enabled: false });
  await assert.rejects(() => registry.invokeBinding(OWNER, "fixture-good", "ping", {}), /disabled/);
  await registry.updateConfig(OWNER, "fixture-good", { enabled: true });
});

test("doctor migrations run exactly once per plugin", async () => {
  const fixture = await import("./test/fixtures/plugins/good/plugin.ts");
  const runsAfterLoad = fixture.migrationRuns;
  assert.ok(runsAfterLoad >= 1, "migration should have run during load");
  await registry.runDoctor("fixture-good");
  await registry.runDoctor("fixture-good");
  assert.equal(fixture.migrationRuns, runsAfterLoad, "migration must not run twice");
  const state = await db.getPluginState("", "fixture-good");
  assert.ok(state?.doctorMigrations?.includes("seed-defaults"));
});

test("doctor configRepair drops unknown keys with a warning instead of failing", async () => {
  const state = (await db.getPluginState(OWNER, "fixture-good")) ?? {
    id: "fixture-good",
    updatedAt: new Date().toISOString(),
  };
  state.config = { ...(state.config ?? {}), bogus: "drop-me" };
  await db.putPluginState(OWNER, "fixture-good", state);
  await registry.runDoctor("fixture-good"); // must not throw
  const repaired = await db.getPluginState(OWNER, "fixture-good");
  assert.ok(!("bogus" in (repaired?.config ?? {})), "unknown key should be dropped");
});

test("service() exposes the activation service", () => {
  assert.equal(registry.service("fixture-good"), undefined); // fixture has no service
  assert.equal(registry.service("missing"), undefined);
});
