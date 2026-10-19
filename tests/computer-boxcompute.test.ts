import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ComputerService, computerIdentity } from "../apps/server/src/computer.ts";
import {
  BoxComputeApiError,
  BoxComputeComputer,
  type BoxComputeDesktopAction,
  type BoxComputeDriver,
  type BoxComputeExecution,
  type BoxComputeSandbox,
  boxcomputeDriver,
  boxcomputeInputs,
} from "../apps/server/src/computer-boxcompute.ts";
import { desktopScript } from "../apps/server/src/computer-desktop.ts";
import { computerInstructions, computerTools } from "../apps/server/src/computer-tools.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { ComputerCommand } from "../packages/domain/src/computer.ts";
import { config as base } from "./helpers/computer.ts";

const apiKey = "bc_live_test_key_never_sent";
const config: Config = {
  ...base,
  computerProvider: "boxcompute",
  boxcomputeApiKey: apiKey,
  computerDeploymentId: "boxcompute-test",
};
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const ok = (stdout = "", exitCode = 0): BoxComputeExecution => ({
  stdout,
  stderr: "",
  exitCode,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});
type Execute = Parameters<BoxComputeDriver["execute"]>;

// In-memory stand-in for BoxCompute's public API. It records every call and scripts
// outcomes; failures are the API's own error codes.
function fake(
  options: {
    vms?: Partial<BoxComputeSandbox>[];
    workspaces?: { id: string; name: string }[];
    execute?: (...args: Execute) => Promise<BoxComputeExecution> | BoxComputeExecution;
    act?: (
      action: BoxComputeDesktopAction,
      index: number,
    ) => Promise<{ screenshot?: { mimeType: string; data: string } | null }> | undefined;
    files?: Record<string, Uint8Array | "dir" | { link: true }>;
    /** Runs after every list, e.g. to land a Stop between inspect and use. */
    afterList?: () => void;
    createState?: BoxComputeSandbox["state"];
  } = {},
) {
  const vms = new Map<string, BoxComputeSandbox>();
  let next = 0;
  const calls = {
    create: [] as {
      input: { workspaceId: string; metadata: Record<string, string> };
      key: string;
    }[],
    createWorkspace: [] as { name: string; key: string }[],
    start: [] as string[],
    stop: [] as string[],
    startDesktop: [] as string[],
    execute: [] as Execute[],
    act: [] as { action: BoxComputeDesktopAction; screenshot: boolean }[],
    screenshot: 0,
    viewer: 0,
    writes: [] as string[],
    removes: [] as string[],
    reads: [] as { path: string; offset: number; maxBytes: number }[],
  };
  const add = (vm: Partial<BoxComputeSandbox>) => {
    const id = vm.id ?? `sbx_${++next}`;
    vms.set(id, {
      id,
      workspaceId: "ws_openmuse",
      name: "OpenMuse computer",
      state: "running",
      vmSandbox: true,
      blockNetwork: false,
      size: "large",
      metadata: computerIdentity(config, "owner").labels,
      ...vm,
    });
  };
  for (const vm of options.vms ?? []) add(vm);
  const workspaces = options.workspaces ?? [{ id: "ws_openmuse", name: "OpenMuse" }];
  const files = new Map(Object.entries(options.files ?? {}));
  const vm = (id: string) => {
    const found = vms.get(id);
    if (!found) throw new BoxComputeApiError(404, "NOT_FOUND", "Sandbox not found");
    return found;
  };
  // Created with autoResume false: compute and file calls refuse a stopped VM.
  const running = (id: string) => {
    if (vm(id).state !== "running")
      throw new BoxComputeApiError(409, "SANDBOX_STOPPED", "The VM is stopped");
  };
  let acts = 0;
  const driver: BoxComputeDriver = {
    async workspaces() {
      return workspaces;
    },
    async createWorkspace(name, key) {
      calls.createWorkspace.push({ name, key });
      workspaces.push({ id: "ws_created", name });
      return { id: "ws_created" };
    },
    async list(metadata) {
      const found = [...vms.values()]
        .filter((item) =>
          Object.entries(metadata).every(([key, value]) => item.metadata?.[key] === value),
        )
        .map((item) => ({ ...item }));
      options.afterList?.();
      return found;
    },
    async get(id) {
      const found = vm(id);
      if (found.state === "pending") found.state = "running"; // provisioning finishes
      return { ...found };
    },
    async create(input, key) {
      calls.create.push({ input, key });
      add({
        workspaceId: input.workspaceId,
        metadata: input.metadata,
        state: options.createState ?? "pending",
      });
      return { ...vm(`sbx_${next}`) };
    },
    async start(id) {
      calls.start.push(id);
      vm(id).state = "running";
      return { ...vm(id) };
    },
    async stop(id) {
      calls.stop.push(id);
      vm(id).state = "cold";
    },
    async startDesktop(id) {
      calls.startDesktop.push(id);
    },
    async execute(...args) {
      running(args[0]);
      calls.execute.push(args);
      return options.execute ? options.execute(...args) : ok();
    },
    async stat(id, path) {
      running(id);
      const file = files.get(path);
      if (file === undefined) return null;
      if (file === "dir") return { kind: "dir", isSymbolicLink: false, size: 0 };
      if (!(file instanceof Uint8Array)) return { kind: "file", isSymbolicLink: true, size: 1 };
      return { kind: "file", isSymbolicLink: false, size: file.length };
    },
    async listFiles(id, path, cursor) {
      running(id);
      const entries = [...files.entries()]
        .filter(
          ([name]) => name.startsWith(`${path}/`) && !name.slice(path.length + 1).includes("/"),
        )
        .map(([name, file]) => ({
          name: name.slice(path.length + 1),
          path: name,
          kind:
            file === "dir"
              ? ("dir" as const)
              : file instanceof Uint8Array
                ? ("file" as const)
                : ("symlink" as const),
          size: file instanceof Uint8Array ? file.length : 0,
        }));
      // Two pages, so the provider must follow the cursor.
      const half = Math.ceil(entries.length / 2);
      return cursor
        ? { entries: entries.slice(half), nextCursor: null }
        : { entries: entries.slice(0, half), nextCursor: entries.length > 1 ? "next" : null };
    },
    async readFile(id, path, offset, maxBytes) {
      running(id);
      calls.reads.push({ path, offset, maxBytes });
      const file = files.get(path);
      if (!(file instanceof Uint8Array))
        throw new BoxComputeApiError(404, "FILE_NOT_FOUND", "File not found");
      return file.subarray(offset, offset + maxBytes);
    },
    async writeFile(id, path, bytes) {
      running(id);
      calls.writes.push(path);
      files.set(path, Uint8Array.from(bytes));
    },
    async makeDirectory(_id, path) {
      files.set(path, "dir");
    },
    async removeFile(_id, path) {
      calls.removes.push(path);
      files.delete(path);
    },
    async act(id, action, screenshot) {
      if (vm(id).state !== "running")
        throw new BoxComputeApiError(409, "DESKTOP_UNAVAILABLE", "The VM is not running.");
      calls.act.push({ action, screenshot });
      const scripted = await options.act?.(action, acts++);
      if (scripted) return scripted;
      return screenshot
        ? { screenshot: { mimeType: "image/jpeg", data: Buffer.from(jpeg).toString("base64") } }
        : {};
    },
    async screenshot(id) {
      if (vm(id).state !== "running")
        throw new BoxComputeApiError(409, "DESKTOP_UNAVAILABLE", "The VM is not running.");
      calls.screenshot++;
      return jpeg;
    },
    async viewer(id) {
      vm(id);
      calls.viewer++;
      return "https://0123456789abcdef0123456789abcdef.bxcpreview.site";
    },
  };
  /** The VM a test seeded or created; fails the test when it is missing. */
  const only = (id = "sbx_1") => {
    const found = vms.get(id);
    assert.ok(found, `no VM ${id}`);
    return found;
  };
  return { driver, calls, vms, files, only };
}

