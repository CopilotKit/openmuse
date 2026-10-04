import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computerIdentity } from "./computer.ts";
import type { Config } from "./config.ts";

/**
 * LayaClient — bridges OpenMuse's Docker-based computer workspace to the
 * laya-file-mcp CLI. File contents are copied out of the container to a
 * temp directory, classified by Laya (content stays on disk, never enters
 * the LLM context), and only the classification result is returned.
 *
 * This saves ~1250 tokens per 5KB file compared to reading the file into
 * context — the same benefit as the mcp_laya_file_* MCP tools.
 */

export interface LayaBoolResult {
  answer: "yes" | "no";
  question: string;
  noul?: number;
  confidence: number;
  cached?: boolean;
  truncated?: boolean;
  fallback?: boolean;
  model?: string;
  latency_ms?: number;
  error?: string;
}

export interface LayaChoiceResult {
  choice: string;
  question: string;
  probabilities?: Record<string, number>;
  confidence: number;
  cached?: boolean;
  truncated?: boolean;
  fallback?: boolean;
  model?: string;
  latency_ms?: number;
  path?: string;
  error?: string;
}

export interface LayaPickResult {
  path: string;
  purpose: string;
  probability: number;
  model?: string;
  latency_ms?: number;
  cached?: boolean;
  error?: string;
}

export interface LayaStatus {
  service: string;
  tunnel_port: number;
  ssh_host: string;
  tunnel_alive: boolean;
  laya_service: string;
  model: string;
  device: string;
  max_chars_per_call: number;
  max_file_kb: number;
  max_files_per_glob: number;
  cache: {
    entries: number;
    entries_on_disk: number;
    hits: number;
    misses: number;
    hit_rate: number;
    size_kb: number;
    max_size: number;
    ttl_seconds: number;
    cache_file: string;
  };
  error?: string;
}

// --- Internal raw response shapes from the Laya CLI ---

/** Raw `status` CLI → `laya_file_status` MCP response. */
interface LayaStatusRaw {
  service: string;
  tunnel_port: number;
  ssh_host: string;
  tunnel_alive: boolean;
  laya_service: string;
  model: string;
  device: string;
  max_chars_per_call: number;
  max_file_kb: number;
  max_files_per_glob: number;
  cache: {
    entries: number;
    entries_on_disk: number;
    hits: number;
    misses: number;
    hit_rate: number;
    size_kb: number;
    max_size: number;
    ttl_seconds: number;
    cache_file: string;
  };
}

/** Classification payload nested under `answer` in each glob result. */
interface LayaAnswer {
  type?: string;
  choice?: string;
  noul?: number;
  score?: number;
  level?: string;
  levels?: string[];
  probabilities?: Record<string, number>;
  confidence?: number;
  [key: string]: unknown;
}

/** A single entry inside the glob `results` array. */
interface LayaGlobEntry {
  path: string;
  answer: LayaAnswer;
  model: string;
  usage: { input_tokens?: number; output_tokens?: number };
  truncated: boolean;
  cached: boolean;
  [key: string]: unknown;
}

/** Raw `glob` CLI → `laya_files_glob` MCP response. */
interface LayaGlobRaw {
  pattern: string;
  total_files: number;
  results: LayaGlobEntry[];
  total_input_tokens?: number;
  cached: number;
  summary?: string;
  error?: string;
}

/** Raw `pick` CLI → `laya_file_pick` MCP response. */
interface LayaPickRaw {
  picked: string;
  probabilities?: Record<string, number>;
  confidence?: number;
  model?: string;
  latency_ms?: number;
  error?: string;
}

/**
 * Normalize any Laya glob entry into a flat LayaChoiceResult.
 * The CLI nests the classification fields under `answer`; this extracts them
 * to the top level so consumers see a uniform shape.
 */
