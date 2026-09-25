import assert from "node:assert/strict";
import test from "node:test";
import type { PluginConfigView } from "../src/connectors/api.ts";
import { buildConfigFields, buildConfigPatch } from "../src/connectors/config-fields.ts";

function view(): PluginConfigView {
  return {
    id: "fixture-good",
    enabled: true,
    // The server redacts writeOnly values: apiKey arrives as "".
    config: { nickname: "tester", mode: "fast", verbose: true, apiKey: "" },
    configSchema: {
      properties: {
        apiKey: { type: "string", title: "API key", widget: "password", group: "general" },
        mode: { type: "string", title: "Mode", enum: ["fast", "slow"], group: "general" },
        nickname: { type: "string", title: "Nickname", group: "general", maxLength: 40 },
        verbose: { type: "boolean", title: "Verbose", widget: "switch", group: "general" },
      },
      required: [],
    },
    configGroups: ["general"],
    writeOnly: ["apiKey"],
  };
}

test("one field per schema property", () => {
  const fields = buildConfigFields(view());
  assert.equal(fields.length, 4);
  assert.deepEqual(fields.map((field) => field.key).sort(), [
    "apiKey",
    "mode",
    "nickname",
    "verbose",
  ]);
});

test("widget password renders a secure field", () => {
  const fields = buildConfigFields(view());
  const apiKey = fields.find((field) => field.key === "apiKey");
  assert.ok(apiKey);
  assert.equal(apiKey.secure, true);
  assert.equal(apiKey.kind, "string");
  const nickname = fields.find((field) => field.key === "nickname");
  assert.ok(nickname);
  assert.equal(nickname.secure, false);
});

test("secure fields are never prefilled, even if the server sent a value", () => {
  const v = view();
  // Simulate a misbehaving server that leaked a secret: the form must still
  // refuse to prefill it.
  v.config.apiKey = "leaked-secret";
  const fields = buildConfigFields(v);
  const apiKey = fields.find((field) => field.key === "apiKey");
  assert.ok(apiKey);
  assert.equal(apiKey.value, "");
});

test("non-secure fields carry their current values", () => {
  const fields = buildConfigFields(view());
  const byKey = new Map(fields.map((field) => [field.key, field]));
  assert.equal(byKey.get("nickname")?.value, "tester");
  assert.equal(byKey.get("mode")?.value, "fast");
  assert.equal(byKey.get("verbose")?.value, true);
  assert.equal(byKey.get("mode")?.kind, "enum");
  assert.deepEqual(byKey.get("mode")?.options, ["fast", "slow"]);
  assert.equal(byKey.get("verbose")?.kind, "boolean");
});

test("a writeOnly key without the password widget is still treated as secure", () => {
  const v = view();
  delete v.configSchema.properties?.apiKey?.widget;
  const fields = buildConfigFields(v);
  const apiKey = fields.find((field) => field.key === "apiKey");
  assert.ok(apiKey);
  assert.equal(apiKey.secure, true);
  assert.equal(apiKey.value, "");
});

test("patch: blank secure field submits empty (unchanged), untouched fields omitted", () => {
  const fields = buildConfigFields(view());
  const patch = buildConfigPatch(fields, { nickname: "new-name", apiKey: "" });
  assert.deepEqual(patch, { nickname: "new-name", apiKey: "" });
});

test("patch: filled secure field submits the new value", () => {
  const fields = buildConfigFields(view());
  const patch = buildConfigPatch(fields, { apiKey: "rotated-secret" });
  assert.deepEqual(patch, { apiKey: "rotated-secret" });
});
