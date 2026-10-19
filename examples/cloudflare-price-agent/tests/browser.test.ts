import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createContext, runInContext } from "node:vm";
import puppeteer, { type CookieParam } from "@cloudflare/puppeteer";
import { type BrowserStatus, DemoBrowser } from "../src/browser";
import { type BrowserCheckpoint, encodeCheckpoint } from "../src/checkpoint";
import { DemoError } from "../src/core";

class WebStorage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  clear() {
    this.values.clear();
  }
}

// Simulate the browser protocol boundary without opening a browser or touching the UI.
class Page {
  address = "about:blank";
  localStorage = new WebStorage();
  sessionStorage = new WebStorage();
  scripts = new Map<string, { source: string; args: unknown[] }>();
  context = createContext({});
  failNavigation = false;
  scroll = { x: 0, y: 0 };
  constructor(readonly browser: Browser) {}
  url() {
    return this.address;
  }
  isClosed() {
    return false;
  }
  async setViewport() {}
  async setRequestInterception() {}
  removeAllListeners() {}
  on() {}
  async title() {
    return "Checkpoint fixture";
  }
  async screenshot() {
    return "ZmFrZS1pbWFnZQ==";
  }
  async waitForNetworkIdle() {}
  async goto(address: string) {
    if (this.failNavigation) throw new Error("Navigation failed");
    const url = new URL(address);
    this.address = address;
    const window = {
      top: null as unknown,
      scrollTo: (x: number, y: number) => {
        this.scroll = { x, y };
      },
    };
    window.top = window;
    const body = {};
    Object.defineProperty(body, "innerText", {
      get: () =>
        [
          this.browser.cookies[0]?.value,
          this.localStorage.getItem("marker"),
          this.sessionStorage.getItem("marker"),
        ].join(" "),
    });
    this.context = createContext({
      window,
      location: { origin: url.origin },
      document: { title: "Checkpoint fixture", body, querySelectorAll: () => [] },
      localStorage: this.localStorage,
      sessionStorage: this.sessionStorage,
      scrollX: this.scroll.x,
      scrollY: this.scroll.y,
      TextEncoder,
    });
    for (const script of this.scripts.values()) this.execute(script.source, script.args);
  }
  execute(source: string, args: unknown[]) {
    this.context.argumentsForTest = args;
    return runInContext(`(${source})(...argumentsForTest)`, this.context);
  }
  async evaluate(fn: (...args: never[]) => unknown, arg?: unknown) {
    return this.execute(fn.toString(), arg === undefined ? [] : [arg]);
  }
  async evaluateOnNewDocument(fn: (...args: never[]) => unknown, ...args: unknown[]) {
    const identifier = crypto.randomUUID();
    this.scripts.set(identifier, { source: fn.toString(), args });
    return { identifier };
  }
  async removeScriptToEvaluateOnNewDocument(identifier: string) {
    this.scripts.delete(identifier);
  }
  async createCDPSession() {
    return {
      detach: async () => {},
      send: async (method: string, input?: { cookies: CookieParam[] }) => {
        if (method === "Storage.setCookies") {
          this.browser.cookies = structuredClone(input?.cookies ?? []);
          return {};
        }
        if (method === "Storage.getCookies")
          return {
            cookies: this.browser.cookies.map((cookie) => ({
              ...cookie,
              domain: cookie.domain ?? new URL(cookie.url ?? "https://shop.com").hostname,
              path: cookie.path ?? "/",
              expires: cookie.expires ?? -1,
            })),
          };
        throw new Error("Unexpected protocol method");
      },
    };
  }
}

class Browser {
  connected = true;
  alive = true;
  id = crypto.randomUUID();
  cookies: CookieParam[] = [];
  page = new Page(this);
  isConnected() {
    return this.connected && this.alive;
  }
  sessionId() {
    return this.id;
  }
  async pages() {
    return [this.page];
  }
  async newPage() {
    return this.page;
  }
  async close() {
    this.connected = false;
    this.alive = false;
  }
  async disconnect() {
    this.connected = false;
  }
}

function harness(t: TestContext) {
  const browsers: Browser[] = [];
  const profiles = new Map<string, BrowserCheckpoint>();
  const failures: string[] = [];
  const state: { browser: BrowserStatus | null } = { browser: null };
  let failNextNavigation = false;
  t.mock.method(puppeteer, "launch", async () => {
    const browser = new Browser();
    browser.page.failNavigation = failNextNavigation;
    browsers.push(browser);
    return browser;
  });
  const connects = t.mock.method(puppeteer, "connect", async (_binding: unknown, id: string) => {
    const browser = browsers.find((item) => item.id === id && item.alive);
    if (!browser) throw new Error("404 session not found");
    browser.connected = true;
    return browser;
  });
  const binding = {
    fetch: async () => new Response(),
    getSession: async (id: string) =>
      browsers.some((browser) => browser.id === id && browser.alive) ? { sessionId: id } : null,
  };
  const driver = new DemoBrowser(
    binding,
    () => state.browser,
    (value) => {
      state.browser = value;
    },
    () => {},
    async () => {},
    {
      read: (id) => profiles.get(id) ?? null,
      write: (id, value) => {
        profiles.set(id, JSON.parse(encodeCheckpoint(value)));
      },
      failed: (_id, message) => {
        failures.push(message);
      },
    },
  );
  return {
    driver,
    profiles,
    state,
    browsers,
    failures,
    connects,
    failNext: () => {
      failNextNavigation = true;
    },
    current: () => {
      const browser = browsers.at(-1);
      if (!browser) throw new Error("No browser was launched");
      return browser;
    },
  };
}

