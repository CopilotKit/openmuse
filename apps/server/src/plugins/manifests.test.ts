import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { validateManifest, validatePluginConfig } from "./config-schema.ts";
import type { PluginManifest } from "./types.ts";

const FIXTURES = join(import.meta.dirname, "test/fixtures/plugins");

function goodManifest(): PluginManifest {
  return JSON.parse(
    readFileSync(join(FIXTURES, "good/openmuse.plugin.json"), "utf8"),
  ) as PluginManifest;
}

test("a valid manifest passes validation", () => {
  const result = validateManifest(goodManifest());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("rejects a bad id format", () => {
  const manifest = goodManifest();
  manifest.id = "Bad_ID!";
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("; "), /manifest\.id/);
});

test("rejects a tool without a toolMetadata entry", () => {
  const manifest = goodManifest();
  manifest.contracts.tools = [...manifest.contracts.tools, "ghost_tool"];
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("; "), /toolMetadata.*ghost_tool/);
});

test("rejects a configGroup with no matching schema property", () => {
  const manifest = goodManifest();
  manifest.configGroups = ["nope"];
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("; "), /configGroups.*"nope"/);
});

test("rejects an extra root key", () => {
  const manifest = { ...goodManifest(), controlUi: {} } as unknown as PluginManifest;
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("; "), /unknown root key "controlUi"/);
});

test("rejects a writeOnly field without the password widget", () => {
  const manifest = goodManifest();
  manifest.writeOnly = ["nickname"]; // nickname uses the default text widget
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("; "), /writeOnly.*"nickname".*password/);
});

test("rejects a writeOnly field that is not a schema property", () => {
  const manifest = goodManifest();
  manifest.writeOnly = ["ghost_setting"];
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("; "), /writeOnly.*"ghost_setting"/);
});

test("rejects a risky tool name without requiresApproval", () => {
  const manifest = goodManifest();
  manifest.contracts.tools = ["purge_deleted_items"];
  manifest.toolMetadata = {
    purge_deleted_items: { requiresApproval: false, kind: "chat", providedBy: "direct" },
  };
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("; "), /requiresApproval: true/);
});

test("accepts a risky tool name with requiresApproval", () => {
  const manifest = goodManifest();
  manifest.contracts.tools = ["purge_deleted_items"];
  manifest.toolMetadata = {
    purge_deleted_items: { requiresApproval: true, kind: "chat", providedBy: "direct" },
  };
  const result = validateManifest(manifest);
  assert.equal(result.ok, true);
});

test("rejects path traversal in skills", () => {
  const manifest = goodManifest();
  manifest.skills = ["../evil"];
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("; "), /skills.*traversal/);
});

test("rejects path traversal in cliCommands", () => {
  const manifest = goodManifest();
  manifest.cliCommands = ["..\\evil"];
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("; "), /cliCommands.*traversal/);
});

test("rejects a non-object manifest", () => {
  const result = validateManifest(null);
  assert.equal(result.ok, false);
});

test("config validation never echoes secret values in errors", () => {
  const manifest = goodManifest();
  // apiKey is writeOnly; give it a bad (non-string) value and confirm the
  // secret never appears in the error text.
  const errors = validatePluginConfig(manifest, { apiKey: 12345 }, { forbidUnknown: true });
  assert.ok(errors.length > 0);
  assert.ok(!errors.join("; ").includes("12345"));
});

test("config validation rejects unknown keys when forbidUnknown", () => {
  const errors = validatePluginConfig(goodManifest(), { bogus: true }, { forbidUnknown: true });
  assert.ok(errors.some((error) => error.includes("unknown setting") && error.includes("bogus")));
});
