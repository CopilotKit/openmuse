import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type ComputerState,
  computerOutput,
  computerOutputLimit,
  type DockerResult,
} from "./computer.ts";
import {
  type ComputerDesktop,
  type DesktopAction,
  type DesktopShot,
  desktopScript,
  resolution,
} from "./computer-desktop.ts";
import type { Config } from "./config.ts";
import { AppError } from "./errors.ts";

// Runs each owner's computer on one BoxCompute VM (https://boxcompute.ai), matched
// by metadata like the E2B provider. Stopping the VM ends every process and keeps
// its disk, /workspace included. Every call goes through BoxCompute's public API
// with a server-side key; nothing in the VM can reach that key.

const controlMs = 15_000;
// A new VM is usually running in about half a minute; a cold image can take longer.
const createMs = 240_000;
const pollMs = 2_000;
const desktopMs = 60_000;
// The in-box wrapper stops a command at 30 seconds; the API call waits a little longer.
const commandSeconds = 35;
const fileLimit = 256 * 1024;
const pdfLimit = 10 * 1024 * 1024;
// BoxCompute's per-request file body limit; larger PDFs are written in parts.
const fileChunk = 8 * 1024 * 1024;
const listLimit = 1000;
const workspaceName = "OpenMuse";
const vmName = "OpenMuse computer";
const settleMs = 500;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export class BoxComputeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface BoxComputeSandbox {
  id: string;
  workspaceId: string;
  name: string;
  state: "cold" | "pending" | "running" | "expired";
  vmSandbox: boolean;
  blockNetwork?: boolean;
  size?: "small" | "large";
  metadata?: Record<string, string>;
}
export interface BoxComputeExecution {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}
export type BoxComputeDesktopAction =
  | { type: "click"; x?: number; y?: number; button: "left" | "middle" | "right"; clicks: 1 | 2 }
  | { type: "move"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string; modifiers: Array<"ctrl" | "alt" | "shift" | "super"> }
  | {
      type: "scroll";
      direction: "up" | "down" | "left" | "right";
      amount: number;
      x?: number;
      y?: number;
    };
export interface BoxComputeFileEntry {
  name: string;
  path: string;
  kind: "file" | "dir" | "symlink" | "other";
  size: number;
}

