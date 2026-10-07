/**
 * Expo config plugin: injects the AgentWork foreground service and headless
 * recovery service into the Android manifest.
 *
 * Ported from meaty's `MeshResidencyService` pattern: a DATA_SYNC foreground
 * service keeps the phone's network connection alive so the device-loop
 * heartbeat can survive app backgrounding; the headless service runs a minimal
 * JS recovery routine when the OS restarts the process after a kill.
 *
 * The Kotlin source files live in `agent-work-service/` and are copied into
 * `android/app/src/main/java/<package>/` by the dangerous mod below, so a
 * single `expo run:android` produces a complete native build without a full
 * manual eject.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type AndroidManifest,
  type ConfigPlugin,
  withAndroidManifest,
  withDangerousMod,
} from "@expo/config-plugins";

/** Permissions the foreground service needs to keep running. */
const PERMISSIONS = [
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
] as const;

/** Kotlin source files copied into the generated android project. */
const KOTLIN_FILES = [
  "AgentWorkModule.kt",
  "AgentWorkService.kt",
  "AgentWorkHeadlessService.kt",
  "AgentWorkPackage.kt",
] as const;

/** Read `android.package` from the Expo config, falling back to the default. */
function androidPackage(config: { android?: { package?: string } }): string {
  return config.android?.package ?? "app.openmuse.mobile";
}

/** Convert a Java package name to a source-path segment. */
function packageToPath(pkg: string): string {
  return pkg.split(".").join("/");
}

/**
 * Add permissions and service entries to the manifest.
 *
 * Extracted as a pure function so tests can call it directly on a fixture
 * without driving the full Expo mod pipeline.
 */
export function applyAgentWorkManifest(manifest: AndroidManifest): void {
  const usesPerms = manifest.manifest["uses-permission"] ?? [];
  for (const name of PERMISSIONS) {
    if (!usesPerms.some((p) => p.$["android:name"] === name)) {
      usesPerms.push({ $: { "android:name": name } });
    }
  }
  manifest.manifest["uses-permission"] = usesPerms;

  const app = manifest.manifest.application?.[0];
  if (app) {
    const services = app.service ?? [];
    if (!services.some((s) => s.$["android:name"] === ".AgentWorkService")) {
      services.push({
        $: {
          "android:name": ".AgentWorkService",
          "android:exported": "false",
          "android:foregroundServiceType": "dataSync",
        },
      });
    }
    if (!services.some((s) => s.$["android:name"] === ".AgentWorkHeadlessService")) {
      services.push({
        $: {
          "android:name": ".AgentWorkHeadlessService",
          "android:exported": "false",
        },
      });
    }
    app.service = services;
  }
}

export const withAgentWorkService: ConfigPlugin = (config) => {
  config = withAndroidManifest(config, (cfg) => {
    applyAgentWorkManifest(cfg.modResults);
    return cfg;
  });

  // Copy Kotlin source files into the generated android project during prebuild.
  config = withDangerousMod(config, [
    "android",
    (cfg) => {
      const platformProjectRoot = cfg.modRequest.platformProjectRoot;
      const projectRoot = cfg.modRequest.projectRoot;
      const pkg = androidPackage(cfg);
      const srcDir = join(projectRoot, "plugins/agent-work-service");
      const destDir = join(platformProjectRoot, "app/src/main/java", packageToPath(pkg));
      mkdirSync(destDir, { recursive: true });
      for (const file of KOTLIN_FILES) {
        copyFileSync(join(srcDir, file), join(destDir, file));
      }
      return cfg;
    },
  ]);

  return config;
};
