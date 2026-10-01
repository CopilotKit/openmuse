import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Auth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import type { Store } from "../apps/server/src/db.ts";
import { createStore } from "../apps/server/src/db.ts";
import { Files } from "../apps/server/src/files.ts";
import { createSamplePdf } from "../packages/integrations/src/pdf.ts";

test("truncating an imported PDF name preserves whole Unicode characters", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-name-"));
  const stored: unknown[] = [];
  const db = {
    put: async (_owner: string, _kind: string, value: unknown) => stored.push(value),
  } as unknown as Store;
  const auth = { sign: () => "https://example.invalid/content" } as unknown as Auth;
  const files = new Files(db, { dataDir } as Config, auth);
  try {
    const bytes = await createSamplePdf();
    for (const name of [`${"a".repeat(179)}😀.pdf`, `${"😀".repeat(181)}.pdf`]) {
      const file = await files.import("fixture", name, bytes, "fixture");
      assert.doesNotThrow(() => encodeURIComponent(file.name));
      assert.ok(file.name.length <= 180);
      assert.equal(file.name, name.startsWith("a") ? "a".repeat(179) : "😀".repeat(90));
    }
    const ordinary = await files.import("fixture", "folder/report.pdf", bytes, "fixture");
    assert.equal(ordinary.name, "report.pdf");
    assert.equal(stored.length, 3);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an imported name crossing the UTF-16 limit is served over the content route", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-name-http-"));
  const db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  const server = await createApp(db, config);
  try {
    const session = await server.app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(session.status, 200);
    const { token } = await session.json();
    const bytes = await createSamplePdf();
    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array(bytes)], `${"a".repeat(179)}😀.pdf`, { type: "application/pdf" }),
    );
    const imported = await server.app.request("/api/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    assert.equal(imported.status, 201, await imported.clone().text());
    const file = await imported.json();
    const content = await server.app.request(file.url);
    assert.equal(content.status, 200, await content.clone().text());
    assert.equal(content.headers.get("content-type"), "application/pdf");
    assert.equal(
      content.headers.get("content-disposition"),
      `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    assert.deepEqual(new Uint8Array(await content.arrayBuffer()), bytes);
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
