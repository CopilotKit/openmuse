import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { createBrowserManager } from "../src/browser.ts";

test("real Chromium cleans failed profiles and restores a saved UUID after worker restart", {
  timeout: 90_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-lifecycle-"));
  let browser = await createBrowserManager({ dataDir });
  const id = randomUUID();
  const failedId = randomUUID();
  try {
    await assert.rejects(
      browser.create(
        failedId,
        "https://httpbin.org/redirect-to?url=http%3A%2F%2F127.0.0.1%3A8790%2Fhealth",
      ),
      { code: "NAVIGATION_FAILED" },
    );
    assert.equal(browser.list().length, 0, "failed creation must release its saved-profile slot");
    assert.equal(
      (await readdir(dataDir)).includes(failedId),
      false,
      "unclaimed profile is removed",
    );
    await browser.create(id, "https://example.com/");
    await browser.closeSession(id);
    const context = await chromium.launchPersistentContext(join(dataDir, id, "profile"), {
      headless: true,
    });
    try {
      const page = await context.newPage();
      await page.goto("https://example.com/");
      await page.evaluate(() => localStorage.setItem("openmuse-profile-test", "retained"));
    } finally {
      await context.close();
    }
    await browser.close();
    browser = await createBrowserManager({ dataDir });
    assert.equal(browser.list()[0]?.status, "closed");
    const reopened = await browser.create(id, "https://example.com/");
    assert.equal(reopened.id, id);
    assert.equal(reopened.title, "Example Domain");
    const read = await browser.read(id);
    assert.match(read.text, /Example Domain/);
    await browser.navigate(id, "https://www.rfc-editor.org/rfc/rfc9110.txt");
    const largeRead = await browser.read(id);
    assert.equal(largeRead.text.length, 100_000);
    assert.equal(largeRead.truncated, true);
    assert.equal(largeRead.url, "https://www.rfc-editor.org/rfc/rfc9110.txt");
    await browser.closeSession(id);
    const state = JSON.parse(await readFile(join(dataDir, id, "storage.json"), "utf8"));
    assert(
      state.origins
        .find((origin: { origin: string }) => origin.origin === "https://example.com")
        ?.localStorage.some(
          (item: { name: string; value: string }) =>
            item.name === "openmuse-profile-test" && item.value === "retained",
        ),
    );
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a download-interrupted navigation clears the previous page and reports the download", {
  timeout: 120_000,
}, async () => {
  // Hermetic: serve a minimal real PDF over plain HTTP on loopback. The SSRF
  // gate only allows ports 80/443 and public IPs, so trust 127.0.0.1 for the
  // duration of the test (Chromium bypasses the egress proxy for loopback).
  const previousTrusted = process.env.BROWSER_TRUSTED_DOMAINS;
  process.env.BROWSER_TRUSTED_DOMAINS = "127.0.0.1";
  const pdf = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%EOF",
    "ascii",
  );
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="stale-check.pdf"',
      "Content-Length": pdf.length,
    });
    res.end(pdf);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(80, "127.0.0.1", () => resolve());
  }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === "EADDRINUSE") return "skip";
    throw error;
  });
  if (!server.listening) {
    process.env.BROWSER_TRUSTED_DOMAINS = previousTrusted ?? "";
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-download-"));
  const browser = await createBrowserManager({ dataDir });
  const id = randomUUID();
  try {
    // Park the session on a normal page first, like the user's xe.com tab.
    await browser.create(id, "https://example.com/");
    // The attachment aborts page.goto with "Download is starting".
    const after = await browser.navigate(id, "http://127.0.0.1/stale-check.pdf");
    assert.equal(after.url, "about:blank", "previous page must be cleared, not left behind");
    assert.ok(after.download, "the preempting download must be reported");
    assert.match(after.download.name, /stale-check\.pdf/);
    assert.equal(after.download.mimeType, "application/pdf");
    const read = await browser.read(id);
    assert.equal(read.url, "about:blank");
    assert.doesNotMatch(read.text, /Example Domain/, "stale page content must not leak into reads");
  } finally {
    if (previousTrusted === undefined) delete process.env.BROWSER_TRUSTED_DOMAINS;
    else process.env.BROWSER_TRUSTED_DOMAINS = previousTrusted;
    await browser.closeSession(id).catch(() => {});
    await browser.close();
    server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("select input drives a native dropdown and rejects empty coordinates", {
  timeout: 90_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-select-"));
  const browser = await createBrowserManager({ dataDir });
  const id = randomUUID();
  try {
    await browser.create(id, "https://the-internet.herokuapp.com/dropdown");
    const snap = await browser.snapshot(id);
    const select = (
      snap.elements as Array<{ tag: string; label: string; x: number; y: number }>
    ).find((el) => el.tag === "select");
    assert.ok(select, "dropdown found in snapshot");
    // Positive: picking a real option completes without error.
    await browser.input(id, { type: "select", x: select.x, y: select.y, option: "Option 1" });
    // Negative: coordinates with no dropdown are rejected.
    await assert.rejects(browser.input(id, { type: "select", x: 5, y: 5, option: "Option 1" }), {
      code: "INVALID_INPUT",
    });
    // Negative: an empty option label is rejected.
    await assert.rejects(
      browser.input(id, { type: "select", x: select.x, y: select.y, option: "" }),
      { code: "INVALID_INPUT" },
    );
  } finally {
    await browser.closeSession(id).catch(() => {});
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
