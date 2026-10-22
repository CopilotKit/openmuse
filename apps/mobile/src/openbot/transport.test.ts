// MT105 (Issue #148): the mobile transport carries the current company/team selection on its
// streams, uploads/downloads and media reads — and nothing else does. The attachment gates, the
// subscription lifecycle, the generation rule and the reconnect rule are the web transport's
// (MT082/MT083) re-expressed over the mobile tenancy store: this file pins them with the same
// fixture discipline. It imports nothing but bun:test and the adapter — AC-adjacent: the tests
// run in CI with no runtime beneath them.

import { describe, expect, test } from "bun:test";

import {
  createTenancyStore,
  type ScopeSelection,
  type ScopeStorage,
} from "./tenancy";
import {
  createScopeBoundStream,
  createScopedFetch,
  mediaCacheKey,
  readMediaCache,
  scopeHeaders,
  SCOPE_HEADER_ALLOWED_PATHS,
  TenantSelectionChangedError,
  TENANT_HEADER,
  withStreamScope,
  WORKSPACE_HEADER,
  writeMediaCache,
} from "./transport";

const ACME: ScopeSelection = { tenantId: "acme", workspaceId: "acme-finance" };
const GLOBEX: ScopeSelection = { tenantId: "globex", workspaceId: "globex-ops" };

/** An in-memory storage stand-in, so the store's persistence mirror runs its real code in CI. */
function memoryStorage(): ScopeStorage {
  const slots = new Map<string, string>();
  return {
    getItem: (key: string) => slots.get(key) ?? null,
    setItem: (key: string, value: string) => {
      slots.set(key, value);
    },
  };
}

// ---------------------------------------------------------------------------
// AC1: the pair rides reviewed same-origin paths only
// ---------------------------------------------------------------------------

describe("scopeHeaders", () => {
  test("a reviewed REST path carries the pair as headers", () => {
    expect(scopeHeaders("/api/channels", ACME)).toEqual({
      [TENANT_HEADER]: "acme",
      [WORKSPACE_HEADER]: "acme-finance",
    });
    expect(scopeHeaders("/api/enterprise/workspace-scope", ACME)).toEqual({
      [TENANT_HEADER]: "acme",
      [WORKSPACE_HEADER]: "acme-finance",
    });
  });

  test("an unreviewed path is left undecorated", () => {
    expect(scopeHeaders("/api/unreviewed/thing", ACME)).toBeNull();
    expect(scopeHeaders("/api/unreviewed", ACME)).toBeNull();
  });

  test("a non-same-origin path never receives the pair", () => {
    expect(scopeHeaders("https://elsewhere.example/api/agents", ACME)).toBeNull();
    expect(scopeHeaders("//api/agents", ACME)).toBeNull();
  });

  test("no selection attaches nothing — absence is carried as absence, never defaulted", () => {
    expect(scopeHeaders("/api/agents", null)).toBeNull();
  });

  test("every inventory entry names its owner and reason — a closed, reviewable list", () => {
    // Widening the list is a review, not an accident: each entry's owner names the ticket
    // that performed it (MT107's is the mobile-aggregation family's own review).
    const reviewedBy = ["MT105", "MT107"];
    for (const entry of SCOPE_HEADER_ALLOWED_PATHS) {
      expect(entry.id).toBeTruthy();
      expect(entry.prefix.startsWith("/api/")).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(reviewedBy).toContain(entry.ownerTicket);
    }
  });
});

