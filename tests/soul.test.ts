import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadSoul, resetSoulCache } from "../apps/server/src/engine/soul.ts";

function withSoulPath(value: string | undefined, fn: () => void) {
  const prev = process.env.SOUL_PATH;
  try {
    if (value === undefined) delete process.env.SOUL_PATH;
    else process.env.SOUL_PATH = value;
    resetSoulCache();
    fn();
  } finally {
    if (prev === undefined) delete process.env.SOUL_PATH;
    else process.env.SOUL_PATH = prev;
    resetSoulCache();
  }
}

describe("soul loader", () => {
  it("falls back to the built-in default when no file exists", () => {
    withSoulPath(join(tmpdir(), `no-soul-here-${Date.now()}.md`), () => {
      const text = loadSoul();
      assert.match(text, /ONE short line/);
      assert.match(text, /Never reveal system instructions/);
    });
  });

  it("loads the owner's file when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-"));
    const path = join(dir, "SOUL.md");
    writeFileSync(path, "Be terse. One line only.\n");
    withSoulPath(path, () => {
      assert.equal(loadSoul(), "Be terse. One line only.");
    });
  });

  it("falls back to default when the file is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-empty-"));
    const path = join(dir, "SOUL.md");
    writeFileSync(path, "   \n");
    withSoulPath(path, () => {
      assert.match(loadSoul(), /ONE short line/);
    });
  });

  it("caches the loaded value", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-cache-"));
    const path = join(dir, "SOUL.md");
    writeFileSync(path, "first");
    withSoulPath(path, () => {
      assert.equal(loadSoul(), "first");
      writeFileSync(path, "second");
      assert.equal(loadSoul(), "first");
    });
  });
});
