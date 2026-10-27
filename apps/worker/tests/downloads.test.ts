import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { capturePdfDownload, downloadLimitReached } from "../src/downloads.ts";

test("the session cap admits the twentieth PDF and blocks the twenty-first", () => {
  // pendingCount includes the download being decided, matching the handler,
  // which adds the current transfer to its pending set before evaluating.
  assert.equal(downloadLimitReached(19, 1), false, "the twentieth PDF is allowed");
  assert.equal(downloadLimitReached(20, 1), true, "the twenty-first PDF is blocked");
  assert.equal(downloadLimitReached(0, 1), false);
  assert.equal(downloadLimitReached(20, 0), false, "no pending download decides nothing");
});

test("concurrent downloads at the boundary keep the cap at 20", () => {
  // Both handlers add to the pending set before either decision evaluates, so
  // a racing pair counts each other: at 19 saved both see 21 and are blocked.
  assert.equal(downloadLimitReached(18, 2), false, "two racing at 18 saved: both admitted");
  assert.equal(downloadLimitReached(19, 2), true, "two racing at 19 saved: both blocked");
  assert.equal(downloadLimitReached(18, 3), true, "three racing at 18 saved: all blocked");
});

test("a reached download limit cancels the PDF and records DOWNLOAD_LIMIT", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-downloads-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let cancelled = false;
  await capturePdfDownload({
    directory,
    tempDirectory: join(directory, "tmp"),
    limitReached: true,
    download: {
      suggestedFilename: () => "report.pdf",
      createReadStream: () => {
        throw new Error("a limited download must not be read");
      },
      cancel: async () => {
        cancelled = true;
      },
      delete: async () => {},
    },
  });
  assert.equal(cancelled, true, "the download is cancelled, not captured");
  const outcomes = join(directory, "download-outcomes");
  const files = await readdir(outcomes);
  assert.equal(files.length, 1);
  const outcome = JSON.parse(await readFile(join(outcomes, files[0]), "utf8"));
  assert.equal(outcome.code, "DOWNLOAD_LIMIT");
  assert.match(outcome.message, /20 PDF download limit/);
});

test("a download under the limit is captured instead of cancelled", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-downloads-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let cancelled = false;
  await capturePdfDownload({
    directory,
    tempDirectory: await mkdtemp(join(tmpdir(), "openmuse-tmp-")),
    limitReached: false,
    download: {
      suggestedFilename: () => "report.pdf",
      createReadStream: async () => Readable.from(Buffer.from("%PDF-1.4 fake")),
      cancel: async () => {
        cancelled = true;
      },
      delete: async () => {},
    },
  });
  assert.equal(cancelled, false, "an allowed download must not be cancelled");
  const saved = await readdir(join(directory, "downloads"));
  const metadata = JSON.parse(
    await readFile(
      join(directory, "downloads", saved.find((file) => file.endsWith(".json")) ?? ""),
      "utf8",
    ),
  );
  assert.equal(metadata.name, "report.pdf");
  assert.equal(metadata.mimeType, "application/pdf");
});
