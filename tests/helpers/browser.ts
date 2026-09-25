import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Auth } from "../../apps/server/src/auth.ts";
import { BrowserService } from "../../apps/server/src/browser.ts";
import type { Config } from "../../apps/server/src/config.ts";
import { createStore } from "../../apps/server/src/db.ts";
import { Files } from "../../apps/server/src/files.ts";

export async function browserFixture(
  t: TestContext,
  handle: (path: string, body: Record<string, unknown>) => { status?: number; data: unknown },
) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const result = handle(request.url ?? "", body);
    response.writeHead(result.status ?? 200, { "content-type": "application/json" });
    response.end(JSON.stringify(result.data));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const directory = await mkdtemp(join(tmpdir(), "openmuse-browser-service-"));
  const db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    workerUrl: `http://127.0.0.1:${address.port}`,
    workerToken: "test-worker-token-at-least-32-characters",
  };
  const auth = new Auth(db, config, "test-signing-key");
  const service = new BrowserService(db, config, auth, new Files(db, config, auth));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { db, service, config };
}