let db: Store;
let owners = 0;
before(async () => {
  config.dataDir = await mkdtemp(join(tmpdir(), "openmuse-boxcompute-test-"));
  db = await createStore();
});
after(async () => {
  await db.close();
  await rm(config.dataDir, { recursive: true, force: true });
});
// Each test gets a fresh owner so leases and receipts never leak between tests.
function service(f: ReturnType<typeof fake>, overrides: Partial<Config> = {}) {
  const owner = `owner-${++owners}`;
  const settings = { ...config, ...overrides };
  const labels = computerIdentity(settings, owner).labels;
  for (const vm of f.vms.values())
    if (
      vm.metadata?.["dev.openmuse.owner"] ===
      computerIdentity(config, "owner").labels["dev.openmuse.owner"]
    )
      vm.metadata = { ...vm.metadata, ...labels };
  const vm = new BoxComputeComputer(settings, f.driver);
  return { owner, labels, vm, computer: new ComputerService(db, settings, undefined, vm) };
}
const useDesktop = (computer: ComputerService, owner: string) => {
  const tool = computerTools(
    computer,
    {} as Parameters<typeof computerTools>[1],
    owner,
    "scope",
  ).find((candidate) => candidate.name === "use_desktop");
  return tool?.execute as (
    args: unknown,
  ) => Promise<{ type: string; content?: string; source?: { value: string } }[]>;
};

