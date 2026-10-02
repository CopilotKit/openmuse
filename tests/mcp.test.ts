import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { McpService } from "../apps/server/src/mcp.ts";
import { REMOTE_TOKEN, startRecordingOrigin, startRemoteMcp } from "./fixtures/mcp-remote.ts";

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

test("MCP discovery, encrypted settings and read-only tool policy", async () => {
  const db = await createStore();
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

test("remote MCP over Streamable HTTP and legacy SSE honors headers and the read-only policy", async () => {
  const remote = await startRemoteMcp();
  const db = await createStore();
  const mcp = new McpService(db, config);
  try {
    for (const input of [
      { name: "Remote HTTP", transport: "http" as const, url: remote.httpUrl },
      { name: "Remote SSE", transport: "sse" as const, url: remote.sseUrl },
    ]) {
      const server = await mcp.add("owner", {
        ...input,
        headers: { Authorization: `Bearer ${REMOTE_TOKEN}` },
      });
      assert.doesNotMatch(JSON.stringify(await mcp.list("owner")), new RegExp(REMOTE_TOKEN));
      const connected = await mcp.connect("owner", server.id);
      assert.equal(connected.server?.status, "connected", input.transport);
      assert.deepEqual(
        connected.server?.tools.map((tool) => [tool.name, tool.readOnly]),
        [
          ["echo", true],
          ["server_proof", true],
          ["write_something", false],
        ],
      );
      await assert.rejects(
        mcp.enable("owner", server.id, { tools: ["write_something"] }),
        /read-only/,
      );
      await assert.rejects(
        mcp.call("owner", server.id, "echo", { text: input.transport }),
        /not enabled/,
      );
      await mcp.enable("owner", server.id, { tools: ["echo", "server_proof"] });
      const result = await mcp.call("owner", server.id, "echo", { text: input.transport });
      assert.match(JSON.stringify(result), new RegExp(input.transport));
      const proof = await mcp.call("owner", server.id, "server_proof", {});
      assert.match(JSON.stringify(proof), /proof:[0-9a-f]{32}/);
      // A server that stops marking an enabled tool read-only loses it on the next connect.
      remote.readOnly.echo = false;
      const reconnected = await mcp.connect("owner", server.id);
      assert.deepEqual(reconnected.server?.enabledTools, ["server_proof"]);
      await assert.rejects(mcp.call("owner", server.id, "echo", { text: "x" }), /not enabled/);
      remote.readOnly.echo = true;
      await mcp.remove("owner", server.id);
    }
    assert.equal((await mcp.list("owner")).length, 0);
  } finally {
    await db.close();
    await remote.close();
  }
});

const SECRET = "mcp-only-secret";
const json = (res: import("node:http").ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

test("configured MCP headers never reach a separate OAuth origin or discovery documents", async () => {
  const auth = await startRecordingOrigin((req, res, origin) => {
    if (req.url === "/.well-known/oauth-authorization-server")
      return json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    if (req.url === "/register" && req.method === "POST")
      return json(res, 201, { client_id: "test-client", redirect_uris: [] });
    res.writeHead(404).end();
  });
  const server = await startRecordingOrigin((req, res, origin) => {
    if (req.url?.startsWith("/.well-known/oauth-protected-resource"))
      return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [auth.origin] });
    res
      .writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      })
      .end();
  });
  const db = await createStore();
  const mcp = new McpService(db, config);
  try {
    const added = await mcp.add("owner", {
      name: "OAuth remote",
      transport: "http",
      url: `${server.origin}/mcp`,
      headers: { "X-Api-Key": SECRET },
    });
    const connected = await mcp.connect("owner", added.id);
    assert.match(connected.authorizationUrl ?? "", new RegExp(`^${auth.origin}/authorize`));
    const mcpRequests = server.requests.filter((r) => r.path === "/mcp");
    assert.ok(mcpRequests.length > 0);
    assert.ok(mcpRequests.every((r) => r.headers["x-api-key"] === SECRET));
    const discovery = server.requests.filter((r) => r.path.startsWith("/.well-known/"));
    assert.ok(discovery.length > 0);
    assert.ok(discovery.every((r) => !("x-api-key" in r.headers)));
    assert.ok(auth.requests.some((r) => r.path === "/register"));
    assert.ok(auth.requests.every((r) => !("x-api-key" in r.headers)));
  } finally {
    await db.close();
    await server.close();
    await auth.close();
  }
});

test("a redirected MCP request is refused instead of carrying configured headers elsewhere", async () => {
  const elsewhere = await startRecordingOrigin((_req, res) => res.writeHead(404).end());
  const server = await startRecordingOrigin((req, res) =>
    res.writeHead(307, { location: `${elsewhere.origin}${req.url}` }).end(),
  );
  const db = await createStore();
  const mcp = new McpService(db, config);
  try {
    for (const input of [
      { name: "Redirecting HTTP", transport: "http" as const, url: `${server.origin}/mcp` },
      { name: "Redirecting SSE", transport: "sse" as const, url: `${server.origin}/sse` },
    ]) {
      const added = await mcp.add("owner", { ...input, headers: { "X-Api-Key": SECRET } });
      await assert.rejects(mcp.connect("owner", added.id), /redirected/);
    }
    assert.ok(server.requests.length >= 2);
    assert.ok(server.requests.every((r) => r.headers["x-api-key"] === SECRET));
    assert.equal(elsewhere.requests.length, 0);
  } finally {
    await db.close();
    await server.close();
    await elsewhere.close();
  }
});