/** The slice of BoxCompute's public API this provider uses; tests replace it with a fake. */
export interface BoxComputeDriver {
  workspaces(): Promise<{ id: string; name: string }[]>;
  createWorkspace(name: string, idempotencyKey: string): Promise<{ id: string }>;
  list(metadata: Record<string, string>): Promise<BoxComputeSandbox[]>;
  get(id: string): Promise<BoxComputeSandbox>;
  create(
    input: { workspaceId: string; name: string; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<BoxComputeSandbox>;
  start(id: string): Promise<BoxComputeSandbox>;
  stop(id: string): Promise<void>;
  startDesktop(id: string): Promise<void>;
  execute(
    id: string,
    request: {
      argv: string[];
      cwd: string;
      env: Record<string, string>;
      timeoutSeconds: number;
      maxOutputBytes: number;
    },
    signal?: AbortSignal,
  ): Promise<BoxComputeExecution>;
  stat(
    id: string,
    path: string,
  ): Promise<{ kind: string; isSymbolicLink: boolean; size: number } | null>;
  listFiles(
    id: string,
    path: string,
    cursor?: string,
  ): Promise<{ entries: BoxComputeFileEntry[]; nextCursor: string | null }>;
  readFile(id: string, path: string, offset: number, maxBytes: number): Promise<Uint8Array>;
  writeFile(id: string, path: string, bytes: Uint8Array): Promise<void>;
  makeDirectory(id: string, path: string): Promise<void>;
  removeFile(id: string, path: string): Promise<void>;
  act(
    id: string,
    action: BoxComputeDesktopAction,
    screenshot: boolean,
  ): Promise<{ screenshot?: { mimeType: string; data: string } | null }>;
  screenshot(id: string): Promise<Uint8Array>;
  viewer(id: string): Promise<string>;
}

/** The HTTP client. `fetcher` is injected so tests never reach the network. */
export function boxcomputeDriver(config: Config, fetcher: typeof fetch = fetch): BoxComputeDriver {
  const base = `${(config.boxcomputeApiUrl ?? "https://api.boxcompute.ai").replace(/\/+$/, "")}/api/v2`;
  const call = async (
    method: string,
    path: string,
    options: {
      query?: Record<string, string | number | string[] | undefined>;
      json?: unknown;
      bytes?: Uint8Array;
      idempotencyKey?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ) => {
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(options.query ?? {}))
      for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value])
        url.searchParams.append(key, String(item));
    const headers: Record<string, string> = { authorization: `Bearer ${config.boxcomputeApiKey}` };
    if (options.json !== undefined) headers["content-type"] = "application/json";
    if (options.bytes) headers["content-type"] = "application/octet-stream";
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? controlMs);
    const response = await fetcher(url, {
      method,
      headers,
      body:
        options.json !== undefined
          ? JSON.stringify(options.json)
          : (options.bytes as BodyInit | undefined),
      signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
      redirect: "error",
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        code?: unknown;
        error?: unknown;
      } | null;
      throw new BoxComputeApiError(
        response.status,
        typeof body?.code === "string" ? body.code : `HTTP_${response.status}`,
        typeof body?.error === "string" ? body.error : `BoxCompute answered ${response.status}`,
      );
    }
    return response;
  };
  const json = async <T>(response: Response) => (await response.json()) as T;
  const sandbox = (id: string) => `/sandboxes/${encodeURIComponent(id)}`;
  return {
    async workspaces() {
      return (
        await json<{ workspaces: { id: string; name: string }[] }>(await call("GET", "/workspaces"))
      ).workspaces;
    },
    async createWorkspace(name, idempotencyKey) {
      const response = await call("POST", "/workspaces", { json: { name }, idempotencyKey });
      return (await json<{ workspace: { id: string } }>(response)).workspace;
    },
    async list(metadata) {
      const query = { metadata: Object.entries(metadata).map(([key, value]) => `${key}=${value}`) };
      return (
        await json<{ sandboxes: BoxComputeSandbox[] }>(await call("GET", "/sandboxes", { query }))
      ).sandboxes;
    },
    async get(id) {
      return (await json<{ sandbox: BoxComputeSandbox }>(await call("GET", sandbox(id)))).sandbox;
    },
    async create(input, idempotencyKey) {
      const response = await call("POST", "/sandboxes", {
        // autoResume false: a command or file call on a stopped VM fails instead of waking it.
        json: { ...input, vmSandbox: true, size: "large", blockNetwork: false, autoResume: false },
        idempotencyKey,
        timeoutMs: 60_000,
      });
      return (await json<{ sandbox: BoxComputeSandbox }>(response)).sandbox;
    },
    async start(id) {
      const response = await call("POST", `${sandbox(id)}/start`, { json: {}, timeoutMs: 60_000 });
      return (await json<{ sandbox: BoxComputeSandbox }>(response)).sandbox;
    },
    async stop(id) {
      await call("POST", `${sandbox(id)}/stop`, { json: {}, timeoutMs: 60_000 });
    },
    async startDesktop(id) {
      await call("POST", `${sandbox(id)}/desktop/start`, { json: {}, timeoutMs: desktopMs });
    },
    async execute(id, request, signal) {
      const response = await call("POST", `${sandbox(id)}/execute`, {
        json: request,
        timeoutMs: (request.timeoutSeconds + 15) * 1000,
        signal,
      });
      return json<BoxComputeExecution>(response);
    },
    async stat(id, path) {
      try {
        const response = await call("GET", `${sandbox(id)}/files/stat`, { query: { path } });
        return (
          await json<{ file: { kind: string; isSymbolicLink: boolean; size: number } }>(response)
        ).file;
      } catch (error) {
        if (error instanceof BoxComputeApiError && error.code === "FILE_NOT_FOUND") return null;
        throw error;
      }
    },
    async listFiles(id, path, cursor) {
      const response = await call("GET", `${sandbox(id)}/files/list`, {
        query: { path, pageSize: listLimit, cursor },
      });
      return json<{ entries: BoxComputeFileEntry[]; nextCursor: string | null }>(response);
    },
    async readFile(id, path, offset, maxBytes) {
      const response = await call("GET", `${sandbox(id)}/files/content`, {
        query: { path, offset, maxBytes },
        timeoutMs: 60_000,
      });
      return new Uint8Array(await response.arrayBuffer());
    },
    async writeFile(id, path, bytes) {
      await call("PUT", `${sandbox(id)}/files/content`, {
        query: { path },
        bytes,
        timeoutMs: 60_000,
      });
    },
    async makeDirectory(id, path) {
      await call("POST", `${sandbox(id)}/files/directory`, {
        query: { path },
        json: { recursive: true },
      });
    },
    async removeFile(id, path) {
      await call("DELETE", `${sandbox(id)}/files`, { query: { path, force: "true" } });
    },
    async act(id, action, screenshot) {
      const response = await call("POST", `${sandbox(id)}/desktop/actions`, {
        json: { action, ...(screenshot ? { screenshot: "jpeg", settleMs } : {}) },
        timeoutMs: 60_000,
      });
      return json<{ screenshot?: { mimeType: string; data: string } | null }>(response);
    },
    async screenshot(id) {
      const response = await call("GET", `${sandbox(id)}/desktop/screenshot`, {
        query: { format: "jpeg" },
        timeoutMs: 60_000,
      });
      return new Uint8Array(await response.arrayBuffer());
    },
    async viewer(id) {
      const response = await call("POST", `${sandbox(id)}/desktop/viewer`, { json: {} });
      return (await json<{ viewer: { url: string } }>(response)).viewer.url;
    },
  };
}