test("start creates one large open-network VM per owner, waits for it and starts its desktop", async () => {
  const f = fake();
  const { computer, owner, labels } = service(f);
  const before = await computer.snapshot(owner);
  assert.deepEqual(
    [before.status, before.provider, before.network, before.desktop],
    ["stopped", "boxcompute", "enabled", true],
  );
  const started = await computer.start(owner);
  assert.equal(started.status, "running");
  assert.equal(f.calls.create.length, 1);
  assert.deepEqual(f.calls.create[0].input.metadata, labels);
  assert.equal(f.calls.create[0].input.workspaceId, "ws_openmuse");
  assert.match(f.calls.create[0].key, /^openmuse-computer-[0-9a-f-]{36}$/);
  assert.deepEqual(f.calls.startDesktop, ["sbx_1"]);
  await computer.start(owner);
  assert.equal(f.calls.create.length, 1, "a second start reuses the VM");
});

test("new VMs go to the configured workspace, or one named OpenMuse that is created once", async () => {
  const configured = fake({ workspaces: [] });
  const mine = service(configured, { boxcomputeWorkspaceId: "ws_mine" });
  await mine.computer.start(mine.owner);
  assert.equal(configured.calls.create[0].input.workspaceId, "ws_mine");
  const created = fake({ workspaces: [] });
  const one = service(created);
  await one.computer.start(one.owner);
  const two = service(created);
  await two.computer.start(two.owner);
  assert.equal(created.calls.createWorkspace.length, 1);
  assert.match(created.calls.createWorkspace[0].key, /^openmuse-workspace-[0-9a-f]{16}$/);
  const ambiguous = fake({
    workspaces: [
      { id: "a", name: "OpenMuse" },
      { id: "b", name: "OpenMuse" },
    ],
  });
  const three = service(ambiguous);
  await assert.rejects(three.computer.start(three.owner), /BOXCOMPUTE_WORKSPACE_ID/);
});

test("a stopped VM reports stopped and start resumes it without creating another", async () => {
  const f = fake({ vms: [{ state: "cold" }] });
  const { computer, owner } = service(f);
  assert.equal((await computer.snapshot(owner)).status, "stopped");
  assert.equal((await computer.start(owner)).status, "running");
  assert.deepEqual([f.calls.create.length, f.calls.start], [0, ["sbx_1"]]);
  assert.deepEqual(f.calls.startDesktop, ["sbx_1"], "a cold resume restores the desktop");
});

