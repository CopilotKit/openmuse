import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebSocket } from "ws";
import type { Config } from "../apps/server/src/config.ts";
import { LocalAiRelay, type RelayMessage } from "../apps/server/src/engine/localai-relay.ts";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  readonly sent: string[] = [];
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  on(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners[event];
    if (existing) {
      existing.push(listener);
    } else {
      this.listeners[event] = [listener];
    }
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    const arr = this.listeners[event];
    if (arr) this.listeners[event] = arr.filter((l) => l !== listener);
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSING;
    for (const l of [...(this.listeners.close ?? [])]) l();
  }

  emitMessage(data: string): void {
    for (const l of [...(this.listeners.message ?? [])]) l(Buffer.from(data));
  }
}

const mockWs = (ws: MockWebSocket): WebSocket => ws as unknown as WebSocket;
const testConfig = { localaiHeartbeatTimeoutMs: 30_000 } as unknown as Config;

test("register makes a device reachable", () => {
  const relay = new LocalAiRelay(testConfig);
  const ws = new MockWebSocket();
  relay.register("device-1", "owner-1", mockWs(ws));
  assert.equal(relay.isReachable("device-1"), true);
  assert.equal(relay.connectionCount(), 1);
  assert.equal(relay.deviceOwner("device-1"), "owner-1");
});

test("unregister makes a device unreachable", () => {
  const relay = new LocalAiRelay(testConfig);
  const ws = new MockWebSocket();
  relay.register("device-1", "owner-1", mockWs(ws));
  assert.equal(relay.isReachable("device-1"), true);
  relay.unregister("device-1");
  assert.equal(relay.isReachable("device-1"), false);
  assert.equal(relay.connectionCount(), 0);
});

test("forward sends inference request and yields SSE chunks in order", async () => {
  const relay = new LocalAiRelay(testConfig);
  const ws = new MockWebSocket();
  relay.register("device-1", "owner-1", mockWs(ws));

  const body = { model: "qwen3-8b", stream: true, messages: [] };
  const controller = new AbortController();
  const gen = relay.forward("device-1", body, { "X-Ecosystem-App": "openmuse" }, controller.signal);
  const iterator = gen[Symbol.asyncIterator]();

  const p1 = iterator.next();
  assert.ok(ws.sent.length > 0);
  const request = JSON.parse(ws.sent[ws.sent.length - 1]!);
  assert.equal(request.type, "inference");
  assert.equal(request.body.model, "qwen3-8b");
  assert.equal(request.headers?.["X-Ecosystem-App"], "openmuse");
  const requestId = request.requestId;

  const c1 = 'data: {"choices":[{"delta":{"content":"Hello"}}]}' + "\\n\\n";
  const c2 = 'data: {"choices":[{"delta":{"content":" world"}}]}' + "\\n\\n";

  ws.emitMessage(JSON.stringify({ type: "chunk" as const, requestId, data: c1 }));
  const r1 = await p1;
  assert.equal(r1.done, false);
  assert.equal(r1.value, c1);

  const p2 = iterator.next();
  ws.emitMessage(JSON.stringify({ type: "chunk" as const, requestId, data: c2 }));
  const r2 = await p2;
  assert.equal(r2.done, false);
  assert.equal(r2.value, c2);

  const p3 = iterator.next();
  ws.emitMessage(JSON.stringify({ type: "done" as const, requestId }));
  const r3 = await p3;
  assert.equal(r3.done, true);
});

test("forward propagates device error messages", async () => {
  const relay = new LocalAiRelay(testConfig);
  const ws = new MockWebSocket();
  relay.register("device-1", "owner-1", mockWs(ws));

  const controller = new AbortController();
  const gen = relay.forward("device-1", { model: "qwen3-8b" }, undefined, controller.signal);
  const iterator = gen[Symbol.asyncIterator]();

  const p1 = iterator.next();
  const request = JSON.parse(ws.sent[ws.sent.length - 1]!);
  const requestId = request.requestId;

  ws.emitMessage(
    JSON.stringify({
      type: "error" as const,
      requestId,
      status: 503,
      message: "model not loaded",
    }),
  );

  await assert.rejects(p1, /model not loaded/);
});

test("forward to an unreachable device throws", async () => {
  const relay = new LocalAiRelay(testConfig);
  const controller = new AbortController();

  await assert.rejects(
    (async () => {
      for await (const _ of relay.forward(
        "no-such-device",
        { model: "qwen3-8b" },
        undefined,
        controller.signal,
      )) {
        // drain
      }
    })(),
    /not connected/,
  );
});

test("forward aborts on signal and sends cancel", async () => {
  const relay = new LocalAiRelay(testConfig);
  const ws = new MockWebSocket();
  relay.register("device-1", "owner-1", mockWs(ws));

  const controller = new AbortController();
  const gen = relay.forward("device-1", { model: "qwen3-8b" }, undefined, controller.signal);
  const iterator = gen[Symbol.asyncIterator]();

  const p1 = iterator.next();
  assert.ok(ws.sent.length > 0);
  controller.abort();
  await assert.rejects(p1, /aborted/);

  const lastSent = ws.sent[ws.sent.length - 1]!;
  const cancel = JSON.parse(lastSent);
  assert.equal(cancel.type, "cancel");
});

test("device that has not ponged within the timeout is unreachable", async () => {
  const relay = new LocalAiRelay({ ...testConfig, localaiHeartbeatTimeoutMs: 50 });

  const ws = new MockWebSocket();
  relay.register("device-1", "owner-1", mockWs(ws));
  assert.equal(relay.isReachable("device-1"), true);

  await new Promise((r) => setTimeout(r, 80));
  assert.equal(relay.isReachable("device-1"), false);
});

test("pong resets the heartbeat timer", async () => {
  const relay = new LocalAiRelay({ ...testConfig, localaiHeartbeatTimeoutMs: 100 });
  const ws = new MockWebSocket();
  relay.register("device-1", "owner-1", mockWs(ws));
  assert.equal(relay.isReachable("device-1"), true);

  // 80 ms in — still within 100 ms window.
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(relay.isReachable("device-1"), true);

  // Pong resets the 100 ms timer.
  ws.emitMessage(JSON.stringify({ type: "pong" } as RelayMessage));
  assert.equal(relay.isReachable("device-1"), true);

  // 80 ms after pong — still within window.
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(relay.isReachable("device-1"), true);

  // 80 ms more — 160 ms total since last pong, past 100 ms threshold.
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(relay.isReachable("device-1"), false);
});
