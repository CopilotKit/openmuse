/**
 * Local AI relay: bridges the server's agent loop to a device's on-device model.
 *
 * When a conversation or task selects a `local/<model>` provider, the TanStack
 * adapter points at the relay route (`/api/agent/localai/chat/completions`).
 * That route asks this service to forward the OpenAI-compatible request over
 * the device's persistent WebSocket — the phone proxies it to meaty on its own
 * loopback and streams the SSE chunks back.
 *
 * The phone opens the WebSocket as part of the device work loop; it stays alive
 * in the foreground and reconnects after interruption. No new agent path is
 * involved — the server still runs the full CopilotKB loop, this merely makes
 * the model call travel through the device.
 */
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { Config } from "../config.ts";

/** One frame in the relay protocol. */
export type RelayMessage =
  | {
      type: "inference";
      requestId: string;
      body: Record<string, unknown>;
      headers?: Record<string, string>;
    }
  | { type: "chunk"; requestId: string; data: string }
  | { type: "done"; requestId: string }
  | { type: "error"; requestId: string; message: string; status?: number }
  | { type: "cancel"; requestId: string }
  | { type: "pong" };

export interface DeviceRelayConnection {
  deviceId: string;
  owner: string;
  ws: WebSocket;
  lastSeen: number;
  /** True while an inference request is in flight for this device. */
  busy: boolean;
}

export class LocalAiRelay {
  private connections = new Map<string, DeviceRelayConnection>();
  private readonly heartbeatTimeoutMs: number;

  constructor(config: Config) {
    this.heartbeatTimeoutMs = config.localaiHeartbeatTimeoutMs ?? 30_000;
  }

  register(deviceId: string, owner: string, ws: WebSocket): void {
    this.unregister(deviceId);
    const conn: DeviceRelayConnection = {
      deviceId,
      owner,
      ws,
      lastSeen: Date.now(),
      busy: false,
    };
    this.connections.set(deviceId, conn);

    // Keep-alive: update lastSeen when the device pongs and clean up on close.
    ws.on("message", (data) => {
      let msg: RelayMessage;
      try {
        msg = JSON.parse(data.toString()) as RelayMessage;
      } catch {
        return;
      }
      if (msg.type === "pong") conn.lastSeen = Date.now();
    });
    ws.on("close", () => this.connections.delete(deviceId));
    ws.on("error", () => this.connections.delete(deviceId));
  }

  unregister(deviceId: string): void {
    const conn = this.connections.get(deviceId);
    if (conn) {
      try {
        conn.ws.close(1000, "relay closed");
      } catch {
        // socket already gone
      }
      this.connections.delete(deviceId);
    }
  }

  /** Whether a device has a live WebSocket that has pinged recently. */
  isReachable(deviceId: string, now = Date.now()): boolean {
    const conn = this.connections.get(deviceId);
    if (!conn) return false;
    if (conn.ws.readyState !== WebSocket.OPEN) {
      this.connections.delete(deviceId);
      return false;
    }
    return now - conn.lastSeen < this.heartbeatTimeoutMs;
  }

  /** Forwards an OpenAI-compatible request and yields raw SSE chunk strings. */
  async *forward(
    deviceId: string,
    body: Record<string, unknown>,
    headers: Record<string, string> | undefined,
    signal: AbortSignal,
  ): AsyncIterable<string> {
    const conn = this.connections.get(deviceId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Device "${deviceId}" is not connected to the relay`);
    }
    if (conn.busy) {
      throw new Error(`Device "${deviceId}" is already processing an inference`);
    }

    const requestId = randomUUID();
    conn.busy = true;
    conn.lastSeen = Date.now();

    // Queue for SSE chunks arriving via WebSocket messages.
    const queue: string[] = [];
    let resolveNext: (() => void) | null = null;
    let finished = false;
    let streamError: Error | null = null;

    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]) => {
      if (finished) return;
      const text = data.toString("utf-8");
      let msg: RelayMessage;
      try {
        msg = JSON.parse(text) as RelayMessage;
      } catch {
        return;
      }
      if (msg.type !== "chunk" && msg.type !== "done" && msg.type !== "error") return;
      if ((msg as { requestId?: string }).requestId !== requestId) return;

      conn.lastSeen = Date.now();
      switch (msg.type) {
        case "chunk":
          queue.push(msg.data);
          break;
        case "done":
          finished = true;
          break;
        case "error":
          streamError = new Error(msg.message);
          if (msg.status !== undefined)
            (streamError as Error & { status: number }).status = msg.status;
          finished = true;
          break;
      }
      resolveNext?.();
      resolveNext = null;
    };

    conn.ws.on("message", onMessage);

    const onAbort = () => {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(JSON.stringify({ type: "cancel", requestId }));
      }
      resolveNext?.();
      resolveNext = null;
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort);

    // Send the inference request to the device.
    conn.ws.send(JSON.stringify({ type: "inference", requestId, body, headers }));

    try {
      while (!finished) {
        if (queue.length > 0) {
          yield queue.shift() as string;
        } else if (streamError) {
          throw streamError;
        } else if (signal.aborted) {
          throw new Error("Inference aborted");
        } else {
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
        }
      }
      if (streamError) throw streamError;
    } finally {
      conn.busy = false;
      conn.ws.off("message", onMessage);
      signal.removeEventListener("abort", onAbort);
    }
  }

  connectionCount(): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      if (conn.ws.readyState === WebSocket.OPEN) count++;
    }
    return count;
  }

  /** Touch a device's lastSeen timestamp (called by the ping handler). */
  touch(deviceId: string): void {
    const conn = this.connections.get(deviceId);
    if (conn) conn.lastSeen = Date.now();
  }

  deviceOwner(deviceId: string): string | undefined {
    return this.connections.get(deviceId)?.owner;
  }
}
