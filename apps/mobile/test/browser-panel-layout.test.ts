import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BROWSER_PREVIEW_DEFAULT_COLLAPSED,
  BROWSER_PREVIEW_MAX_HEIGHT_FRACTION,
  BROWSER_PREVIEW_MAX_HEIGHT_PX,
  browserPreviewMaxHeight,
} from "../src/browser-panel-layout.ts";

const here = dirname(fileURLToPath(import.meta.url));
const src = (name: string) => readFileSync(join(here, "..", "src", name), "utf8");

test("preview cap is a fraction of the window height", () => {
  assert.equal(browserPreviewMaxHeight(1000), BROWSER_PREVIEW_MAX_HEIGHT_PX); // min(380, 420)
  assert.equal(browserPreviewMaxHeight(800), 336); // 800 * 0.42
  assert.equal(browserPreviewMaxHeight(430), 181); // 430 * 0.42 = 180.6 -> 181
});

test("preview cap never exceeds the hard pixel ceiling", () => {
  assert.ok(browserPreviewMaxHeight(4000) <= BROWSER_PREVIEW_MAX_HEIGHT_PX);
  assert.ok(browserPreviewMaxHeight(100000) <= BROWSER_PREVIEW_MAX_HEIGHT_PX);
});

test("preview cap keeps a usable minimum on very short viewports", () => {
  assert.ok(browserPreviewMaxHeight(200) >= 120);
});

test("preview cap degrades safely on bad input", () => {
  assert.equal(browserPreviewMaxHeight(0), BROWSER_PREVIEW_MAX_HEIGHT_PX);
  assert.equal(browserPreviewMaxHeight(-50), BROWSER_PREVIEW_MAX_HEIGHT_PX);
  assert.equal(browserPreviewMaxHeight(NaN), BROWSER_PREVIEW_MAX_HEIGHT_PX);
});

test("cap fraction is a real fraction of the viewport", () => {
  assert.ok(BROWSER_PREVIEW_MAX_HEIGHT_FRACTION > 0);
  assert.ok(BROWSER_PREVIEW_MAX_HEIGHT_FRACTION < 1);
});

test("panels start expanded; the cap alone keeps them compact", () => {
  assert.equal(BROWSER_PREVIEW_DEFAULT_COLLAPSED, false);
});

for (const file of ["browser-tool-card.tsx", "computer.tsx"]) {
  test(`${file}: browser preview image is height-capped`, () => {
    const code = src(file);
    assert.match(code, /maxHeight:\s*browserPreviewMaxHeight\(windowHeight\)/);
  });

  test(`${file}: browser panel has an obvious collapse/expand control`, () => {
    const code = src(file);
    assert.match(code, /Collapse browser preview/);
    assert.match(code, /Expand browser preview/);
    assert.match(code, /setCollapsed/);
  });
}
