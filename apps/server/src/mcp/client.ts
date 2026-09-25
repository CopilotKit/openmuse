import { type ChildProcess, spawn } from "node:child_process";
import type { McpCallResult, McpServerConfig, McpToolSchema } from "./types.ts";

export class McpClient {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<
    number | string,
    { resolve: (res: any) => void; reject: (err: any) => void }
  >();
  private buffer = "";

  constructor(public readonly config: McpServerConfig) {}

  public async initialize(): Promise<void> {
    if (this.config.transport === "stdio") {
      if (!this.config.command) {
        throw new Error(`MCP server ${this.config.id} requires a command for stdio transport`);
      }
      this.process = spawn(this.config.command, this.config.args || [], {
        env: { ...process.env, ...this.config.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.process.stdout?.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf-8");
        this.processBuffer();
      });

      this.process.stderr?.on("data", (chunk: Buffer) => {
        console.warn(`[mcp:${this.config.id}:stderr]`, chunk.toString("utf-8"));
      });

      this.process.on("error", (err) => {
        console.error(`[mcp:${this.config.id}] process error:`, err);
      });

      // Send standard MCP initialize handshake
      await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        clientInfo: { name: "OpenMuse", version: "1.0.0" },
      });
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const handler = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            handler.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            handler.resolve(msg.result);
          }
        }
      } catch (_e) {
        // Not a full JSON line or non-JSON message
      }
    }
  }

  public async request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.config.transport === "http" || this.config.transport === "sse") {
      const url = this.config.url || "http://127.0.0.1:3000";
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
      });
      if (!res.ok) throw new Error(`HTTP error ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as any;
      if (data.error) throw new Error(data.error.message || "MCP error");
      return data.result as T;
    }

    if (!this.process?.stdin) {
      throw new Error(`MCP process not started for ${this.config.id}`);
    }

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request ${method} timed out after 30s`));
        }
      }, 30000);

      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
      this.process?.stdin?.write(payload);
    });
  }

  public async listTools(): Promise<McpToolSchema[]> {
    const res = await this.request<{ tools: McpToolSchema[] }>("tools/list", {});
    return res.tools || [];
  }

  public async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
    return await this.request<McpCallResult>("tools/call", { name, arguments: args });
  }

  public close(): void {
    if (this.process) {
      try {
        this.process.kill();
      } catch {}
      this.process = null;
    }
  }
}