// xdotool key names the agent is taught, mapped to BoxCompute's names.
const modifierNames: Record<string, "ctrl" | "alt" | "shift" | "super"> = {
  ctrl: "ctrl",
  control: "ctrl",
  control_l: "ctrl",
  control_r: "ctrl",
  alt: "alt",
  alt_l: "alt",
  alt_r: "alt",
  meta: "super",
  shift: "shift",
  shift_l: "shift",
  shift_r: "shift",
  super: "super",
  super_l: "super",
  super_r: "super",
  win: "super",
  cmd: "super",
};
const keyNames: Record<string, string> = {
  return: "Return",
  enter: "Return",
  kp_enter: "Return",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  page_up: "Page_Up",
  pageup: "Page_Up",
  prior: "Page_Up",
  page_down: "Page_Down",
  pagedown: "Page_Down",
  next: "Page_Down",
  left: "Left",
  right: "Right",
  up: "Up",
  down: "Down",
  space: " ",
  minus: "-",
  plus: "+",
  equal: "=",
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  semicolon: ";",
  apostrophe: "'",
  grave: "`",
  bracketleft: "[",
  bracketright: "]",
};
const unsupported = (message: string) => new AppError(message, 422);

/** One xdotool-style combo such as `ctrl+shift+t`, or a key such as `Return`. */
function keyAction(combo: string): BoxComputeDesktopAction {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  const modifiers = parts.map((part) => {
    const modifier = modifierNames[part.toLowerCase()];
    if (!modifier) throw unsupported(`The desktop has no modifier key ${part}`);
    return modifier;
  });
  if (new Set(modifiers).size !== modifiers.length)
    throw unsupported(`Repeated modifier in ${combo}`);
  const function_key = /^F([1-9]|1[0-2])$/i.exec(key);
  const name = function_key ? `F${function_key[1]}` : (keyNames[key.toLowerCase()] ?? key);
  const valid =
    /^(Return|Tab|Escape|BackSpace|Delete|Insert|Home|End|Page_Up|Page_Down|Left|Right|Up|Down|F([1-9]|1[0-2]))$/.test(
      name,
    );
  if (!valid && !/^[\x21-\x7e]$/.test(name) && name !== " ")
    throw unsupported(`The desktop has no key named ${key}`);
  return { type: "key", key: name === " " ? "space" : name, modifiers };
}

