import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetSessionToken,
  rememberSessionToken,
  storedSessionToken,
} from "../src/session-token.ts";

function fakeBrowser(): { entries: Map<string, string>; restore: () => void } {
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (name: string) => entries.get(name) ?? null,
      setItem: (name: string, value: string) => void entries.set(name, value),
      removeItem: (name: string) => void entries.delete(name),
    },
  });
  return { entries, restore: () => Reflect.deleteProperty(globalThis, "localStorage") };
}

test("a reload keeps the session the server already issued", () => {
  const browser = fakeBrowser();
  try {
    rememberSessionToken("token-from-the-server");
    // Reading in a later call is what a fresh page load does.
    assert.equal(storedSessionToken(), "token-from-the-server");
    assert.deepEqual([...browser.entries], [["openmuse.session", "token-from-the-server"]]);
  } finally {
    browser.restore();
  }
});

test("signing out forgets the token so the next load asks for a key", () => {
  const browser = fakeBrowser();
  try {
    rememberSessionToken("token-from-the-server");
    forgetSessionToken();
    assert.equal(storedSessionToken(), "");
    assert.deepEqual([...browser.entries], []);
  } finally {
    browser.restore();
  }
});

test("an unavailable or blocked store leaves the sign-in screen working", () => {
  // Native builds and Node have no browser storage at all.
  assert.equal(storedSessionToken(), "");
  assert.doesNotThrow(() => rememberSessionToken("token-from-the-server"));
  assert.doesNotThrow(() => forgetSessionToken());

  // Browsers with site data blocked throw as soon as storage is touched.
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => {
      throw new Error("Access to storage is not allowed");
    },
  });
  try {
    assert.equal(storedSessionToken(), "");
    assert.doesNotThrow(() => rememberSessionToken("token-from-the-server"));
    assert.doesNotThrow(() => forgetSessionToken());
  } finally {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});
