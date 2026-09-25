import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBrowserManager } from "../src/browser.ts";

test("creating beyond the session cap evicts the least-recently-used session", {
  timeout: 180_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-eviction-"));
  const browser = await createBrowserManager({ dataDir, maxSessions: 2 });
  try {
    const first = randomUUID();
    const second = randomUUID();
    const third = randomUUID();
    await browser.create(first, "https://example.com/");
    await browser.create(second, "https://example.com/");
    // Touch the first session so the second becomes the eviction victim.
    await browser.read(first);
    await browser.create(third, "https://example.com/");
    const byId = new Map(browser.list().map((session) => [session.id, session]));
    assert.equal(byId.get(second)?.status, "closed", "the LRU session is evicted");
    assert.equal(byId.get(first)?.status, "active", "the recently touched session survives");
    assert.equal(byId.get(third)?.status, "active", "the new session is created");
    assert.equal(
      [...byId.values()].filter((session) => session.status === "active").length,
      2,
      "the hard cap on concurrent sessions is unchanged",
    );
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
