import assert from "node:assert/strict";
import test from "node:test";
import { McpClient } from "../apps/server/src/mcp/client.ts";
import { McpManager } from "../apps/server/src/mcp/manager.ts";
import type { McpServerConfig } from "../apps/server/src/mcp/types.ts";

test("MCP Gateway client and manager", async (t) => {
  // Test 1: Fake in-memory mock client using request override
  await t.test("lists tools and executes tool call", async () => {
    const config: McpServerConfig = {
      id: "mock_postgres",
      name: "Mock Postgres",
      enabled: true,
      transport: "http",
      url: "http://127.0.0.1:9999",
    };

    const client = new McpClient(config);

    // Mock request handler
    client.request = (async (method: string, _params?: Record<string, unknown>) => {
      if (method === "tools/list") {
        return {
          tools: [
            {
              name: "query_database",
              description: "Execute SQL query on Postgres database",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          ],
        };
      }
      if (method === "tools/call") {
        return {
          content: [{ type: "text", text: JSON.stringify([{ id: 1, name: "Alice" }]) }],
        };
      }
      return {};
    }) as any;

    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "query_database");

    const result = await client.callTool("query_database", { query: "SELECT * FROM users" });
    assert.equal(result.content[0].type, "text");
    assert.match(result.content[0].text!, /Alice/);
  });

  // Test 2: McpManager server lifecycle & tool discovery
  await t.test("manager discovers tools and namespaces names", async () => {
    const manager = new McpManager([
      {
        id: "github",
        name: "GitHub Tools",
        enabled: true,
        transport: "http",
      },
    ]);

    // Mock client request
    const client = manager.addServer({
      id: "github",
      name: "GitHub Tools",
      enabled: true,
      transport: "http",
    });

    client.initialize = async () => {};
    client.listTools = async () => [
      {
        name: "create_pull_request",
        description: "Creates a pull request on GitHub",
        inputSchema: { type: "object" },
      },
    ];
    client.callTool = async (_name, args) => ({
      content: [{ type: "text", text: `PR created with args: ${JSON.stringify(args)}` }],
    });

    const count = await manager.syncTools();
    assert.equal(count, 1);

    const discovered = manager.getDiscoveredTools();
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].name, "mcp_github_create_pull_request");

    const execResult = await manager.executeTool("mcp_github_create_pull_request", {
      title: "Fix bug",
    });
    assert.match(execResult.content[0].text, /Fix bug/);

    manager.removeServer("github");
    assert.equal(manager.getDiscoveredTools().length, 0);
  });
});