function normalizeGlobEntry(entry: LayaGlobEntry, question: string): LayaChoiceResult {
  const ans = entry.answer;
  return {
    path: entry.path,
    question,
    choice: ans.choice ?? "unknown",
    probabilities: ans.probabilities,
    confidence: ans.confidence ?? 0,
    cached: entry.cached,
    truncated: entry.truncated,
    model: entry.model,
    fallback: ans.fallback as boolean | undefined,
  };
}

export class LayaClient {
  private readonly container: string;
  private readonly pythonBin: string;
  private readonly cliPath: string;
  private readonly dockerBin: string;
  private readonly enabled: boolean;

  constructor(config: Config, owner: string) {
    const identity = computerIdentity(config, owner);
    this.container = identity.container;
    this.pythonBin =
      process.env.LAYA_PYTHON_BIN ?? "/home/ubuntu/.hermes/hermes-agent/venv/bin/python3";
    this.cliPath = process.env.LAYA_CLI_PATH ?? "/home/ubuntu/laya-file-mcp/laya_cli.py";
    this.dockerBin = process.env.LAYA_DOCKER_BIN ?? "docker";
    this.enabled = Boolean(process.env.LAYA_ENABLED);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Run the Laya CLI with given args and parse JSON output. */
  private async runCli<T>(args: string[], timeoutMs = 30000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      execFile(
        this.pythonBin,
        [this.cliPath, ...args],
        {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          env: { ...process.env },
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(
                `Laya CLI error: ${error.message}${stderr ? ` stderr: ${stderr.slice(0, 500)}` : ""}`,
              ),
            );
            return;
          }
          const trimmed = stdout.replace(/^\[laya_file_mcp\][^\n]*\n/, "").trim();
          if (!trimmed) {
            reject(new Error("Laya returned no output"));
            return;
          }
          try {
            resolve(JSON.parse(trimmed) as T);
          } catch {
            reject(new Error(`Laya returned invalid JSON: ${trimmed.slice(0, 200)}`));
          }
        },
      );
    });
  }

  /** Run `docker cp` to copy a single path from the container to the host. */
  private async dockerCp(srcContainerPath: string, destHostPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(
        this.dockerBin,
        ["cp", `${this.container}:${srcContainerPath}`, destHostPath],
        { timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
        (error, _stdout, stderr) => {
          if (error) {
            reject(
              new Error(
                `docker cp failed for ${srcContainerPath}: ${error.message}${stderr ? ` stderr: ${stderr.slice(0, 300)}` : ""}`,
              ),
            );
            return;
          }
          resolve();
        },
      );
    });
  }

  /** Check Laya service health and cache stats. */
  async status(): Promise<LayaStatus> {
    return this.runCli<LayaStatusRaw>(["status"]) as Promise<LayaStatus>;
  }

  /** Clear all cached classification results. */
  async clearCache(): Promise<{ ok: boolean }> {
    return this.runCli<{ ok: boolean }>(["clear_cache"]);
  }

  /**
   * Classify a single file in the computer workspace WITHOUT reading its
   * content into the agent context. The file is copied to a temp path on
   * the host, classified by Laya, and only the result is returned.
   */
  async classifyComputerFile(
    workspacePath: string,
    question: string,
    trueCriteria: string,
    falseCriteria: string,
  ): Promise<LayaBoolResult> {
    const tempPath = join(
      tmpdir(),
      `laya-file-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      await this.dockerCp(workspacePath, tempPath);
      return await this.runCli<LayaBoolResult>([
        "bool",
        tempPath,
        question,
        trueCriteria,
        falseCriteria,
      ]);
    } finally {
      await rm(tempPath, { force: true });
    }
  }

  /**
   * Classify every text file under a directory in the computer workspace.
   * The directory is copied to a temp path, then Laya's glob classifier
   * scans all files in parallel. Results include the original workspace
   * path for each classification.
   */
  async classifyComputerDirectory(
    workspaceDir: string,
    question: string,
    options: Record<string, string>,
  ): Promise<LayaChoiceResult[]> {
    const tempDir = await mkdtemp(join(tmpdir(), "laya-computer-"));
    try {
      await this.dockerCp(workspaceDir, tempDir);
      const globPattern = join(tempDir, "**", "*");
      const results = await this.classifyGlob(globPattern, question, options);
      // Map temp paths back to workspace paths
      const workspaceBase = workspaceDir.replace(/\/+$/, "");
      return results.map((r): LayaChoiceResult => {
        const rawPath = r.path;
        const originalPath = rawPath ? rawPath.replace(tempDir, workspaceBase) : undefined;
        return { ...r, path: originalPath };
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Pick the single most-relevant file from a set of workspace paths
   * for a given purpose. Useful when the agent knows several candidate
   * files and needs to narrow to one.
   */
  async pickFromComputerFiles(purpose: string, workspacePaths: string[]): Promise<LayaPickResult> {
    const tempDir = await mkdtemp(join(tmpdir(), "laya-pick-"));
    const tempPaths: string[] = [];
    try {
      for (const wsPath of workspacePaths) {
        const fileName = wsPath.split("/").pop() ?? `file-${tempPaths.length}`;
        const tempPath = join(tempDir, fileName);
        await this.dockerCp(wsPath, tempPath);
        tempPaths.push(tempPath);
      }
      const raw = await this.runCli<LayaPickRaw>(["pick", purpose, ...tempPaths]);
      // Map the temp path back to the workspace path
      const idx = tempPaths.indexOf(raw.picked);
      const matchedWsPath = idx >= 0 ? (workspacePaths[idx] ?? raw.picked) : raw.picked;
      return {
        path: matchedWsPath,
        purpose,
        probability: raw.confidence ?? 0,
        model: raw.model,
        latency_ms: raw.latency_ms,
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  /** Classify a file already on the host filesystem (no Docker copy needed). */
  async classifyHostFile(
    hostPath: string,
    question: string,
    trueCriteria: string,
    falseCriteria: string,
  ): Promise<LayaBoolResult> {
    return this.runCli<LayaBoolResult>(["bool", hostPath, question, trueCriteria, falseCriteria]);
  }

  /** Classify multiple host files via glob pattern. */
  async classifyHostGlob(
    globPattern: string,
    question: string,
    options: Record<string, string>,
  ): Promise<LayaChoiceResult[]> {
    return this.classifyGlob(globPattern, question, options);
  }

  /** Pick the most-relevant host file for a purpose. */
  async pickFromHostFiles(purpose: string, hostFilePaths: string[]): Promise<LayaPickResult> {
    const raw = await this.runCli<LayaPickRaw>(["pick", purpose, ...hostFilePaths]);
    const idx = hostFilePaths.indexOf(raw.picked);
    const matchedWsPath = idx >= 0 ? (hostFilePaths[idx] ?? raw.picked) : raw.picked;
    return {
      path: matchedWsPath,
      purpose,
      probability: raw.confidence ?? 0,
      model: raw.model,
      latency_ms: raw.latency_ms,
    };
  }

  /**
   * Shared glob-classification core. Calls `laya_files_glob` and flattens
   * the nested `answer` objects into LayaChoiceResult records.
   */
  private async classifyGlob(
    globPattern: string,
    question: string,
    options: Record<string, string>,
  ): Promise<LayaChoiceResult[]> {
    const cliArgs = ["glob", globPattern, question];
    for (const [key, label] of Object.entries(options)) {
      cliArgs.push(key, label);
    }
    const raw = await this.runCli<LayaGlobRaw>(cliArgs);
    if (raw.error) {
      return [{ path: "", question, choice: "error", confidence: 0, error: raw.error }];
    }
    return raw.results.map((entry) => normalizeGlobEntry(entry, question));
  }
}

/** Check if Docker is reachable — used before attempting container file ops. */
export async function dockerReachable(dockerBin: string = "docker"): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      dockerBin,
      ["version", "--format", "{{.Server.Version}}"],
      { timeout: 5000 },
      (error) => {
        resolve(!error);
      },
    );
  });
}
