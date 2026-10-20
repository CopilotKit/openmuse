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
  listeners = new Map<string, (...args: never[]) => unknown>();
  elementNode: { tagName: string; textContent: string; attributes: Record<string, string> } | null =
    null;
  elementClicks = 0;
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
  removeAllListeners(event: string) {
    this.listeners.delete(event);
  }
  on(event: string, listener: (...args: never[]) => unknown) {
    this.listeners.set(event, listener);
  }
  async title() {
    return "Checkpoint fixture";
  }
  async screenshot() {
    return "ZmFrZS1pbWFnZQ==";
  }
  async waitForNetworkIdle() {}
  async $(selector: string) {
    if (selector !== '[data-openmuse-ref="0"]' || !this.elementNode) return null;
    const node = this.elementNode;
    return {
      evaluate: async (fn: (...args: never[]) => unknown) =>
        this.execute(fn.toString(), [
          {
            tagName: node.tagName,
            textContent: node.textContent,
            getAttribute: (name: string) => node.attributes[name] ?? null,
            hasAttribute: (name: string) => name in node.attributes,
          },
        ]),
      click: async () => {
        this.elementClicks++;
      },
      dispose: async () => {},
    };
  }
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

test("unknown tools and non-web navigation cannot launch a browser", async (t) => {
  const h = harness(t);
  for (const name of ["read_file", "exec", "browser_evaluate", "browser_read_file"]) {
    await assert.rejects(
      h.driver.action("chat-a", name, { path: "/etc/passwd" }),
      (error: unknown) => error instanceof DemoError && error.code === "blocked_tool",
    );
  }
  for (const url of ["file:///etc/passwd", "chrome://settings/", "http://localhost/"]) {
    await assert.rejects(h.driver.action("chat-a", "browser_navigate", { url }), DemoError);
  }
  assert.equal(h.browsers.length, 0);
  assert.equal(h.state.browser, null);
});

test("installed request handler blocks file and internal requests while retaining web dependencies", async (t) => {
  const h = await seed(t);
  const handler = h.current().page.listeners.get("request");
  assert.ok(handler);
  for (const [url, navigation, expected] of [
    ["https://shop.com/image.png", false, "continue"],
    ["data:image/png;base64,AA==", false, "continue"],
    ["blob:https://shop.com/asset", false, "continue"],
    ["file:///etc/passwd", true, "abort"],
    ["chrome://settings/", true, "abort"],
    ["data:text/html,private", true, "abort"],
    ["http://localhost/", false, "abort"],
  ] as const) {
    let outcome = "";
    Reflect.apply(handler, null, [
      {
        url: () => url,
        isNavigationRequest: () => navigation,
        continue: async () => {
          outcome = "continue";
        },
        abort: async () => {
          outcome = "abort";
        },
      },
    ]);
    assert.equal(outcome, expected, url);
  }
});

test("a page manually changed to a local file cannot be read or acted on by the agent", async (t) => {
  const h = await seed(t);
  h.current().page.address = "file:///etc/passwd";
  await assert.rejects(h.driver.read("chat-a"), DemoError);
  await assert.rejects(h.driver.action("chat-a", "browser_click", { ref: 0 }), DemoError);
  await assert.rejects(h.driver.save("chat-a"), DemoError);
});

test("agent clicks reject file pickers, download links and non-web links before clicking", async (t) => {
  const h = await seed(t);
  const page = h.current().page;
  for (const [tagName, attributes] of [
    ["INPUT", { type: "FILE" }],
    ["A", { href: "https://shop.com/report", download: "report.pdf" }],
    ["A", { href: "file:///etc/passwd" }],
    ["A", { href: "chrome://settings/" }],
    ["A", { href: "javascript:alert(1)" }],
  ] as [string, Record<string, string>][]) {
    page.elementNode = { tagName, attributes, textContent: "Open" };
    await assert.rejects(h.driver.action("chat-a", "browser_click", { ref: 0 }), DemoError);
    assert.equal(page.elementClicks, 0);
  }
  page.elementNode = { tagName: "A", attributes: { href: "/item/b" }, textContent: "Product" };
  await h.driver.action("chat-a", "browser_click", { ref: 0 });
  assert.equal(page.elementClicks, 1, "Ordinary web links remain usable");
});

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