async function seed(t: TestContext) {
  const h = harness(t);
  await h.driver.action("chat-a", "browser_navigate", { url: "https://shop.com/item" });
  const browser = h.current();
  browser.cookies = [
    {
      name: "__Host-session",
      value: "private-marker",
      url: "https://shop.com/",
      httpOnly: true,
      secure: true,
    },
  ];
  browser.page.localStorage.setItem("marker", "private-marker");
  browser.page.sessionStorage.setItem("marker", "private-marker");
  browser.page.scroll = { x: 0, y: 350 };
  browser.page.context.scrollY = 350;
  await h.driver.save("chat-a");
  return h;
}

test("disconnect detaches control, viewer polling stays detached, reconnect retains the original session", async (t) => {
  const h = await seed(t);
  const id = h.state.browser?.sessionId;
  await h.current().page.goto("https://shop.com/item?q=manual");
  await h.driver.save("chat-a");
  assert.equal(h.state.browser?.url, "https://shop.com/item?q=manual");
  await h.driver.disconnect("chat-a");
  assert.equal(h.current().alive, true);
  assert.equal(h.state.browser?.connection, "disconnected");
  assert.equal(await h.driver.liveView("chat-a"), null);
  assert.equal(h.connects.mock.callCount(), 0);
  assert.equal((await h.driver.reconnect("chat-a")).mode, "reconnected");
  assert.equal(h.state.browser?.sessionId, id);
  assert.equal(h.connects.mock.callCount(), 1);
});

test("closing and restoring creates a fresh browser with HttpOnly cookies and both web stores", async (t) => {
  const h = await seed(t);
  const old = h.current();
  await h.driver.close();
  assert.equal(old.alive, false);
  assert.equal((await h.driver.reconnect("chat-a")).mode, "restored");
  const current = h.current();
  assert.notEqual(current.id, old.id);
  assert.equal(current.cookies[0]?.value, "private-marker");
  assert.equal(current.cookies[0]?.httpOnly, true);
  assert.equal(current.page.localStorage.getItem("marker"), "private-marker");
  assert.equal(current.page.sessionStorage.getItem("marker"), "private-marker");
  assert.equal(current.page.scroll.y, 350);
  assert.equal(current.page.scripts.size, 0);
  current.page.localStorage.clear();
  current.page.sessionStorage.clear();
  await h.driver.action("chat-a", "browser_navigate", { url: "https://shop.com/item" });
  assert.equal(current.page.localStorage.length, 0, "A later reload must not undo a logout");
  assert.equal(h.profiles.get("chat-a")?.storage.local.length, 0);
});

test("expired sessions cannot overwrite a checkpoint with a newly launched blank browser", async (t) => {
  const h = await seed(t);
  const saved = structuredClone(h.profiles.get("chat-a"));
  await h.driver.disconnect("chat-a");
  h.current().alive = false;
  await assert.rejects(
    h.driver.save("chat-a"),
    (error: unknown) => error instanceof DemoError && error.code === "browser_expired",
  );
  assert.equal(h.browsers.length, 1);
  assert.deepEqual(h.profiles.get("chat-a"), saved);
  assert.equal((await h.driver.reconnect("chat-a")).mode, "restored");
  assert.equal(h.browsers.length, 2);
});

test("failed restoration closes the incomplete browser and retains the old checkpoint", async (t) => {
  const h = await seed(t);
  const saved = structuredClone(h.profiles.get("chat-a"));
  await h.driver.close();
  h.failNext();
  await assert.rejects(
    h.driver.reconnect("chat-a"),
    (error: unknown) => error instanceof DemoError && error.code === "checkpoint_restore_failed",
  );
  assert.equal(h.current().alive, false);
  assert.equal(h.state.browser, null);
  assert.deepEqual(h.profiles.get("chat-a"), saved);
});

test("oversized site storage reports a save failure without erasing the last valid checkpoint", async (t) => {
  const h = await seed(t);
  const saved = structuredClone(h.profiles.get("chat-a"));
  h.current().page.localStorage.setItem("large", "中".repeat(200_000));
  await h.driver.read("chat-a");
  assert.ok(h.failures.length > 0);
  assert.deepEqual(h.profiles.get("chat-a"), saved);
  await assert.rejects(h.driver.save("chat-a"), DemoError);
  assert.equal(h.current().alive, true);
});

test("switching conversations saves the old page and isolates the new browser's state", async (t) => {
  const h = await seed(t);
  h.current().page.localStorage.setItem("manual-edit", "unsaved-edit");
  await h.driver.action("chat-b", "browser_navigate", { url: "https://other-shop.com/item" });
  assert.equal(
    h.profiles.get("chat-a")?.storage.local.some(([key]) => key === "manual-edit"),
    true,
  );
  assert.equal(h.profiles.get("chat-b")?.cookies.length, 0);
  assert.equal(h.current().page.localStorage.length, 0);
});

test("Cloudflare rate limiting during recovery returns a controlled error and retains the checkpoint", async (t) => {
  const h = await seed(t);
  const saved = structuredClone(h.profiles.get("chat-a"));
  await h.driver.close();
  t.mock.method(puppeteer, "launch", async () => {
    throw new Error("Unable to create new browser: code: 429: message: Rate limit exceeded");
  });
  await assert.rejects(
    h.driver.reconnect("chat-a"),
    (error: unknown) =>
      error instanceof DemoError && error.status === 429 && error.code === "browser_rate_limited",
  );
  assert.deepEqual(h.profiles.get("chat-a"), saved);
  assert.equal(h.state.browser, null);
});
