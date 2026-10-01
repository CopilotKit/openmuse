import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBrowserManager } from "../src/browser.ts";

// The sandbox resolver hijacks DNS, so resolve real addresses over HTTPS and
// navigate by IP literal (the worker only allows public destinations). A 403
// from the edge still counts as a successful navigation for page.goto.
async function candidateUrls(): Promise<string[]> {
  const urls: string[] = [];
  for (const hostname of ["example.com", "example.org"]) {
    try {
      const response = await fetch(
        `https://1.1.1.1/dns-query?name=${hostname}&type=A`,
        { headers: { accept: "application/dns-json" } },
      );
      const body = (await response.json()) as {
        Answer?: { data?: string }[];
      };
      for (const answer of body.Answer ?? []) {
        if (typeof answer.data === "string") urls.push(`http://${answer.data}/`);
      }
    } catch {
      // Ignore; other candidates may still work.
    }
  }
  return [...new Set(urls)];
}

test(
  "closeSession releases the session slot when cookie persistence fails",
  { timeout: 120_000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-close-"));
    const browser = await createBrowserManager({ dataDir, maxSessions: 1 });
    const urls = await candidateUrls();
    assert.ok(urls.length > 0, "no candidate navigation URLs resolved");
    const id = randomUUID();
    const next = randomUUID();
    // A failed navigation attempt cleans up after itself; retry across candidates.
    let url = urls[0]!;
    let created = false;
    for (const candidate of urls) {
      try {
        await browser.create(id, candidate);
        url = candidate;
        created = true;
        break;
      } catch (error) {
        if ((error as { code?: string })?.code !== "NAVIGATION_FAILED") throw error;
      }
    }
    assert.ok(created, "could not navigate to any candidate URL");
    try {
      // Sabotage cookie persistence the way a crashed browser does: storageState()
      // must write a file at this path, but a directory sits there instead.
      await mkdir(join(dataDir, id, "storage.json"), { recursive: true });
      await browser.closeSession(id);
      assert.equal(
        browser.list().find((s) => s.id === id)?.status,
        "closed",
        "the session must read back as closed",
      );
      // The slot is free again even with maxSessions: 1.
      const reopened = await browser.create(next, url);
      assert.equal(reopened.status, "active");
      await browser.closeSession(next);
    } finally {
      await browser.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
