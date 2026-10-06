import type { IncomingMessage } from "node:http";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { defined } from "../../../packages/backends/src/strict-optional.ts";
import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { createStore } from "./db.ts";

const config = readConfig();
const db = await createStore(
  defined({
    dataDir: `${config.dataDir}/postgres`,
    databaseUrl: config.databaseUrl,
  }),
);
await db.recoverInterruptedActions();
const { app, auth, agent, relay } = await createApp(db, config);
if (config.taskWorkerEnabled) agent.start();
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () =>
  console.log(`OpenMuse ${config.mode} API ready at ${config.publicUrl}`),
);

// ── WebSocket relay for on-device LLM inference ──────────────────
// The phone-side client opens a WebSocket to /api/agent/localai/relay
// using its session token. The server upgrades the TCP connection,
// authenticates it, then hands the socket to LocalAiRelay for inference
// forwarding (server → phone → meaty → phone → server).
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (ws, request: IncomingMessage) => {
  const url = new URL(request.url ?? "", `http://${request.headers.host}`);

  // Only accept connections to the relay endpoint.
  if (url.pathname !== "/api/agent/localai/relay") {
    ws.close(4404, "Not found");
    return;
  }

  const deviceId = url.searchParams.get("deviceId") ?? undefined;
  // The phone sends its session token via the Sec-WebSocket-Protocol header
  // (i.e. as a "protocol" string). This keeps credentials out of the URL
  // and works with the standard DOM WebSocket constructor.
  const rawProtocol = request.headers["sec-websocket-protocol"];
  const token =
    typeof rawProtocol === "string" ? rawProtocol.replace(/^Bearer\s+/i, "") : undefined;

  if (!deviceId || !token) {
    ws.close(4401, "Authentication required");
    return;
  }

  const device = await auth.device(`Bearer ${token}`);
  if (device.deviceId !== deviceId) {
    ws.close(4403, "Device not authorized");
    return;
  }

  relay.register(deviceId, device.owner, ws);
});

server.on("upgrade", (request, socket, head) => {
  // Let the WebSocket library handle the protocol upgrade, then emit
  // the `connection` event that our handler above listens for.
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

const shutdown = () => {
  void wss.close();
  server.close(() => {
    void agent
      .stop()
      .then(() => db.close())
      .then(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
