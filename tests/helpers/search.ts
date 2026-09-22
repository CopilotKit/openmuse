import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { TestContext } from "node:test";

type Rpc = { id?: number; method?: string; params?: Record<string, unknown> };
type Reply = {
  status?: number;
  headers?: Record<string, string>;
  result?: unknown;
  error?: object;
};
export const searchSource = {
  url: "https://example.org/research",
  title: "Observed research",
  excerpts: ["Useful evidence returned by search."],
  publish_date: "2026-09-01",
};

// Exercise the real MCP client against a disposable server, without changing production config.
export async function searchFixture(t: TestContext, handle?: (rpc: Rpc) => Reply | Promise<Reply>) {
  const requests: { rpc: Rpc; headers: IncomingHttpHeaders }[] = [];
  const paths: string[] = [];
  const server = createServer(async (request, response) => {
    paths.push(request.url ?? "");
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc: Rpc = JSON.parse(body);
    requests.push({ rpc, headers: request.headers });
    if (rpc.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const supplied = await handle?.(rpc);
    const result =
      supplied?.result ??
      (rpc.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1.0.0" },
          }
        : rpc.method === "tools/list"
          ? { tools: [{ name: "web_search", inputSchema: { type: "object" } }] }
          : {
              content: [{ type: "text", text: JSON.stringify({ results: [searchSource] }) }],
              structuredContent: { results: [searchSource] },
            });
    response.writeHead(supplied?.status ?? 200, {
      "content-type": "application/json",
      ...supplied?.headers,
    });
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        ...(supplied?.error ? { error: supplied.error } : { result }),
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === "https://search.parallel.ai/mcp") {
      return originalFetch(`http://127.0.0.1:${address.port}/mcp`, init);
    }
    return originalFetch(url, init);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { requests, paths, url: `http://127.0.0.1:${address.port}` };
}