test("stop stops only a running VM and never starts one", async () => {
  const f = fake({ vms: [{ state: "cold" }] });
  const { computer, owner } = service(f);
  await computer.stop(owner);
  assert.deepEqual([f.calls.stop, f.calls.start], [[], []]);
  f.only().state = "running";
  await computer.stop(owner);
  assert.deepEqual(f.calls.stop, ["sbx_1"]);
});

test("attaching fails closed on duplicates, foreign metadata, and VMs that cannot run the desktop", async () => {
  const labels = computerIdentity(config, "owner").labels;
  for (const vms of [
    [{}, {}],
    [{ metadata: { ...labels, extra: "x" } }],
    [{ size: "small" as const }],
    [{ blockNetwork: true }],
    [{ vmSandbox: false }],
    [{ state: "expired" as const }],
  ]) {
    const f = fake({ vms });
    const { computer, owner } = service(f);
    const snapshot = await computer.snapshot(owner);
    assert.equal(snapshot.status, "error", JSON.stringify(vms));
    assert.match(snapshot.message ?? "", /refusing to attach/);
    await assert.rejects(computer.start(owner), /refusing to attach/);
    assert.equal(f.calls.create.length + f.calls.start.length, 0);
  }
  const wrongWorkspace = fake({ vms: [{ workspaceId: "ws_other" }] });
  const pinned = service(wrongWorkspace, { boxcomputeWorkspaceId: "ws_mine" });
  assert.equal((await pinned.computer.snapshot(pinned.owner)).status, "error");
});

test("commands carry the command in the environment, under the 30 second wrapper", async () => {
  const f = fake({ vms: [{}], execute: () => ok("hello\n") });
  const { computer, owner } = service(f);
  const command = `echo ${"x".repeat(12000)}`;
  const receipt = await computer.execute(owner, { command, cwd: "/workspace/project" });
  assert.equal(receipt.status, "succeeded");
  const [id, request] = f.calls.execute[0];
  assert.equal(id, "sbx_1");
  assert.deepEqual(request.argv.slice(0, 4), ["/bin/bash", "--noprofile", "--norc", "-c"]);
  assert.ok(
    !request.argv.some((arg) => arg.includes(command)),
    "the command never travels in argv",
  );
  assert.ok(
    request.argv.every((arg) => arg.length <= 8192),
    "BoxCompute caps one argument at 8 KB",
  );
  assert.equal(request.env.OPENMUSE_COMMAND, command);
  assert.equal(request.cwd, "/workspace/project");
  assert.equal(request.timeoutSeconds, 35);
  assert.ok(request.maxOutputBytes <= 1024 * 1024);
});

test("the in-box wrapper reads the command from the environment and does not wait for GUI apps", {
  skip: process.platform === "win32",
}, () => {
  const script = desktopScript('"$OPENMUSE_COMMAND"');
  const run = (command: string) =>
    spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", script, "openmuse"], {
      env: { PATH: process.env.PATH, OPENMUSE_COMMAND: command },
      encoding: "utf8",
      timeout: 10_000,
    });
  const quoted = run(`printf '%s|' "it's" '$HOME' "a b"; exit 3`);
  assert.equal(quoted.stdout, "it's|$HOME|a b|");
  assert.equal(quoted.status, 3);
  const started = Date.now();
  const background = run("sleep 20 >/dev/null 2>&1 & echo started");
  assert.equal(background.stdout, "started\n");
  assert.ok(Date.now() - started < 5000, "a backgrounded app must not hold the command open");
});

