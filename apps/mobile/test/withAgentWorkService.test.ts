import assert from "node:assert/strict";
import { test } from "node:test";
import type { AndroidManifest } from "@expo/config-plugins";
import { applyAgentWorkManifest } from "../plugins/withAgentWorkService.ts";

/** Minimal manifest fixture: an app element with no services or permissions. */
function baseManifest(): AndroidManifest {
  return {
    manifest: {
      $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
      "uses-permission": [],
      application: [
        {
          $: { "android:name": ".MainApplication" },
          service: [],
        },
      ],
    },
  } as unknown as AndroidManifest;
}

test("applies foreground service and headless service permissions", () => {
  const manifest = baseManifest();
  applyAgentWorkManifest(manifest);

  const perms = manifest.manifest["uses-permission"] ?? [];
  const names = perms.map((p) => p.$["android:name"]);
  assert.ok(names.includes("android.permission.FOREGROUND_SERVICE"));
  assert.ok(names.includes("android.permission.FOREGROUND_SERVICE_DATA_SYNC"));
});

test("registers the two required services with the correct attributes", () => {
  const manifest = baseManifest();
  applyAgentWorkManifest(manifest);

  const services = manifest.manifest.application?.[0]?.service ?? [];
  const fg = services.find((s) => s.$["android:name"] === ".AgentWorkService");
  const headless = services.find((s) => s.$["android:name"] === ".AgentWorkHeadlessService");

  assert.ok(fg, "AgentWorkService should be registered");
  assert.equal(fg?.$["android:foregroundServiceType"], "dataSync");
  assert.equal(fg?.$["android:exported"], "false");

  assert.ok(headless, "AgentWorkHeadlessService should be registered");
  assert.equal(headless?.$["android:exported"], "false");
  assert.equal(headless?.$["android:foregroundServiceType"], undefined);
});

test("is idempotent: calling twice does not duplicate entries", () => {
  const manifest = baseManifest();
  applyAgentWorkManifest(manifest);
  applyAgentWorkManifest(manifest);

  const perms = manifest.manifest["uses-permission"] ?? [];
  assert.equal(perms.length, 2, "no duplicate permissions");

  const services = manifest.manifest.application?.[0]?.service ?? [];
  assert.equal(services.length, 2, "no duplicate services");
});

test("works when application has no pre-existing service list", () => {
  const manifest = {
    manifest: {
      $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
      application: [
        {
          $: { "android:name": ".MainApplication" },
          // No `service` array yet.
        },
      ],
    },
  } as unknown as AndroidManifest;

  applyAgentWorkManifest(manifest);

  const services = manifest.manifest.application?.[0]?.service ?? [];
  assert.equal(services.length, 2);
});

test("does nothing when application is absent", () => {
  const manifest = {
    manifest: {
      $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
      "uses-permission": [],
    },
  } as unknown as AndroidManifest;

  applyAgentWorkManifest(manifest);
  assert.equal(manifest.manifest.application, undefined);
});
