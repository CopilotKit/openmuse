import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { ComputerService, type DockerResult } from "../apps/server/src/computer.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { config, fixture, ok, sandbox } from "./helpers/computer.ts";

let db: Store;
before(async () => {
  db = await createStore();
});
after(async () => {
  await db.close();
});

test("disabled computer reports setup without invoking Docker", async () => {
  const f = fixture();
  const service = new ComputerService(db, { ...config, computerEnabled: false }, f.runner);
  assert.equal((await service.snapshot("owner")).status, "unconfigured");
  await assert.rejects(service.execute("owner", { command: "pwd" }), /not configured/);
  assert.equal(f.calls.length, 0);
});

test("commands execute solely as Docker argv and persist failed exit/output receipts", async () => {
  const f = fixture({
    command: async () => ({ ...ok("partial output"), stderr: "bad input", exitCode: 7 }),
  });
  const service = new ComputerService(db, config, f.runner);
  const command = "printf '$HOME'; exit 7; $(touch /host-must-not-run)";
  const result = await service.execute("owner", { command });
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, "partial output");
  assert.equal(result.stderr, "bad input");
  assert.deepEqual(await db.get("owner", "computer-commands", result.id), result);
  const call = f.calls.find((c) => c.args[0] === "exec");
  assert.ok(call);
  assert.equal(call.args.at(-1), command);
  assert.ok(call.args.includes("/usr/bin/timeout"));
  assert.ok(call.args.includes("/bin/bash"));
  assert.ok(f.calls.every((c) => c.timeoutMs > 0 && c.timeoutMs <= 35000));
  assert.equal((await service.snapshot("other-owner")).commands.length, 0);
});

test("a running command holds an atomic lease across service instances", async () => {
  let finish: ((result: DockerResult) => void) | undefined;
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const f = fixture({
    command: () =>
      new Promise((resolve) => {
        finish = resolve;
        signalStarted?.();
      }),
  });
  const first = new ComputerService(db, config, f.runner);
  const second = new ComputerService(db, config, f.runner);
  const run = first.execute("owner", { command: "sleep 1" });
  await started;
  await assert.rejects(second.execute("owner", { command: "pwd" }), /busy/);
  finish?.(ok());
  await run;
});

test("timeouts and interruptions remain durable and idempotent commands never replay", async () => {
  const f = fixture({
    command: async () => ({ ...ok("partial"), timedOut: true, exitCode: null }),
  });
  const service = new ComputerService(db, config, f.runner);
  const first = await service.execute(
    "owner",
    { command: "sleep 999" },
    { idempotencyKey: "timeout-case" },
  );
  assert.equal(first.status, "timed_out");
  const count = f.calls.length;
  assert.deepEqual(
    await service.execute("owner", { command: "sleep 999" }, { idempotencyKey: "timeout-case" }),
    first,
  );
  assert.equal(f.calls.length, count);
  const stopped = fixture({
    command: async () => ({ ...ok(), interrupted: true, exitCode: null }),
  });
  assert.equal(
    (await new ComputerService(db, config, stopped.runner).execute("owner", { command: "sleep 2" }))
      .status,
    "interrupted",
  );
});

test("attaching an existing container fails closed on unsafe isolation or owner labels", async () => {
  for (const modify of [
    (value: ReturnType<typeof sandbox>) => {
      value.HostConfig.Privileged = true;
    },
    (value: ReturnType<typeof sandbox>) => {
      value.HostConfig.NetworkMode = "bridge";
    },
    (value: ReturnType<typeof sandbox>) => {
      value.HostConfig.SecurityOpt.push("seccomp=unconfined");
    },
    (value: ReturnType<typeof sandbox>) => {
      value.Config.Labels = {};
    },
    (value: ReturnType<typeof sandbox>) => {
      value.Mounts[0].Type = "bind";
    },
    (value: ReturnType<typeof sandbox>) => {
      value.Config.Env.push("OPENAI_API_KEY=must-not-enter");
    },
  ]) {
    const inspect = sandbox();
    modify(inspect);
    const f = fixture({ inspect });
    const service = new ComputerService(db, config, f.runner);
    await assert.rejects(service.execute("owner", { command: "pwd" }), /isolation|ownership/);
    assert.ok(!f.calls.some((c) => c.args[0] === "exec"));
  }
});