test("exit 124 is timed_out and leaves the VM running; an API deadline or lost call stops it", async () => {
  const inBox = fake({ vms: [{}], execute: () => ok("", 124) });
  const one = service(inBox);
  assert.equal(
    (await one.computer.execute(one.owner, { command: "sleep 40", cwd: "/workspace" })).status,
    "timed_out",
  );
  assert.deepEqual(inBox.calls.stop, []);
  for (const error of [
    new BoxComputeApiError(408, "EXECUTION_TIMEOUT", "Execution timed out"),
    new TypeError("fetch failed"),
  ]) {
    const f = fake({ vms: [{}], execute: () => Promise.reject(error) });
    const { computer, owner } = service(f);
    const receipt = await computer.execute(owner, { command: "true", cwd: "/workspace" });
    assert.equal(receipt.status, error instanceof BoxComputeApiError ? "timed_out" : "interrupted");
    assert.deepEqual(f.calls.stop, ["sbx_1"], "an unknown command must not outlive the lease");
  }
});

test("a missing working directory fails the command without stopping the computer", async () => {
  const f = fake({
    vms: [{}],
    execute: () => Promise.reject(new BoxComputeApiError(400, "INVALID_PATH", "No such directory")),
  });
  const { computer, owner } = service(f);
  const receipt = await computer.execute(owner, { command: "pwd", cwd: "/workspace/missing" });
  assert.deepEqual([receipt.status, receipt.exitCode], ["failed", 126]);
  assert.deepEqual(f.calls.stop, []);
});

test("output is capped like Docker", async () => {
  const f = fake({ vms: [{}], execute: () => ok("x".repeat(300 * 1024)) });
  const { computer, owner } = service(f);
  const receipt = await computer.execute(owner, { command: "yes", cwd: "/workspace" });
  assert.ok(receipt.truncated);
  assert.ok(Buffer.byteLength(receipt.stdout) <= 128 * 1024);
});

test("a Stop between inspection and use fails the operation instead of waking the VM", async () => {
  // The inspection still sees the VM running; it stops before the call reaches it.
  const f = fake({ vms: [{}], afterList: () => (f.only().state = "cold") });
  const { computer, owner } = service(f);
  await assert.rejects(computer.list(owner), /Start the computer/);
  f.only().state = "running";
  const receipt = await computer.execute(owner, { command: "true", cwd: "/workspace" });
  assert.equal(receipt.status, "failed");
  assert.match(receipt.stderr, /Start the computer/);
  assert.deepEqual([f.calls.start, f.calls.stop, f.calls.execute.length], [[], [], 0]);
});

test("files use BoxCompute's file API with files.py's limits, symlink refusals and response shape", async () => {
  const f = fake({
    vms: [{}],
    files: {
      "/workspace/b.txt": Buffer.from("héllo"),
      "/workspace/a": "dir",
      "/workspace/link": { link: true },
      "/workspace/big.txt": new Uint8Array(256 * 1024 + 1),
      "/workspace/bad.txt": Uint8Array.from([0xff, 0xfe]),
    },
  });
  const { computer, owner } = service(f);
  const listing = await computer.list(owner, "/workspace");
  // files.py's order: directories first, then code-point order.
  assert.deepEqual(
    listing.entries.map((entry) => [entry.name, entry.type]),
    [
      ["a", "directory"],
      ["b.txt", "file"],
      ["bad.txt", "file"],
      ["big.txt", "file"],
      ["link", "symlink"],
    ],
  );
  assert.deepEqual(await computer.read(owner, "/workspace/b.txt"), {
    path: "/workspace/b.txt",
    text: "héllo",
  });
  for (const path of [
    "/workspace/link",
    "/workspace/big.txt",
    "/workspace/bad.txt",
    "/workspace/none",
  ])
    await assert.rejects(computer.read(owner, path), /symlinks cannot be opened/);
  await computer.write(owner, "/workspace/new.txt", "ünïcode");
  assert.equal(Buffer.from(f.files.get("/workspace/new.txt") as Uint8Array).toString(), "ünïcode");
  await assert.rejects(computer.write(owner, "/workspace/link", "x"), /symlinks cannot be opened/);
  await computer.mkdir(owner, "/workspace/deep/er");
  assert.equal(f.files.get("/workspace/deep/er"), "dir");
});