describe("withStreamScope", () => {
  test("a reviewed stream path carries the pair as query, preserving what is already there", () => {
    expect(withStreamScope("/api/workshop/turn/1", ACME)).toBe(
      "/api/workshop/turn/1?x-openbot-tenant=acme&x-openbot-workspace=acme-finance",
    );
    expect(withStreamScope("/api/craft/session/1/events?cursor=7", ACME)).toBe(
      "/api/craft/session/1/events?cursor=7&x-openbot-tenant=acme&x-openbot-workspace=acme-finance",
    );
    expect(withStreamScope("/api/channels/events", ACME)).toBe(
      "/api/channels/events?x-openbot-tenant=acme&x-openbot-workspace=acme-finance",
    );
  });

  test("the pair is encoded — an id with a space is still one value", () => {
    expect(
      withStreamScope("/api/computers/1/screen", {
        tenantId: "ac me",
        workspaceId: "finance team",
      }),
    ).toBe("/api/computers/1/screen?x-openbot-tenant=ac%20me&x-openbot-workspace=finance%20team");
  });

  test("an unreviewed stream path, a foreign origin, and no selection all change nothing", () => {
    expect(withStreamScope("/api/other/stream", ACME)).toBe("/api/other/stream");
    expect(withStreamScope("wss://third.party/stream", ACME)).toBe(
      "wss://third.party/stream",
    );
    expect(withStreamScope("//echo/stream", ACME)).toBe("//echo/stream");
    expect(withStreamScope("/api/workshop/turn/1", null)).toBe(
      "/api/workshop/turn/1",
    );
  });
});

// ---------------------------------------------------------------------------
// AC3: an in-flight answer that outlived its selection is refused on arrival
// ---------------------------------------------------------------------------

