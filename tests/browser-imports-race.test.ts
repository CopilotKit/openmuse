import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { Auth } from "../apps/server/src/auth.ts";
import { BrowserService } from "../apps/server/src/browser.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { Files } from "../apps/server/src/files.ts";
import type { BrowserSession } from "../packages/domain/src/index.ts";

const sessionId = "00000000-0000-4000-8000-000000000001";
const downloadId = "00000000-0000-4000-8000-000000000002";
const savedSession: BrowserSession = {
  id: sessionId,
  title: "Saved page",
  url: "https://example.com/",
  status: "active",
  updatedAt: "2026-09-27T00:00:00.000Z",
};

test("concurrent browser imports import each download exactly once", async (t) => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const pdfBytes = Buffer.from(await pdf.save());
  const server = createServer((request, response) => {
    if (request.url === `/sessions/${sessionId}/downloads`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          downloads: [
            {
              id: downloadId,
              name: "notes.pdf",
              size: pdfBytes.length,
              mimeType: "application/pdf",
            },
          ],
          failures: [],
        }),
      );
    } else if (request.url === `/sessions/${sessionId}/downloads/${downloadId}`) {
      response.writeHead(200, { "content-type": "application/pdf" });
      response.end(pdfBytes);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const directory = await mkdtemp(join(tmpdir(), "openmuse-imports-race-"));
  const db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
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

  await db.put("owner", "browsers", savedSession);
  const [first, second] = await Promise.all([
    service.imports("owner", sessionId),
    service.imports("owner", sessionId),
  ]);
  assert.equal(first.files.length, 1);
  assert.equal(second.files.length, 1);
  assert.equal(first.files[0].id, second.files[0].id, "both callers resolve to the same file");
  assert.equal(
    (await db.list("owner", "files")).length,
    1,
    "the download is imported exactly once",
  );
});