test("paths cannot escape the workspace and file contents travel on stdin", async () => {
  const f = fixture({ command: async () => ok(JSON.stringify({ path: "/workspace/note.txt" })) });
  const service = new ComputerService(db, config, f.runner);
  for (const path of ["/etc/passwd", "/workspace/../secret", "relative", "/workspace\0/file"])
    await assert.rejects(service.read("owner", path), /workspace|path/i);
  const text = "$(touch /host-must-not-run)\nquoted ' content";
  assert.deepEqual(await service.write("owner", "/workspace/note.txt", text), {
    path: "/workspace/note.txt",
  });
  const call = f.calls.find((c) => c.args[0] === "exec");
  assert.ok(call);
  assert.equal(JSON.parse(call.input ?? "{}").text, text);
  assert.ok(!call.args.some((arg) => arg.includes(text)));
});

test("Stop interrupts an active command and its final output cannot overwrite the interrupted receipt", async () => {
  let finish: ((result: DockerResult) => void) | undefined;
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const f = fixture({
    command: () =>
      new Promise((resolve) => {
        finish = resolve;
        signalStarted?.();
      }),
  });
  const service = new ComputerService(db, config, f.runner);
  const command = service.execute("owner", { command: "sleep 30" });
  await started;
  await service.stop("owner");
  finish?.({ ...ok("partial before stop"), exitCode: 137 });
  const receipt = await command;
  assert.equal(receipt.status, "interrupted");
  assert.equal(receipt.stdout, "partial before stop");
});

test("exit 137 without a recorded stop remains a failed command", async () => {
  const f = fixture({ command: async () => ({ ...ok(), exitCode: 137 }) });
  assert.equal(
    (await new ComputerService(db, config, f.runner).execute("owner", { command: "exit 137" }))
      .status,
    "failed",
  );
});

test("restart waits until a delayed pre-stop Docker execution acknowledges completion", async () => {
  const inspection = sandbox(true);
  let release: (() => void) | undefined;
  let signalReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let executions = 0;
  const f = fixture({ inspect: inspection });
  const service = new ComputerService(db, config, async (args, options) => {
    if (args[0] === "container" && args[1] === "stop") inspection.State.Running = false;
    if (args[0] === "container" && args[1] === "start") inspection.State.Running = true;
    if (args[0] === "exec") {
      signalReady?.();
      await gate;
      if (!inspection.State.Running) return { ...ok(), exitCode: 125 };
      executions += 1;
      return ok("executed");
    }
    return f.runner(args, options);
  });
  const command = service.execute("owner", { command: "echo delayed" });
  try {
    await ready;
    await service.stop("owner");
    await assert.rejects(service.start("owner"), /busy/);
  } finally {
    release?.();
    await command;
  }
  assert.equal((await command).status, "interrupted");
  assert.equal(executions, 0);
  assert.equal((await service.start("owner")).status, "running");
});

test("failed Stop keeps commands quarantined and can be retried before the lease expires", async () => {
  const inspection = sandbox(true);
  let release: (() => void) | undefined;
  let signalReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  const f = fixture({ inspect: inspection });
  const service = new ComputerService(db, config, async (args, options) => {
    if (args[0] === "exec") {
      signalReady?.();
      await gate;
      return { ...ok(), exitCode: 137 };
    }
    if (args[0] === "container" && args[1] === "stop") {
      if (++attempts === 1) return { ...ok(), exitCode: 1 };
      inspection.State.Running = false;
    }
    if (args[0] === "container" && args[1] === "start") inspection.State.Running = true;
    return f.runner(args, options);
  });
  const command = service.execute("owner", { command: "sleep 30" });
  try {
    await ready;
    await assert.rejects(service.stop("owner"), /Docker/);
    await assert.rejects(service.start("owner"), /busy/);
    assert.equal((await service.stop("owner")).status, "stopped");
  } finally {
    release?.();
    await command;
  }
  assert.equal((await command).status, "interrupted");
  assert.equal(attempts, 2);
  assert.equal((await service.start("owner")).status, "running");
});

test("a timeout with unconfirmed Docker cleanup stays quarantined until Stop succeeds", async () => {
  let failStop = true;
  const inspection = sandbox(true);
  const f = fixture({ inspect: inspection });
  const service = new ComputerService(db, config, async (args, options) => {
    if (args[0] === "exec") return { ...ok("partial"), timedOut: true, exitCode: null };
    if (args[0] === "container" && args[1] === "stop") {
      if (failStop) return { ...ok(), timedOut: true, exitCode: null };
      inspection.State.Running = false;
    }
    if (args[0] === "container" && args[1] === "start") inspection.State.Running = true;
    return f.runner(args, options);
  });
  assert.equal((await service.execute("owner", { command: "sleep 99" })).status, "timed_out");
  await assert.rejects(service.start("owner"), /busy/);
  failStop = false;
  assert.equal((await service.stop("owner")).status, "stopped");
  assert.equal((await service.start("owner")).status, "running");
});