/** The BoxCompute inputs for one agent action, all validated before any is sent. */
export function boxcomputeInputs(action: DesktopAction): BoxComputeDesktopAction[] {
  const at = action.coordinate ? { x: action.coordinate[0], y: action.coordinate[1] } : {};
  switch (action.action) {
    case "screenshot":
    case "wait":
      return [];
    case "left_click":
      return [{ type: "click", ...at, button: "left", clicks: 1 }];
    case "double_click":
      return [{ type: "click", ...at, button: "left", clicks: 2 }];
    case "right_click":
      return [{ type: "click", ...at, button: "right", clicks: 1 }];
    case "mouse_move":
      return [{ type: "move", x: at.x ?? 0, y: at.y ?? 0 }];
    case "type":
      // The VM's virtual keyboard is US ASCII; refuse the whole text rather than type part of it.
      if (!/^[\x20-\x7e\n\t]+$/.test(action.text ?? ""))
        throw unsupported(
          "The BoxCompute desktop types US-ASCII text only. Write other text to a file with a command instead.",
        );
      return [{ type: "type", text: action.text ?? "" }];
    case "key":
      return (action.text ?? "").trim().split(/\s+/).map(keyAction);
    case "scroll":
      return [
        {
          type: "scroll",
          direction: action.scroll_direction ?? "down",
          amount: action.scroll_amount ?? 3,
          ...at,
        },
      ];
  }
}

const stopped = () => new AppError("Start the computer before using its terminal or files", 409);
const fileResult = (stdout: string): DockerResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
  timedOut: false,
  interrupted: false,
  truncated: false,
});
const fileFailure = (stderr: string): DockerResult => ({ ...fileResult(""), stderr, exitCode: 1 });

