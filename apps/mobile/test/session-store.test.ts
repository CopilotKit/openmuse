import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  clearSessionToken,
  loadSessionToken,
  saveSessionToken,
  setTokenStore,
  type TokenStore,
  validateSessionToken,
} from "../src/session-store.ts";

function memoryStore(): TokenStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

afterEach(() => {
  setTokenStore(null);
  globalThis.fetch = originalFetch;
});

// captured before tests stub it
const originalFetch: typeof fetch = globalThis.fetch;

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  // @ts-expect-error test stub
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return calls;
}

test("session token round-trips through the store", async () => {
  const store = memoryStore();
  setTokenStore(store);
  assert.equal(await loadSessionToken(), null);
  await saveSessionToken("tok-abc-123");
  assert.equal(await loadSessionToken(), "tok-abc-123");
  assert.equal(store.data.get("openmuse.session.token"), "tok-abc-123");
  await clearSessionToken();
  assert.equal(await loadSessionToken(), null);
});

test("a newer login overwrites the previous token", async () => {
  setTokenStore(memoryStore());
  await saveSessionToken("old-token");
  await saveSessionToken("new-token");
  assert.equal(await loadSessionToken(), "new-token");
});

test("storage failures never reject and never leak", async () => {
  setTokenStore({
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  });
  assert.equal(await loadSessionToken(), null);
  await saveSessionToken("tok");
  await clearSessionToken();
});

test("validateSessionToken returns true when the server accepts the token", async () => {
  const calls = stubFetch(() => new Response("{}", { status: 200 }));
  assert.equal(await validateSessionToken("https://api.example/", "tok-1"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example/api/workspace");
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get("Authorization"), "Bearer tok-1");
});

test("validateSessionToken returns false on 401 (expired/unknown token)", async () => {
  stubFetch(() => new Response(JSON.stringify({ error: "Session expired." }), { status: 401 }));
  assert.equal(await validateSessionToken("https://api.example", "stale-token"), false);
});

test("validateSessionToken propagates network failures so a good token is not wiped", async () => {
  stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(() => validateSessionToken("https://api.example", "tok-1"), TypeError);
});
