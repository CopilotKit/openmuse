import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { capturePdfDownload, readDownloadFailures } from "../apps/worker/src/downloads.ts";
import { createSamplePdf, inspectPdf } from "../packages/integrations/src/pdf.ts";

test("browser PDF downloads accept the same bounded header prefix as PDF imports", async (t) => {
  const pdf = await createSamplePdf();
  for (const prefix of [
    Buffer.alloc(0),
    Buffer.from([0xef, 0xbb, 0xbf, 0x0a]),
    Buffer.alloc(1019, 32),
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "openmuse-pdf-prefix-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const bytes = Buffer.concat([prefix, pdf]);
    assert.equal((await inspectPdf(bytes)).pageCount, 2);
    await capturePdfDownload({
      directory,
      tempDirectory: directory,
      limitReached: false,
      download: {
        suggestedFilename: () => "form.pdf",
        createReadStream: async () =>
          Readable.from([
            bytes.subarray(0, prefix.length + 2),
            bytes.subarray(prefix.length + 2, prefix.length + 4),
            bytes.subarray(prefix.length + 4),
          ]),
        cancel: async () => {},
        delete: async () => {},
      },
    });
    assert.deepEqual(await readDownloadFailures(directory), []);
    const metadataFiles = (await readdir(join(directory, "downloads"))).filter((name) =>
      name.endsWith(".json"),
    );
    assert.equal(metadataFiles.length, 1);
    const metadata = JSON.parse(
      await readFile(join(directory, "downloads", metadataFiles[0]), "utf8"),
    );
    assert.equal(metadata.name, "form.pdf");
    assert.equal(metadata.size, bytes.length);
    assert.deepEqual(await readFile(join(directory, "downloads", `${metadata.id}.pdf`)), bytes);
  }
});

test("browser PDF sniffing rejects late markers and non-ASCII lookalikes", async (t) => {
  for (const bytes of [
    Buffer.concat([Buffer.alloc(1020, 32), Buffer.from("%PDF-1.7")]),
    Buffer.from([0xa5, 0xd0, 0xc4, 0xc6, 0xad]),
    Buffer.from("not a PDF"),
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "openmuse-pdf-invalid-prefix-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await capturePdfDownload({
      directory,
      tempDirectory: directory,
      limitReached: false,
      download: {
        suggestedFilename: () => "invalid.pdf",
        createReadStream: async () => Readable.from([bytes]),
        cancel: async () => {},
        delete: async () => {},
      },
    });
    assert.equal((await readDownloadFailures(directory))[0]?.code, "UNSUPPORTED_DOWNLOAD");
    assert.deepEqual(await readdir(join(directory, "downloads")), []);
  }
});