test("PDFs above one request's limit are read in ranges and written in parts joined in place", async () => {
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(9 * 1024 * 1024, 7)]);
  const f = fake({
    vms: [{}],
    files: { "/workspace/in.pdf": pdf },
    execute: (_id, request) => {
      const [, , , , out, ...parts] = request.argv;
      f.files.set(out, Buffer.concat(parts.map((part) => f.files.get(part) as Uint8Array)));
      return ok();
    },
  });
  const { computer, owner } = service(f);
  const read = await computer.pdfBytes(owner, "/workspace/in.pdf");
  assert.ok(read.bytes.equals(pdf));
  assert.deepEqual(
    f.calls.reads.map((r) => r.offset),
    [0, 8 * 1024 * 1024],
  );
  await computer.writePdf(owner, "/workspace/out.pdf", pdf);
  assert.ok(Buffer.from(f.files.get("/workspace/out.pdf") as Uint8Array).equals(pdf));
  assert.equal(f.calls.writes.filter((path) => path.includes(".openmuse-")).length, 2);
  assert.deepEqual(f.calls.removes.length, 2, "the parts are removed");
  assert.ok(![...f.files.keys()].some((path) => path.includes(".openmuse-")));
});

test("provider failures surface as the app's own errors, and an empty wallet as 402", async () => {
  const outage = fake({ vms: [{}] });
  outage.driver.list = async () => {
    throw new BoxComputeApiError(502, "SERVICE_UNAVAILABLE", "upstream");
  };
  const one = service(outage);
  const snapshot = await one.computer.snapshot(one.owner);
  assert.equal(snapshot.status, "error");
  assert.match(snapshot.message ?? "", /BOXCOMPUTE_API_KEY/);
  assert.doesNotMatch(snapshot.message ?? "", /upstream/);
  const broke = fake({ vms: [{ state: "cold" }] });
  broke.driver.start = async () => {
    throw new BoxComputeApiError(402, "INSUFFICIENT_CREDIT", "No credit");
  };
  const two = service(broke);
  await assert.rejects(two.computer.start(two.owner), /no compute credit/);
});

test("the desktop URL is the VM's viewer link and needs a running computer", async () => {
  const f = fake({ vms: [{}] });
  const { computer, owner } = service(f);
  const { url } = await computer.desktopUrl(owner);
  assert.match(url, /^https:\/\/[0-9a-f]{32}\.bxcpreview\.site$/);
  assert.ok(!url.includes(apiKey));
  f.only().state = "cold";
  await assert.rejects(computer.desktopUrl(owner), /Start the computer/);
});

test("agent actions map onto BoxCompute input, refusing what it cannot type before anything is sent", () => {
  assert.deepEqual(boxcomputeInputs({ action: "double_click", coordinate: [3, 4] }), [
    { type: "click", x: 3, y: 4, button: "left", clicks: 2 },
  ]);
  assert.deepEqual(boxcomputeInputs({ action: "right_click" }), [
    { type: "click", button: "right", clicks: 1 },
  ]);
  assert.deepEqual(
    boxcomputeInputs({ action: "key", text: "ctrl+l  Return super+shift+F5 KP_Enter" }),
    [
      { type: "key", key: "l", modifiers: ["ctrl"] },
      { type: "key", key: "Return", modifiers: [] },
      { type: "key", key: "F5", modifiers: ["super", "shift"] },
      { type: "key", key: "Return", modifiers: [] },
    ],
  );
  assert.deepEqual(boxcomputeInputs({ action: "key", text: "ctrl+minus" }), [
    { type: "key", key: "-", modifiers: ["ctrl"] },
  ]);
  assert.deepEqual(
    boxcomputeInputs({ action: "scroll", scroll_direction: "up", scroll_amount: 15 }),
    [{ type: "scroll", direction: "up", amount: 15 }],
  );
  for (const action of [
    { action: "type" as const, text: "naïve" },
    { action: "key" as const, text: "hyper+a" },
    { action: "key" as const, text: "ctrl+ctrl+a" },
    { action: "key" as const, text: "XF86AudioPlay" },
  ])
    assert.throws(
      () => boxcomputeInputs(action),
      (error: { status?: number }) => error.status === 422,
    );
});

