import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { McpService } from "../apps/server/src/mcp.ts";

test("MCP discovery, encrypted settings and read-only tool policy", async () => {
  const db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: ".openmuse",
    agentBackend: "sample",
    intelligenceApiKey: "test",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    encryptionKey: randomBytes(32).toString("base64"),
  };
  const mcp = new McpService(db, config);
  try {
    const server = await mcp.add("owner", {
      name: "Local test",
      transport: "stdio",
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/mcp-stdio.mjs", import.meta.url))],
      env: { TEST_SECRET: "never-send-to-client" },
    });
    assert.doesNotMatch(JSON.stringify(await mcp.list("owner")), /never-send-to-client/);
    const connected = await mcp.connect("owner", server.id);
    assert.equal(connected.server?.tools.length, 3);
    assert.equal(connected.server?.status, "connected");
    await assert.rejects(mcp.call("owner", server.id, "echo", { text: "hello" }), /not enabled/);
    await assert.rejects(
      mcp.enable("owner", server.id, { tools: ["write_something"] }),
      /read-only/,
    );
    await mcp.enable("owner", server.id, { tools: ["echo", "server_proof"] });
    const result = await mcp.call("owner", server.id, "echo", { text: "hello" });
    assert.match(JSON.stringify(result), /hello/);
    const proof = await mcp.call("owner", server.id, "server_proof", {});
    assert.match(JSON.stringify(proof), /proof:[0-9a-f]{32}/);
    await mcp.remove("owner", server.id);
    assert.equal((await mcp.list("owner")).length, 0);
  } finally {
    await db.close();
  }
});
