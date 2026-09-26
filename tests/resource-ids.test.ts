import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { Auth } from "../apps/server/src/auth.ts";
import type { BrowserService } from "../apps/server/src/browser.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { Files, sanitizeFileName } from "../apps/server/src/files.ts";
import { createSamplePdf } from "../packages/integrations/src/pdf.ts";
import { browserFixture } from "./helpers/browser.ts";

let db: Store, app: Awaited<ReturnType<typeof createApp>>["app"], token: string, directory: string;
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-resource-ids-"));
  db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  ({ app } = await createApp(db, config));
  const response = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  token = (await response.json()).token;
});

after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("file names never collapse to an empty display name", () => {
  assert.equal(sanitizeFileName("///"), "document.pdf");
  assert.equal(sanitizeFileName("\u0000\u0001\u007f"), "document.pdf");
  assert.equal(sanitizeFileName(""), "document.pdf");
  assert.equal(sanitizeFileName("C:\\fakepath\\report.pdf"), "report.pdf");
  assert.equal(sanitizeFileName("/tmp/../invoice.pdf"), "invoice.pdf");
  const long = sanitizeFileName(`${"a".repeat(300)}.pdf`);
  assert.ok(long.length <= 180);
  assert.ok(long.length > 0);
});

test("file lookups reject malformed IDs instead of probing storage", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "openmuse-file-id-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const store = await createStore();
  t.after(() => store.close());
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: dir,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
  const files = new Files(store, config, new Auth(store, config, "test-signing-key"));
  for (const id of ["", "not-a-uuid", "../secret", "..\\secret", "a/b", `${"a".repeat(36)}`]) {
    await assert.rejects(files.get("owner", id), { message: /File not found/ });
    await assert.rejects(files.bytes("owner", id), { message: /File not found/ });
  }
  const sample = await createSamplePdf();
  const imported = await files.import("owner", "///", sample, "test");
  assert.equal(imported.name, "document.pdf");
  const roundTrip = await files.bytes("owner", imported.id);
  assert.equal(Buffer.from(roundTrip).subarray(0, 5).toString(), "%PDF-");
});

test("browser sessions reject malformed IDs and non-object input locally", async (t) => {
  const calls: string[] = [];
  const { service } = await browserFixture(t, (path) => {
    calls.push(path);
    return { data: {} };
  });
  for (const id of ["", "not-a-uuid", "../escape", "a/b", "00000000-0000-4000-8000-0000000000zz"]) {
    await assert.rejects(service.get("owner", id), { message: /Browser session not found/ });
  }
  const validId = "00000000-0000-4000-8000-000000000001";
  for (const value of [null, undefined, "click", 42, ["x"]]) {
    await assert.rejects((service as BrowserService).input("owner", validId, value), {
      message: /JSON object/i,
    });
  }
  assert.equal(calls.length, 0, "validation happens before any worker request");
});

test("HTTP routes surface malformed resource IDs as client errors", async () => {
  assert.equal(
    (await app.request("/api/files/not-a-uuid/content", { headers: headers() })).status,
    404,
  );
  assert.equal(
    (await app.request("/api/files/..secret/content", { headers: headers() })).status,
    404,
  );
  assert.equal(
    (
      await app.request("/api/files/not-a-uuid/fill", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ fields: {} }),
      })
    ).status,
    404,
  );
  assert.equal((await app.request("/api/browsers/not-a-uuid", { headers: headers() })).status, 404);
  assert.equal(
    (await app.request("/api/browsers/not-a-uuid/read", { headers: headers() })).status,
    404,
  );
  const draft = await app.request("/api/drafts", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      id: "not-a-uuid",
      to: ["sample@example.com"],
      subject: "Hello",
      body: "World",
    }),
  });
  assert.equal(draft.status, 422);
});