describe("createScopedFetch", () => {
  test("the pair rides the request, and an answer that lands in time is accepted", async () => {
    const store = createTenancyStore({
      userId: "user-1",
      storage: memoryStorage(),
    });
    await store.selectScope(ACME);
    const seen: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
    const scoped = createScopedFetch({
      store,
      fetchLike: async (url, init) => {
        seen.push({ url, headers: init?.headers });
        return new Response("{}", { status: 200 });
      },
    });
    const response = await scoped("/api/agents");
    expect(response.status).toBe(200);
    expect(seen[0]?.url).toBe("/api/agents");
    expect(seen[0]?.headers).toEqual({
      [TENANT_HEADER]: "acme",
      [WORKSPACE_HEADER]: "acme-finance",
    });
  });

  test("an answer that arrives after a switch is refused, never applied", async () => {
    const store = createTenancyStore({
      userId: "user-1",
      storage: memoryStorage(),
    });
    await store.selectScope(ACME);
    let answer: ((response: Response) => void) | null = null;
    const scoped = createScopedFetch({
      store,
      fetchLike: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    const inFlight = scoped("/api/agents");
    // The switch happens while the answer is in flight.
    await store.selectScope(GLOBEX);
    answer?.(new Response("{}", { status: 200 }));
    const error = await capture(inFlight);
    expect(error).toBeInstanceOf(TenantSelectionChangedError);
  });

  test("a pending scope source refuses before dialing — no read on a guess", async () => {
    const store = createTenancyStore({
      userId: undefined,
      storage: memoryStorage(),
    });
    const scoped = createScopedFetch({
      store,
      fetchLike: async () => {
        throw new Error("must not dial");
      },
    });
    const error = await capture(scoped("/api/agents"));
    expect(String(error)).toContain("scope source has not answered");
  });
});

// ---------------------------------------------------------------------------
// AC2: a switch tears the old subscription down and the old media cache is not served
// ---------------------------------------------------------------------------

describe("createScopeBoundStream", () => {
  function harness() {
    const store = createTenancyStore({
      userId: "user-1",
      storage: memoryStorage(),
    });
    const opened: string[] = [];
    const closed: string[] = [];
    const stream = createScopeBoundStream({
      store,
      open: (url) => {
        opened.push(url);
        return {
          close: () => {
            closed.push(url);
          },
        };
      },
    });
    return { store, stream, opened, closed };
  }

  test("opens under the current pair; refuses while the scope source is pending", async () => {
    const pending = createTenancyStore({
      userId: undefined,
      storage: memoryStorage(),
    });
    const stream = createScopeBoundStream({
      store: pending,
      open: () => {
        throw new Error("must not open");
      },
    });
    expect(stream.reopen("/api/workshop/turn/1")).toEqual({
      refused: "scope-pending",
    });

    const { store, stream: live, opened } = harness();
    await store.selectScope(ACME);
    const opened0 = live.reopen("/api/workshop/turn/1");
    expect(opened0).toMatchObject({ generation: expect.any(Number) });
    expect(opened[0]).toBe(
      "/api/workshop/turn/1?x-openbot-tenant=acme&x-openbot-workspace=acme-finance",
    );
  });

  test("a switch cancels the old subscription and the next open carries the NEW pair (AC2/AC4)", async () => {
    const { store, stream, opened, closed } = harness();
    await store.selectScope(ACME);
    stream.reopen("/api/workshop/turn/1");
    const keyBefore = stream.openedKey();

    await store.selectScope(GLOBEX);
    // The teardown signal, as the app's effect reads it: the live connection was opened under a
    // key the store has since left. The wrapper still names the old key — that IS the staleness.
    const scopeNow = store.scope();
    expect(scopeNow.status).toBe("open");
    if (scopeNow.status === "open") {
      expect(scopeNow.key).not.toBe(keyBefore);
    }
    expect(stream.openedKey()).toBe(keyBefore);
    // Reopening under the moved scope closes the old connection and carries the NEW pair.
    stream.reopen("/api/workshop/turn/1");
    expect(closed).toHaveLength(1);
    expect(opened[1]).toBe(
      "/api/workshop/turn/1?x-openbot-tenant=globex&x-openbot-workspace=globex-ops",
    );
    expect(stream.openedKey()).not.toBe(keyBefore);
  });

  test("a late frame from a torn-down connection is refused by the generation rule", async () => {
    const { store, stream } = harness();
    await store.selectScope(ACME);
    const { generation } = stream.reopen("/api/workshop/turn/1") as {
      generation: number;
    };
    expect(stream.frameStillCurrent(generation)).toBe(true);
    await store.selectScope(GLOBEX);
    // The frame's connection was opened under the old generation: dropped, not applied.
    expect(stream.frameStillCurrent(generation)).toBe(false);
  });

  test("a reconnect after a dropped line re-reads the CURRENT selection, never a default", async () => {
    const { store, stream, opened } = harness();
    await store.selectScope(ACME);
    stream.reopen("/api/workshop/turn/1");
    // The line drops; while it is down, the person switches scope.
    await store.selectScope(GLOBEX);
    stream.reopen("/api/workshop/turn/1");
    expect(opened[1]).toContain("x-openbot-tenant=globex");
    // And with no selection at all, the reconnected stream carries no pair at all — not a default.
    await store.selectScope(null);
    stream.reopen("/api/workshop/turn/1");
    expect(opened[2]).toBe("/api/workshop/turn/1");
  });
});

// ---------------------------------------------------------------------------
// AC2, the media half: the old scope's media cache is not served after a switch
// ---------------------------------------------------------------------------

describe("scoped media cache", () => {
  test("one URI is one entry per scope; after a switch the old scope's media is absent", async () => {
    const store = createTenancyStore({
      userId: "user-1",
      storage: memoryStorage(),
    });
    await store.selectScope(ACME);
    writeMediaCache(store, "/api/craft/file/1/media", { bytes: "acme-bytes" });
    expect(readMediaCache<{ bytes: string }>(store, "/api/craft/file/1/media")).toEqual({
      status: "present",
      value: { bytes: "acme-bytes" },
    });

    await store.selectScope(GLOBEX);
    // The same URI under the new scope is a miss — the old company's media does not display.
    expect(readMediaCache(store, "/api/craft/file/1/media")).toEqual({
      status: "absent",
    });
    writeMediaCache(store, "/api/craft/file/1/media", { bytes: "globex-bytes" });
    expect(readMediaCache<{ bytes: string }>(store, "/api/craft/file/1/media")).toEqual({
      status: "present",
      value: { bytes: "globex-bytes" },
    });

    // The personal context is its own shelf, in both directions.
    await store.selectScope(null);
    expect(readMediaCache(store, "/api/craft/file/1/media")).toEqual({
      status: "absent",
    });
  });

  test("the media key names the scope beside the URI", async () => {
    const store = createTenancyStore({
      userId: "user-1",
      storage: memoryStorage(),
    });
    await store.selectScope(ACME);
    expect(mediaCacheKey(store, "/media/1")).toBe(
      "media:acme/acme-finance:/media/1",
    );
    await store.selectScope(null);
    expect(mediaCacheKey(store, "/media/1")).toBe("media:personal:/media/1");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function capture(
  run: Promise<unknown> | (() => Promise<unknown>),
): Promise<unknown> {
  try {
    await (typeof run === "function" ? run() : run);
    return null;
  } catch (error) {
    return error;
  }
}
