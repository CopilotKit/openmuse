import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const posixOnly = process.platform === "win32" && "the fake docker CLI is a POSIX script";

test("fixture lifecycle releases its server when temporary profile creation fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-fixture-init-"));
  const missing = join(directory, "missing");
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: missing, TMP: missing, TEMP: missing };
  // Start a separate test runner, not another worker of this test's harness.
  delete env.NODE_TEST_CONTEXT;
  try {
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          "--experimental-strip-types",
          "--test",
          fileURLToPath(new URL("../apps/worker/tests/lifecycle.test.ts", import.meta.url)),
        ],
        {
          env,
          timeout: 5000,
        },
      ),
      (error: Error & { code?: number; killed?: boolean; stdout?: string }) => {
        assert.equal(error.code, 1, "the failure must exit without a timeout or forced kill");
        assert.equal(error.killed, false);
        assert.match(error.stdout ?? "", /ENOENT.*mkdtemp/);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixture runner preserves isolation and cleans its container when fixture port lookup fails", {
  skip: posixOnly,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-fixture-runner-"));
  const log = join(directory, "calls.jsonl");
  await writeFile(
    join(directory, "docker"),
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_RUNNER_LOG, JSON.stringify({ args, hasToken: /^[0-9a-f]{64}$/.test(process.env.WORKER_TOKEN ?? "") }) + "\\n");
if (args[0] === "port" && args[2] === "8790") process.stdout.write("127.0.0.1:32101\\n");
if (args[0] === "port" && args[2] === "8791") { process.stderr.write("fixture port lookup failed"); process.exitCode = 17; }
`,
    { mode: 0o700 },
  );
  try {
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [fileURLToPath(new URL("../apps/worker/tests/run-docker.mjs", import.meta.url))],
        {
          env: { ...process.env, PATH: directory, FIXTURE_RUNNER_LOG: log },
          timeout: 10_000,
        },
      ),
      /fixture port lookup failed/,
    );
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; hasToken: boolean });
    assert.deepEqual(
      calls.map((call) => call.args[0]),
      ["build", "run", "port", "port", "logs", "rm"],
    );
    assert(calls.every((call) => call.hasToken));
    const run = calls[1]?.args;
    assert(run);
    for (const flag of [
      "--init",
      "--read-only",
      "--cap-drop=ALL",
      "no-new-privileges:true",
      "--memory=2g",
      "--pids-limit=256",
      "/data",
    ])
      assert(run.includes(flag));
    assert(run.includes("127.0.0.1::8790"));
    assert(run.includes("127.0.0.1::8791"));
    assert.match(run[run.indexOf("--mount") + 1] ?? "", /target=\/app\/tests,readonly$/);
    assert.deepEqual(run.slice(-3), [
      "node",
      "--experimental-strip-types",
      "tests/fixture-worker.ts",
    ]);
    const name = run[run.indexOf("--name") + 1];
    assert(name?.startsWith("openmuse-worker-test-"));
    assert.deepEqual(calls.at(-1)?.args, ["rm", "--force", "--volumes", name]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