test("use_desktop sends one action with its screenshot in the same call and keeps a receipt", async () => {
  const f = fake({ vms: [{}] });
  const { computer, owner } = service(f);
  assert.ok(
    computerTools(computer, {} as never, owner, "scope").some(
      (tool) => tool.name === "use_desktop",
    ),
  );
  const result = await useDesktop(
    computer,
    owner,
  )({ action: "left_click", coordinate: [640, 400], operationId: "click-1" });
  const text = JSON.parse(result[0].content ?? "{}");
  assert.equal(text.status, "succeeded");
  assert.deepEqual(f.calls.act, [
    { action: { type: "click", x: 640, y: 400, button: "left", clicks: 1 }, screenshot: true },
  ]);
  assert.equal(f.calls.screenshot, 0, "the action's own response carried the frame");
  assert.equal(result[1].source?.value, Buffer.from(jpeg).toString("base64"));
  const multi = await useDesktop(
    computer,
    owner,
  )({ action: "key", text: "ctrl+l Return", operationId: "keys-1" });
  assert.equal(JSON.parse(multi[0].content ?? "{}").status, "succeeded");
  assert.deepEqual(
    f.calls.act.slice(1).map((call) => call.screenshot),
    [false, true],
  );
});

test("a screenshot or wait reads the screen without sending input", async () => {
  const f = fake({ vms: [{}] });
  const { computer, owner } = service(f);
  await useDesktop(computer, owner)({ action: "screenshot", operationId: "look" });
  await useDesktop(computer, owner)({ action: "wait", duration: 0.1, operationId: "wait" });
  assert.deepEqual([f.calls.act.length, f.calls.screenshot], [0, 2]);
});

test("a refused first input sent nothing; a lost or uncertain one is never replayed", async () => {
  const refused = fake({
    vms: [{}],
    act: () => Promise.reject(new BoxComputeApiError(409, "DESKTOP_BUSY", "busy")),
  });
  const one = service(refused);
  const refusal = (await useDesktop(
    one.computer,
    one.owner,
  )({ action: "left_click", operationId: "r" })) as unknown as { error?: string };
  assert.match(refusal.error ?? "", /busy/);
  const [failed] = await db.list<ComputerCommand>(one.owner, "computer-desktop-actions");
  assert.equal(failed.status, "failed");
  for (const error of [
    new BoxComputeApiError(502, "DESKTOP_INPUT_UNCERTAIN", "may have run"),
    new TypeError("fetch failed"),
  ]) {
    const f = fake({ vms: [{}], act: () => Promise.reject(error) });
    const { computer, owner } = service(f);
    const execute = useDesktop(computer, owner);
    const first = JSON.parse(
      (await execute({ action: "type", text: "hello", operationId: "u" }))[0].content ?? "{}",
    );
    assert.equal(first.status, "interrupted");
    assert.match(first.warning, /outcome is unknown.*before repeating.*do not automatically retry/);
    const again = JSON.parse(
      (await execute({ action: "type", text: "hello", operationId: "u" }))[0].content ?? "{}",
    );
    assert.equal(again.receiptId, first.receiptId);
    assert.equal(f.calls.act.length, 1, "uncertain input is never sent again");
    assert.equal(f.calls.screenshot, 1, "a fresh screenshot follows uncertain input");
  }
  const partial = fake({
    vms: [{}],
    act: (_action, index) =>
      index === 1 ? Promise.reject(new BoxComputeApiError(409, "DESKTOP_BUSY", "busy")) : undefined,
  });
  const three = service(partial);
  const result = JSON.parse(
    (
      await useDesktop(
        three.computer,
        three.owner,
      )({ action: "key", text: "ctrl+l Return", operationId: "p" })
    )[0].content ?? "{}",
  );
  assert.equal(result.status, "interrupted", "a later refusal follows input that already ran");
});

