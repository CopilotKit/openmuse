/**
 * Phone-side WebSocket relay client.
 *
 * Maintains a persistent WebSocket connection to the server's relay endpoint.
 * When the server forwards an OpenAI-compatible chat-completion request (from
 * the `local` provider adapter), the client proxies it to the local meaty
 * server on the device's loopback and streams the SSE chunks back over the
 * same WebSocket.
 *
 * Connection auth uses the session token sent as a WebSocket protocol
 * string ("Bearer <token>") — compatible with the standard DOM WebSocket
 * constructor and the server's `Sec-WebSocket-Protocol` reader in `index.ts`.
 */
import { API_URL } from "./api.ts";
import { deviceId } from "./device.ts";

const MEATY_URL = process.env.EXPO_PUBLIC_MEATY_URL ?? "http://127.0.0.1:11435/v1/chat/completions";
const MEATY_TOKEN = process.env.EXPO_PUBLIC_MEATY_AUTH_TOKEN ?? "omnibutler-local-dev-token";

/** One frame in the relay protocol. */
type RelayFrame =
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
  | { type: "ping" }
  | { type: "pong" };

export interface LocalAiClientOptions {
  token: string;
}

export class LocalAiClient {
  private ws: WebSocket | null = null;
  private deviceId: string | null = null;
  private readonly token: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;

  constructor(options: LocalAiClientOptions) {
    this.token = options.token;
  }

  async start(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.deviceId = await deviceId();

    const wsUrl = `${API_URL}/api/agent/localai/relay?deviceId=${encodeURIComponent(this.deviceId)}`;
    // Pass the session token as a WebSocket protocol ("Bearer <token>").
    // The server reads it from the Sec-WebSocket-Protocol request header.
    this.ws = new WebSocket(wsUrl, `Bearer ${this.token}`);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };

    this.ws.onclose = () => {
      this.ws = null;
      // Attempt reconnection with exponential backoff (up to ~30 s).
      // stop() nulls onclose before closing, so we only reconnect when
      // the server (or network) drops the connection.
      const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectAttempts++;
        void this.start();
      }, delay);
    };

    this.ws.onerror = () => {
      // Errors are expected during connection loss; reconnection handles recovery.
    };
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onopen = null;
      this.ws.onmessage = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  private handleMessage(data: string): void {
    let frame: RelayFrame;
    try {
      frame = JSON.parse(data) as RelayFrame;
    } catch {
      return;
    }

    switch (frame.type) {
      case "ping":
        this.send({ type: "pong" });
        break;
      case "inference":
        void this.forwardToMeaty(frame.requestId, frame.body, frame.headers);
        break;
      case "cancel":
        // Cancellation is handled by AbortController on the server side.
        break;
    }
  }

  /** Proxy a chat-completion request to meaty and stream SSE chunks back. */
  private async forwardToMeaty(
    requestId: string,
    body: Record<string, unknown>,
    headers: Record<string, string> | undefined,
  ): Promise<void> {
    const meatyHeaders: Record<string, string> = {
      Authorization: `Bearer ${MEATY_TOKEN}`,
      "X-Ecosystem-App": "openmuse",
      "X-Priority": "interactive",
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(headers ?? {}),
    };

    try {
      const response = await fetch(MEATY_URL, {
        method: "POST",
        headers: meatyHeaders,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        this.send({
          type: "error",
          requestId,
          status: response.status,
          message: await response.text(),
        });
        return;
      }

      // Stream SSE chunks back to the server over the relay WebSocket.
      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        try {
          let readDone = false;
          while (!readDone) {
            const { done, value } = await reader.read();
            if (done) {
              readDone = true;
            } else {
              const chunk = decoder.decode(value, { stream: true });
              this.send({ type: "chunk", requestId, data: chunk });
            }
          }
        } finally {
          reader.releaseLock();
        }
      }

      this.send({ type: "done", requestId });
    } catch (error) {
      this.send({
        type: "error",
        requestId,
        status: 503,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private send(frame: RelayFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }
}