export class BoxComputeComputer implements ComputerDesktop {
  private workspace?: Promise<string>;
  constructor(
    private readonly config: Config,
    private readonly driver: BoxComputeDriver = boxcomputeDriver(config),
  ) {}
  private async control<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof BoxComputeApiError) {
        if (error.code === "INSUFFICIENT_CREDIT" || error.code === "BILLING_ACCOUNT_FROZEN")
          throw new AppError(
            "The BoxCompute account has no compute credit. Add credit to use the computer.",
            409,
          );
        if (error.code === "DESKTOP_UNAVAILABLE")
          throw new AppError(
            "The desktop session is unavailable. Start the computer to restore it.",
            409,
          );
        if (error.code === "DESKTOP_BUSY")
          throw new AppError("The desktop is busy with another operation. Try again shortly.", 409);
      }
      throw new AppError(
        "BoxCompute operation failed. Check BOXCOMPUTE_API_KEY and its scopes.",
        503,
      );
    }
  }
  /** The workspace new VMs are created in: configured, or one named OpenMuse. */
  private workspaceId() {
    if (this.config.boxcomputeWorkspaceId)
      return Promise.resolve(this.config.boxcomputeWorkspaceId);
    this.workspace ??= this.control(async () => {
      const named = (await this.driver.workspaces()).filter((item) => item.name === workspaceName);
      if (named.length > 1)
        throw new AppError(
          `More than one BoxCompute workspace is named ${workspaceName}; set BOXCOMPUTE_WORKSPACE_ID.`,
          409,
        );
      if (named[0]) return named[0].id;
      const deployment = hash(this.config.computerDeploymentId ?? "").slice(0, 16);
      return (await this.driver.createWorkspace(workspaceName, `openmuse-workspace-${deployment}`))
        .id;
    }).catch((error: unknown) => {
      this.workspace = undefined;
      throw error;
    });
    return this.workspace;
  }
  // Fail-closed analog of the Docker inspection: refuse to attach to anything this
  // deployment did not create, or to a VM that cannot run the desktop.
  async inspect(labels: Record<string, string>) {
    // The API matches these labels as a subset; anything it returns with other metadata is not ours.
    const found = await this.control(() => this.driver.list(labels));
    if (!found.length) return undefined;
    const vm = found[0];
    const metadata = vm.metadata ?? {};
    if (
      found.length > 1 ||
      Object.keys(metadata).length !== Object.keys(labels).length ||
      !Object.entries(labels).every(([key, value]) => metadata[key] === value) ||
      !vm.vmSandbox ||
      vm.size !== "large" ||
      vm.blockNetwork !== false ||
      vm.state === "expired" ||
      (this.config.boxcomputeWorkspaceId && vm.workspaceId !== this.config.boxcomputeWorkspaceId)
    )
      throw new AppError(
        "Computer ownership or isolation does not match this deployment; refusing to attach",
        409,
      );
    return vm;
  }
  async state(labels: Record<string, string>): Promise<ComputerState> {
    const vm = await this.inspect(labels);
    return !vm ? "missing" : vm.state === "running" ? "running" : "stopped";
  }
  private async running(id: string) {
    const deadline = Date.now() + createMs;
    for (;;) {
      const vm = await this.control(() => this.driver.get(id));
      if (vm.state === "running") return vm;
      if (vm.state === "expired" || Date.now() >= deadline)
        throw new AppError("The BoxCompute VM did not start. Check its status in BoxCompute.", 503);
      await sleep(pollMs);
    }
  }
  async start(labels: Record<string, string>) {
    let vm = await this.inspect(labels);
    if (!vm) {
      const workspaceId = await this.workspaceId();
      // The service lease serializes starts, and the next start finds a VM still being
      // created by metadata, so a fresh key per attempt cannot leave two VMs behind.
      const key = `openmuse-computer-${randomUUID()}`;
      vm = await this.control(() =>
        this.driver.create({ workspaceId, name: vmName, metadata: labels }, key),
      );
      await this.inspect(labels); // re-check: exactly one, this deployment's own
    } else if (vm.state === "cold") {
      vm = await this.control(() => this.driver.start((vm as BoxComputeSandbox).id));
    }
    const id = vm.id;
    await this.running(id);
    await this.control(() => this.driver.startDesktop(id));
  }
  async stop(labels: Record<string, string>) {
    const vm = await this.inspect(labels);
    if (vm?.state === "running") await this.control(() => this.driver.stop(vm.id));
  }
  /** The running VM, or a 409; never starts one. */
  async attach(labels: Record<string, string>, verified?: BoxComputeSandbox) {
    const vm = verified ?? (await this.inspect(labels));
    if (vm?.state !== "running") throw stopped();
    return vm;
  }
  async desktopUrl(labels: Record<string, string>) {
    const vm = await this.attach(labels);
    return this.control(() => this.driver.viewer(vm.id));
  }
  async act(
    labels: Record<string, string>,
    action: DesktopAction,
    beforeInput?: () => Promise<void>,
  ): Promise<DesktopShot> {
    const vm = await this.attach(labels);
    const inputs = boxcomputeInputs(action);
    const screen = { mimeType: "image/jpeg" as const, width: resolution[0], height: resolution[1] };
    const frame = async () => this.control(() => this.driver.screenshot(vm.id));
    if (!inputs.length) {
      if (action.action === "wait") await sleep((action.duration ?? 1) * 1000);
      return {
        ...screen,
        image: await frame().catch(() => {
          throw new AppError("The desktop screenshot failed", 502);
        }),
        uncertain: false,
      };
    }
    await beforeInput?.();
    let sent = 0;
    let shot: { mimeType: string; data: string } | null | undefined;
    try {
      for (const [index, input] of inputs.entries()) {
        const last = index === inputs.length - 1;
        shot = (await this.driver.act(vm.id, input, last)).screenshot;
        sent++;
      }
    } catch (error) {
      // A refusal of the first input means nothing ran; anything later, or a lost answer, may have.
      const certain =
        sent === 0 &&
        error instanceof BoxComputeApiError &&
        error.status < 500 &&
        error.code !== "DESKTOP_INPUT_UNCERTAIN";
      if (certain)
        throw new AppError(
          error.code === "DESKTOP_UNAVAILABLE"
            ? "The desktop is not running. Start the computer to restore it."
            : error.message,
          error.code === "INVALID_REQUEST" ? 422 : 503,
        );
      const image = await frame().catch(() => new Uint8Array());
      return {
        ...screen,
        image,
        uncertain: true,
        warning:
          "The desktop input outcome is unknown: it may already have been performed. Inspect a fresh screenshot before repeating the action; do not automatically retry it.",
      };
    }
    if (!shot)
      return {
        ...screen,
        image: new Uint8Array(),
        uncertain: false,
        warning:
          "Action performed; the screenshot could not be taken. Take a screenshot before retrying the action.",
      };
    return { ...screen, image: new Uint8Array(Buffer.from(shot.data, "base64")), uncertain: false };
  }

  /** Same contract as DockerRunner: command outcomes are results, never exceptions. */
  async run(
    labels: Record<string, string>,
    command: string,
    options: { cwd: string; signal?: AbortSignal; verified?: BoxComputeSandbox },
  ): Promise<DockerResult> {
    const output = computerOutput();
    const { result, finish } = output;
    let vm: BoxComputeSandbox;
    try {
      vm = await this.attach(labels, options.verified);
    } catch (error) {
      result.stderr =
        error instanceof AppError ? error.message : "The computer could not be reached.";
      return result;
    }
    if (options.signal?.aborted) {
      result.interrupted = true;
      return finish();
    }
    try {
      // The command travels in the environment: BoxCompute caps one argument at 8 KB.
      const executed = await this.driver.execute(
        vm.id,
        {
          argv: [
            "/bin/bash",
            "--noprofile",
            "--norc",
            "-c",
            desktopScript('"$OPENMUSE_COMMAND"'),
            "openmuse",
          ],
          cwd: options.cwd,
          env: { OPENMUSE_COMMAND: command, HOME: "/workspace", LANG: "C.UTF-8" },
          timeoutSeconds: commandSeconds,
          maxOutputBytes: 2 * (computerOutputLimit + 1) + 4096,
        },
        options.signal,
      );
      output.stdout(executed.stdout);
      output.stderr(executed.stderr);
      result.exitCode = executed.exitCode;
      result.timedOut = executed.timedOut;
      if (executed.stdoutTruncated || executed.stderrTruncated) result.truncated = true;
    } catch (error) {
      if (error instanceof BoxComputeApiError && error.code === "SANDBOX_STOPPED")
        // Stopped after the inspection: nothing ran, and the VM is not woken for it.
        output.stderr(stopped().message);
      else if (error instanceof BoxComputeApiError && error.code === "EXECUTION_TIMEOUT")
        result.timedOut = true;
      else if (error instanceof BoxComputeApiError && error.code === "INVALID_PATH") {
        // A missing working directory is rejected before the command starts.
        result.exitCode = 126;
        output.stderr("The working directory does not exist.");
      }
      // Any other loss leaves the outcome unknown; the service stops the VM.
      else result.interrupted = true;
    }
    return finish();
  }

  /** The `apps/computer/files.py` contract, served by BoxCompute's own file API. */
  async file(
    labels: Record<string, string>,
    input: string,
    verified?: BoxComputeSandbox,
  ): Promise<DockerResult> {
    const vm = await this.attach(labels, verified);
    const request = JSON.parse(input) as {
      operation: string;
      path: string;
      text?: string;
      base64?: string;
    };
    const path = request.path;
    try {
      switch (request.operation) {
        case "list": {
          const entries: { name: string; path: string; type: string; size: number }[] = [];
          let cursor: string | undefined;
          do {
            const page = await this.driver.listFiles(vm.id, path, cursor);
            for (const entry of page.entries) {
              if (entries.length >= listLimit) return fileFailure("Directory exceeds 1000 entries");
              entries.push({
                name: entry.name,
                path: entry.path,
                type:
                  entry.kind === "dir"
                    ? "directory"
                    : entry.kind === "symlink"
                      ? "symlink"
                      : "file",
                size: entry.size,
              });
            }
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
          // files.py's order: directories first, then code-point order of the name.
          const rank = (entry: { type: string }) => (entry.type === "directory" ? 0 : 1);
          entries.sort(
            (a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
          );
          return fileResult(JSON.stringify({ path, entries }));
        }
        case "read":
        case "read_pdf": {
          const info = await this.driver.stat(vm.id, path);
          if (!info || info.isSymbolicLink || info.kind !== "file")
            return fileFailure("Only regular files can be read");
          const limit = request.operation === "read_pdf" ? pdfLimit : fileLimit;
          if (info.size > limit) return fileFailure("File exceeds size limit");
          const parts: Uint8Array[] = [];
          for (let offset = 0; offset < info.size; offset += fileChunk)
            parts.push(
              await this.driver.readFile(
                vm.id,
                path,
                offset,
                Math.min(fileChunk, limit + 1 - offset),
              ),
            );
          const content = Buffer.concat(parts);
          if (content.length > limit) return fileFailure("File exceeds size limit");
          if (request.operation === "read_pdf") {
            if (!content.subarray(0, 5).equals(Buffer.from("%PDF-")))
              return fileFailure("Choose a PDF file");
            return fileResult(JSON.stringify({ path, base64: content.toString("base64") }));
          }
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(content);
          } catch {
            return fileFailure("File is not valid UTF-8 text");
          }
          return fileResult(JSON.stringify({ path, text }));
        }
        case "write":
        case "write_pdf": {
          const content =
            request.operation === "write_pdf"
              ? Buffer.from(request.base64 ?? "", "base64")
              : Buffer.from(request.text ?? "", "utf8");
          const limit = request.operation === "write_pdf" ? pdfLimit : fileLimit;
          if (
            request.operation === "write_pdf" &&
            !content.subarray(0, 5).equals(Buffer.from("%PDF-"))
          )
            return fileFailure("Choose a PDF file");
          if (content.length > limit) return fileFailure("File exceeds size limit");
          // Refuse symlinks and special files even when replacing, like files.py.
          const info = await this.driver.stat(vm.id, path);
          if (info && (info.isSymbolicLink || info.kind !== "file"))
            return fileFailure("Only regular files can be replaced");
          if (content.length <= fileChunk) await this.driver.writeFile(vm.id, path, content);
          else await this.writeLarge(vm, path, content);
          return fileResult(JSON.stringify({ path }));
        }
        case "mkdir":
          await this.driver.makeDirectory(vm.id, path);
          return fileResult(JSON.stringify({ path }));
        default:
          return fileFailure("Unsupported file operation");
      }
    } catch (error) {
      if (error instanceof BoxComputeApiError && error.code === "SANDBOX_STOPPED") throw stopped();
      if (error instanceof BoxComputeApiError && error.status < 500 && error.status !== 402)
        return fileFailure(error.message);
      return this.control(() => Promise.reject(error));
    }
  }
  /** A file above one request's limit: parts beside it, joined and renamed into place in the VM. */
  private async writeLarge(vm: BoxComputeSandbox, path: string, content: Buffer) {
    const slash = path.lastIndexOf("/");
    const stem = `${path.slice(0, slash)}/.openmuse-${hash(`${path}${Date.now()}`).slice(0, 16)}`;
    const parts: string[] = [];
    try {
      for (let offset = 0; offset < content.length; offset += fileChunk) {
        const part = `${stem}.part${parts.length}`;
        await this.driver.writeFile(vm.id, part, content.subarray(offset, offset + fileChunk));
        parts.push(part);
      }
      const joined = await this.driver.execute(vm.id, {
        argv: [
          "/bin/sh",
          "-c",
          'out=$1; shift; cat -- "$@" > "$out.tmp" && mv -f -- "$out.tmp" "$out"',
          "openmuse",
          path,
          ...parts,
        ],
        cwd: "/workspace",
        env: {},
        timeoutSeconds: 30,
        maxOutputBytes: 4096,
      });
      if (joined.exitCode !== 0)
        throw new BoxComputeApiError(422, "WRITE_FAILED", "The file could not be written");
    } finally {
      for (const part of parts) await this.driver.removeFile(vm.id, part).catch(() => {});
    }
  }
}