test("an expired lease from a dead executor recovers as interrupted without replay", async () => {
  const id = createHash("sha256").update("computer-command:dead-executor").digest("hex");
  await db.put("owner", "computer-commands", {
    id,
    command: "echo unknown",
    cwd: "/workspace",
    status: "running",
    stdout: "",
    stderr: "",
    truncated: false,
    startedAt: new Date(Date.now() - 200000).toISOString(),
  });
  await db.put("owner", "computer-state", {
    id: "lease",
    token: "dead-process",
    expiresAt: Date.now() - 1,
    stopping: true,
    stopInFlight: true,
    stopAttempt: "dead-attempt",
    stopConfirmed: false,
    executorDone: false,
    operation: "command",
  });
  const f = fixture();
  const service = new ComputerService(db, config, f.runner);
  const snapshot = await service.snapshot("owner");
  assert.equal(snapshot.commands.find((command) => command.id === id)?.status, "interrupted");
  const replay = await service.execute(
    "owner",
    { command: "echo unknown" },
    { idempotencyKey: "dead-executor" },
  );
  assert.equal(replay.status, "interrupted");
  assert.ok(!f.calls.some((call) => call.args[0] === "exec"));
  assert.equal((await service.start("owner")).status, "running");
});

test("a Stop quarantine that lands before the lease check keeps its record", async () => {
  const f = fixture();
  const service = new ComputerService(db, config, f.runner);
  const cmdId = createHash("sha256").update("computer-command:quarantine-case").digest("hex");
  const originalGet = db.get.bind(db);
  let intercepted = false;
  db.get = (async (o: string, kind: string, id: string) => {
    if (!intercepted && kind === "computer-state" && id === "lease") {
      const lease = await originalGet<{ token: string }>(o, kind, id);
      const row = await originalGet(o, "computer-commands", cmdId);
      if (lease && row) {
        intercepted = true;
        await db.compareAndSwap(
          o,
          kind,
          id,
          { token: lease.token, stopping: false },
          {
            stopping: true,
            stopInFlight: true,
            stopAttempt: "stop-attempt-1",
            stopConfirmed: false,
            expiresAt: Date.now() + 180000,
          },
        );
        await db.compareAndSwap(
          o,
          "computer-commands",
          cmdId,
          { status: "running" },
          {
            status: "interrupted",
            completedAt: new Date().toISOString(),
            stderr: "Stopped by the user. Inspect the workspace before repeating this command.",
          },
        );
      }
    }
    return originalGet(o, kind, id);
  }) as Store["get"];
  try {
    const receipt = await service.execute(
      "owner",
      { command: "sleep 30" },
      { idempotencyKey: "quarantine-case" },
    );
    assert.equal(receipt.status, "interrupted");
    assert.match(receipt.stderr, /Stopped by the user/);
    assert.ok(!f.calls.some((call) => call.args[0] === "exec"));
  } finally {
    db.get = originalGet;
    await db.remove("owner", "computer-state", "lease");
  }
});

test("a command marked dead after the lease check is never executed", async () => {
  const f = fixture({ command: async () => ok("should never run") });
  const service = new ComputerService(db, config, f.runner);
  const cmdId = createHash("sha256").update("computer-command:dead-row-case").digest("hex");
  const originalGet = db.get.bind(db);
  let intercepted = false;
  db.get = (async (o: string, kind: string, id: string) => {
    if (!intercepted && kind === "computer-state" && id === "lease") {
      const lease = await originalGet<{ token: string }>(o, kind, id);
      const row = await originalGet(o, "computer-commands", cmdId);
      if (lease && row) {
        intercepted = true;
        await db.compareAndSwap(
          o,
          "computer-commands",
          cmdId,
          { status: "running" },
          {
            status: "interrupted",
            completedAt: new Date().toISOString(),
            stderr:
              "Execution was interrupted. Its outcome is unknown; inspect files before running it again.",
          },
        );
      }
    }
    return originalGet(o, kind, id);
  }) as Store["get"];
  try {
    const receipt = await service.execute(
      "owner",
      { command: "touch /tmp/should-not-run" },
      { idempotencyKey: "dead-row-case" },
    );
    assert.equal(receipt.status, "interrupted");
    assert.equal(receipt.stdout, "");
    assert.ok(!f.calls.some((call) => call.args[0] === "exec"), "docker exec must not run");
  } finally {
    db.get = originalGet;
  }
});
