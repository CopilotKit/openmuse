import assert from "node:assert/strict";
import test from "node:test";
import type { Cookie } from "@cloudflare/puppeteer";
import {
  type BrowserCheckpoint,
  CHECKPOINT_LIMIT,
  checkpointInfo,
  cookieParameters,
  encodeCheckpoint,
  restorableCookies,
} from "../src/checkpoint";
import { DemoError } from "../src/core";

const profile: BrowserCheckpoint = {
  version: 1,
  savedAt: "2026-10-19T14:00:00Z",
  title: "Saved page",
  url: "https://shop.com/item?q=headphones",
  cookies: [{ name: "session", value: "private-cookie", url: "https://shop.com/", httpOnly: true }],
  storage: {
    origin: "https://shop.com",
    local: [["login", "private-storage"]],
    session: [["draft", "private-session"]],
    scrollX: 0,
    scrollY: 250,
  },
};

test("checkpoint preserves private state while UI metadata excludes credentials", () => {
  assert.deepEqual(JSON.parse(encodeCheckpoint(profile)), profile);
  const info = checkpointInfo(profile);
  assert.equal(info.cookieCount, 1);
  assert.equal(info.storageItems, 2);
  assert.equal(info.url, profile.url);
  for (const value of ["private-cookie", "private-storage", "private-session"])
    assert.equal(JSON.stringify(info).includes(value), false);
});

test("oversized UTF-8 checkpoints and cross-origin capture races fail before persistence", () => {
  assert.throws(
    () =>
      encodeCheckpoint({
        ...profile,
        storage: {
          ...profile.storage,
          local: [["large", "中".repeat(CHECKPOINT_LIMIT / 2)]],
        },
      }),
    (error: unknown) => error instanceof DemoError && error.code === "checkpoint_too_large",
  );
  assert.throws(
    () =>
      encodeCheckpoint({
        ...profile,
        storage: {
          ...profile.storage,
          origin: "https://other-shop.com",
        },
      }),
    (error: unknown) => error instanceof DemoError && error.code === "checkpoint_changed",
  );
  assert.throws(() => encodeCheckpoint({ ...profile, url: "http://127.0.0.1/private" }), DemoError);
});

test("restore excludes expired cookies and retains live/session cookies", () => {
  const cookies = [
    { name: "expired", value: "old", expires: 10 },
    { name: "session", value: "valid" },
    { name: "live", value: "valid", expires: 30 },
  ];
  assert.deepEqual(
    restorableCookies(cookies, 20).map((cookie) => cookie.name),
    ["session", "live"],
  );
});

test("cookie restore preserves host-only, HttpOnly, secure, domain and session semantics", () => {
  const cookie: Cookie = {
    name: "__Host-session",
    value: "secret",
    domain: "shop.com",
    path: "/",
    httpOnly: true,
    secure: true,
    expires: -1,
    session: true,
    size: 10,
    sameSite: "Lax",
  };
  const saved = cookieParameters(cookie);
  assert.equal(saved.url, "https://shop.com/");
  assert.equal(saved.domain, undefined);
  assert.equal(saved.expires, undefined);
  assert.equal(saved.httpOnly, true);
  assert.equal(saved.secure, true);
  assert.equal(saved.sameSite, "Lax");
  const domain = cookieParameters({
    ...cookie,
    name: "session",
    domain: ".shop.com",
    expires: 300,
  });
  assert.equal(domain.url, undefined);
  assert.equal(domain.domain, ".shop.com");
  assert.equal(domain.expires, 300);
});