test("delivered input remains succeeded when its screenshot is missing", async () => {
  const f = fake({ vms: [{}], act: () => Promise.resolve({ screenshot: null }) });
  const { computer, owner } = service(f);
  const text = JSON.parse(
    (await useDesktop(computer, owner)({ action: "left_click", operationId: "s" }))[0].content ??
      "{}",
  );
  assert.equal(text.status, "succeeded");
  assert.match(text.warning, /screenshot could not be taken/);
});

test("a stopped VM is never resumed by a desktop action", async () => {
  const f = fake({ vms: [{ state: "cold" }] });
  const { computer, owner } = service(f);
  const result = (await useDesktop(
    computer,
    owner,
  )({ action: "left_click", operationId: "x" })) as unknown as { error?: string };
  assert.match(result.error ?? "", /Start the computer/);
  assert.deepEqual([f.calls.start, f.calls.act], [[], []]);
});

test("agent instructions describe the BoxCompute desktop and stay free of the host's name", () => {
  const text = computerInstructions("boxcompute");
  assert.match(text, /use_desktop/);
  assert.match(text, /chrome https:\/\/example\.com/);
  assert.match(text, /US-ASCII/);
  assert.doesNotMatch(text, /BoxCompute|Xfce|firefox|publicly reachable/i);
});

test("the HTTP client sends the key only in its header and names its failures", async () => {
  const requests: { url: URL; init: RequestInit }[] = [];
  const responses = [
    Response.json({ sandboxes: [] }),
    Response.json(
      { code: "INSUFFICIENT_SCOPE", error: "API key lacks sandbox:create" },
      { status: 403 },
    ),
  ];
  const driver = boxcomputeDriver(
    { ...config, boxcomputeApiUrl: "https://api.example.test/" },
    (async (url: URL, init: RequestInit) => {
      requests.push({ url, init });
      return responses.shift() as Response;
    }) as unknown as typeof fetch,
  );
  await driver.list({ "dev.openmuse.owner": "abc", "dev.openmuse.managed": "computer-v1" });
  assert.equal(
    requests[0].url.origin + requests[0].url.pathname,
    "https://api.example.test/api/v2/sandboxes",
  );
  assert.deepEqual(requests[0].url.searchParams.getAll("metadata"), [
    "dev.openmuse.owner=abc",
    "dev.openmuse.managed=computer-v1",
  ]);
  assert.equal(
    (requests[0].init.headers as Record<string, string>).authorization,
    `Bearer ${apiKey}`,
  );
  assert.ok(!requests[0].url.href.includes(apiKey));
  assert.equal(requests[0].init.redirect, "error");
  await assert.rejects(
    driver.create({ workspaceId: "ws", name: "n", metadata: {} }, "key-1"),
    (error: BoxComputeApiError) => error.status === 403 && error.code === "INSUFFICIENT_SCOPE",
  );
  assert.equal((requests[1].init.headers as Record<string, string>)["idempotency-key"], "key-1");
  assert.deepEqual(JSON.parse(String(requests[1].init.body)), {
    workspaceId: "ws",
    name: "n",
    metadata: {},
    vmSandbox: true,
    size: "large",
    blockNetwork: false,
    autoResume: false,
  });
});

test("BoxCompute receipts are kept apart from Docker and E2B receipts", async () => {
  const f = fake({ vms: [{}] });
  const { computer, owner } = service(f);
  await computer.execute(owner, { command: "true", cwd: "/workspace" });
  assert.equal((await db.list<ComputerCommand>(owner, "computer-boxcompute-commands")).length, 1);
  assert.equal((await db.list<ComputerCommand>(owner, "computer-commands")).length, 0);
  assert.equal((await db.list<ComputerCommand>(owner, "computer-desktop-commands")).length, 0);
});
