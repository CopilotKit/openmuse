import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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

test("real Chromium lists page controls and performs only safe or confirmed actions", {
  timeout: 90_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-actions-"));
  const browser = await createBrowserManager({ dataDir });
  const id = randomUUID();
  const byName = async (name: RegExp) => {
    const found = (await browser.elements(id)).elements.find((element) => name.test(element.name));
    assert(found, `element ${name} is listed`);
    return found;
  };
  try {
    await browser.create(id, "https://httpbin.org/forms/post");
    const customer = await byName(/Customer name/);
    assert.equal(customer.role, "textbox");
    const submit = await byName(/Submit order/);
    assert.equal(submit.needsConfirmation, true);
    const typed = await browser.act(id, { action: "type", ref: customer.ref, text: "Test Person" });
    assert.equal(typed.target, "Customer name:");
    assert.equal((await byName(/Customer name/)).value, "Test Person");
    const bacon = await byName(/^Bacon$/);
    await browser.act(id, { action: "check", ref: bacon.ref, checked: true });
    assert.equal((await byName(/^Bacon$/)).checked, true);
    await assert.rejects(
      browser.act(id, { action: "type", ref: customer.ref, text: "Again", submit: true }),
      { code: "CONFIRMATION_REQUIRED" },
      "Enter in a form with a consequential button waits for confirmation",
    );
    await assert.rejects(
      browser.act(id, { action: "click", ref: (await byName(/Submit order/)).ref }),
      { code: "CONFIRMATION_REQUIRED" },
    );
    assert.equal((await browser.read(id)).url, "https://httpbin.org/forms/post");
    const sent = await browser.act(id, {
      action: "click",
      ref: (await byName(/Submit order/)).ref,
      confirmed: true,
    });
    assert.equal(sent.url, "https://httpbin.org/post");
    assert.match((await browser.read(id)).text, /Test Person/);

    await browser.navigate(id, "https://github.com/login");
    const password = (await browser.elements(id)).elements.find((element) => element.sensitive);
    assert(password, "the password field is marked sensitive");
    assert.equal(password.value, undefined, "sensitive values are never returned");
    await assert.rejects(
      browser.act(id, { action: "type", ref: password.ref, text: "not-a-password" }),
      { code: "SENSITIVE_FIELD" },
    );
    await assert.rejects(browser.act(id, { action: "click", ref: 9999 }), {
      code: "ELEMENT_NOT_FOUND",
    });
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
