import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const agentUrl = new URL("../apps/server/src/agent.ts", import.meta.url).href;
const appUrl = new URL("../apps/server/src/app.ts", import.meta.url).href;
const runtimeUrl = import.meta.resolve("@copilotkit/runtime/v2");
const tsxUrl = import.meta.resolve("tsx");

// A fresh process exercises config loading before the SDK creates its telemetry singleton.
// Replace fetch before importing the runtime so no test can send production telemetry.
const probe = `
const requests = [];
globalThis.fetch = async (url, options) => {
  requests.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
  return new Response('{"ok":true}', { status: 202 });
};
await import(${JSON.stringify(appUrl)});
const { makeRuntime } = await import(${JSON.stringify(agentUrl)});
const { CopilotKitIntelligence } = await import(${JSON.stringify(runtimeUrl)});
makeRuntime(
  { agentBackend: "sample" },
  {},
  { owner: async () => "local-user" },
  new CopilotKitIntelligence({ apiKey: "test-project-key-never-sent" }),
);
await new Promise(resolve => setImmediate(resolve));
console.log(JSON.stringify(requests));
`;

async function captureRuntime(envOverrides: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-telemetry-test-"));
  const env = { ...process.env };
  for (const key of [
    "DO_NOT_TRACK",
    "COPILOTKIT_TELEMETRY_DISABLED",
    "COPILOTKIT_TELEMETRY_SAMPLE_RATE",
    "COPILOTKIT_LICENSE_TOKEN",
    "COPILOTKIT_TELEMETRY_URL",
  ])
    delete env[key];
  try {
    const { stdout } = await run(
      process.execPath,
      ["--import", tsxUrl, "--input-type=module", "--eval", probe],
      {
        cwd: directory,
        env: { ...env, CPK_TELEMETRY_ID: "test-project-identity", ...envOverrides },
        timeout: 15000,
      },
    );
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "[]");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("runtime telemetry carries OpenMuse attribution and the CLI-issued project identity", async () => {
  const events = await captureRuntime();
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.url, "https://telemetry.copilotkit.ai/ingest");
  assert.equal(event.headers["X-CopilotKit-Telemetry-Id"], "test-project-identity");
  assert.equal(event.body.event, "oss.runtime.instance_created");
  assert.equal(event.body.global_properties.accessibility_title, "OpenMuse");
  assert.equal(event.body.global_properties.sampleRate, 1);
  assert.equal(JSON.stringify(event).includes("test-project-key-never-sent"), false);
});

test("each SDK opt-out prevents telemetry with a configured project identity", async () => {
  for (const key of ["DO_NOT_TRACK", "COPILOTKIT_TELEMETRY_DISABLED"])
    for (const value of ["true", "1"])
      assert.deepEqual(await captureRuntime({ [key]: value }), [], `${key}=${value}`);
});

test("an explicit zero sample rate prevents telemetry", async () => {
  assert.deepEqual(await captureRuntime({ COPILOTKIT_TELEMETRY_SAMPLE_RATE: "0" }), []);
});
