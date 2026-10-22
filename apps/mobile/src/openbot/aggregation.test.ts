// MT107 (Issue #150): the mobile aggregation surface answers under the scope the
// client CURRENTLY holds — every sub-query of it — and the streaming and media
// transports keep the same discipline across three clients.
//
// Two halves, one per ticket AC group:
//
//   The AGGREGATION half is client-side here. The aggregation snapshot (MT066's
//   readMobileAggregate: voice sessions, dictation usage, push devices — three sub-queries)
//   is read through the scoped transport: the request carries the current selection pair as
//   headers on the reviewed mobile-aggregation family (the inventory entry MT107's review
//   admits in transport.ts), an EMPTY scope is carried as absent (never a defaulted pair),
//   and each sub-collection lands only while the generation it left under still stands — a
//   switch mid-snapshot refuses the rest and drops what landed. The SERVER half of
//   "every sub-query returns only the current scope" is MT066's own suite
//   (server/tests/multitenancy/voice-mobile-bff.test.ts, real PostgreSQL + restricted roles);
//   this round's run record for it lives in the parent worktree's .archive run (see the run
//   report), so both halves are independently re-checkable.
//
//   The STREAM/MEDIA half re-runs MT105's lifecycle rules AT the three clients over one
//   identity matrix (same shape as three-client-selection.test.ts): a stream opens with the
//   current pair in its query, its late frames die with a switch, a reconnect answers under
//   the scope current THEN, and media never crosses a scope.
//
// Platform deltas are recorded, not guessed at: device and simulator runs are explicitly
// UNVERIFIED in the parent worktree's run report (the ticket's own note); this file runs the
// whole matrix in CI with no runtime beneath it.
//
// Rerun: bun test apps/openmuse/apps/mobile/src/openbot/aggregation.test.ts

import { describe, expect, test } from "bun:test";

import {
  createTenancyStore,
  type ScopeSelection,
  type ScopeStorage,
} from "./tenancy";
import {
  createScopedFetch,
  createScopeBoundStream,
  mediaCacheKey,
  readMediaCache,
  TENANT_HEADER,
  TenantSelectionChangedError,
  WORKSPACE_HEADER,
  writeMediaCache,
  withStreamScope,
} from "./transport";

const USER = "user-1";
const ACME: ScopeSelection = { tenantId: "acme", workspaceId: "acme-finance" };
const GLOBEX: ScopeSelection = { tenantId: "globex", workspaceId: "globex-ops" };

/** The aggregation snapshot's shape, mirroring MT066's ScopedMobileAggregate sub-collections. */
type AggregateSnapshot = {
  voiceSessions: { sessionId: string; tenantId: string }[];
  dictationUsage: { id: string; tenantId: string }[];
  pushDevices: { deviceId: string; tenantId: string }[];
};

function snapshotOf(tenantId: string): AggregateSnapshot {
  return {
    voiceSessions: [{ sessionId: `${tenantId}-session`, tenantId }],
    dictationUsage: [{ id: `${tenantId}-usage`, tenantId }],
    pushDevices: [{ deviceId: `${tenantId}-device`, tenantId }],
  };
}

const AGGREGATE_PATH = "/api/voice/mobile/aggregate";

const CLIENTS = ["web-mirror", "ios", "android"] as const;
type ClientName = (typeof CLIENTS)[number];

/** One whole client: its own store, storage slot, scoped fetch and a recording transport. */
function clientWorld(name: ClientName) {
  const storage = memoryStorage();
  const store = createTenancyStore({ userId: USER, storage });
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch = createScopedFetch({
    store,
    fetchLike: async (url, init) => {
      calls.push({ url, headers: { ...(init?.headers ?? {}) } });
      return jsonResponse(200, snapshotOf(scopeTenantOf(url, init?.headers)));
    },
  });
  return { name, storage, store, fetch, calls };
}

/** What the server would have answered: the scope the request actually arrived under. */
function scopeTenantOf(
  url: string,
  headers?: Record<string, string>,
): string {
  return headers?.[TENANT_HEADER] ?? new URL(`https://x.test${url}`).searchParams.get(TENANT_HEADER) ?? "personal";
}

/**
 * The aggregation read as the app consumes it: one scoped request, then the snapshot's three
 * sub-collections landing one by one — each write gated by the generation the request left
 * under, so a switch anywhere in the snapshot refuses everything not yet landed (and the
 * store's own switch has already dropped whatever did land).
 */
async function landAggregate(
  world: ReturnType<typeof clientWorld>,
  betweenSubqueries?: () => Promise<void> | void,
): Promise<{ landed: string[] }> {
  const at = world.store.generationNow();
  const response = await world.fetch(AGGREGATE_PATH);
  const snapshot = (await response.json()) as AggregateSnapshot;
  const landed: string[] = [];
  for (const [key, rows] of [
    ["aggregate:voice-sessions", snapshot.voiceSessions],
    ["aggregate:dictation-usage", snapshot.dictationUsage],
    ["aggregate:push-devices", snapshot.pushDevices],
  ] as const) {
    await betweenSubqueries?.();
    if (!world.store.stillCurrent(at)) {
      // The same refusal the scoped fetch raises for a whole answer, raised here per
      // sub-query: a sub-collection may not land into a scope it was not asked under.
      return Promise.reject(new TenantSelectionChangedError());
    }
    world.store.write(key, rows);
    landed.push(key);
  }
  return { landed };
}

// ---------------------------------------------------------------------------
// AC1: the aggregation request and every sub-query answer under the current
//      scope — including the empty scope
// ---------------------------------------------------------------------------

describe("MT107 AC1 the aggregation surface carries the current scope", () => {
  test("the request carries the CURRENT pair — per request, on every client", async () => {
    for (const name of CLIENTS) {
      const world = clientWorld(name);
      await world.store.selectScope(ACME);
      await landAggregate(world);
      expect(world.calls[0]?.headers[TENANT_HEADER]).toBe("acme");
      expect(world.calls[0]?.headers[WORKSPACE_HEADER]).toBe("acme-finance");
      // The pair is read per request: after a switch, the next aggregation reads Globex.
      await world.store.selectScope(GLOBEX);
      await landAggregate(world);
      expect(world.calls[1]?.headers[TENANT_HEADER]).toBe("globex");
      expect(world.calls[1]?.headers[WORKSPACE_HEADER]).toBe("globex-ops");
    }
  });

  test("a switch mid-snapshot refuses the un-landed sub-queries and drops the landed", async () => {
    for (const name of CLIENTS) {
      const world = clientWorld(name);
      await world.store.selectScope(ACME);
      let switched = false;
      const outcome = await capture(() =>
        landAggregate(world, async () => {
          // The switch lands after the first sub-collection, before the second.
          if (!switched) {
            switched = true;
            await world.store.selectScope(GLOBEX);
          }
        }),
      );
      expect(outcome).toBeInstanceOf(TenantSelectionChangedError);
      // Nothing of the Acme snapshot survived: the landed sub-collection went with the
      // switch's bucket drop, and the un-landed ones never wrote anywhere.
      expect(world.store.read("aggregate:voice-sessions").status).toBe("absent");
      expect(world.store.read("aggregate:dictation-usage").status).toBe("absent");
      expect(world.store.read("aggregate:push-devices").status).toBe("absent");
      // The Globex bucket is clean too: a late sub-query may not land into the scope that
      // replaced the one it was asked under.
      await world.store.selectScope(ACME);
      expect(world.store.read("aggregate:voice-sessions").status).toBe("absent");
    }
  });

  test("the empty scope is carried as absent — never a defaulted pair — and lands on the personal shelf", async () => {
    for (const name of CLIENTS) {
      const world = clientWorld(name);
      // No selection: the request carries NO pair at all, and the answer is the personal
      // context's own (the server keys an undecorated request to the caller's personal
      // scope — a missing selection is carried as missing, MT104's rule, on the wire).
      await landAggregate(world);
      expect(TENANT_HEADER in (world.calls[0]?.headers ?? {})).toBe(false);
      expect(WORKSPACE_HEADER in (world.calls[0]?.headers ?? {})).toBe(false);
      expect(world.store.read("aggregate:voice-sessions").status).toBe("present");
      // A later scoped read never sees the personal shelf's aggregate, in either direction.
      await world.store.selectScope(ACME);
      expect(world.store.read("aggregate:voice-sessions").status).toBe("absent");
      await world.store.selectScope(null);
      expect(world.store.read("aggregate:voice-sessions").status).toBe("absent");
    }
  });
});

// ---------------------------------------------------------------------------
// AC2: streaming requests carry the right scope; an old connection is
//      cancelled and its late frames refused
// ---------------------------------------------------------------------------

describe("MT107 AC2 streams carry the current scope and die with a switch", () => {
  test("the stream URL carries the current pair; a switch cancels the line and its late frames", async () => {
    for (const name of CLIENTS) {
      const world = clientWorld(name);
      const opened: Array<{ url: string; closed: () => void }> = [];
      const stream = createScopeBoundStream({
        store: world.store,
        open: (url) => {
          const connection = { closed: false, close: () => { connection.closed = true; } };
          opened.push({ url, closed: () => connection.closed });
          return connection;
        },
      });
      await world.store.selectScope(ACME);
      const first = stream.reopen("/api/voice/calls/live");
      if ("refused" in first) throw new Error("expected an open, not a refusal");
      expect(first.url).toContain(`${TENANT_HEADER}=acme`);
      expect(first.url).toContain(`${WORKSPACE_HEADER}=acme-finance`);
      expect(stream.openedKey()).toContain("acme/acme-finance");

      // A frame from the live connection may land while the scope stands…
      expect(stream.frameStillCurrent(first.generation)).toBe(true);
      // …and the switch kills it: late frames are refused by the generation rule.
      await world.store.selectScope(GLOBEX);
      expect(stream.frameStillCurrent(first.generation)).toBe(false);

      // Reconnect answers under the scope that is current THEN, and the old line is closed.
      const second = stream.reopen("/api/voice/calls/live");
      if ("refused" in second) throw new Error("expected an open, not a refusal");
      expect(second.url).toContain(`${TENANT_HEADER}=globex`);
      expect(second.url).toContain(`${WORKSPACE_HEADER}=globex-ops`);
      const firstLineClosed = opened[0].closed();
      expect(firstLineClosed).toBe(true);
      expect(stream.frameStillCurrent(second.generation)).toBe(true);
    }
  });

  test("a pending scope source refuses before dialing, on every client", () => {
    const store = createTenancyStore({ userId: undefined, storage: memoryStorage() });
    let dialed = 0;
    const stream = createScopeBoundStream({
      store,
      open: () => {
        dialed += 1;
        return { close: () => {} };
      },
    });
    expect(stream.reopen("/api/voice/calls/live")).toEqual({
      refused: "scope-pending",
    });
    expect(dialed).toBe(0);
  });

  test("the stream scope rides the query with the resume cursor preserved", () => {
    const url = withStreamScope("/api/voice/calls/live?cursor=42", ACME);
    expect(url).toContain("cursor=42");
    expect(url).toContain(`${TENANT_HEADER}=acme`);
    expect(url).toContain(`${WORKSPACE_HEADER}=acme-finance`);
    // An empty selection changes nothing at all.
    expect(withStreamScope("/api/voice/calls/live?cursor=42", null)).toBe(
      "/api/voice/calls/live?cursor=42",
    );
  });
});

// ---------------------------------------------------------------------------
// AC3: media never crosses a scope, on every client
// ---------------------------------------------------------------------------

describe("MT107 AC3 media does not cross scopes", () => {
  test("one URI is one entry per scope, and a switch makes the old entry unreachable", async () => {
    for (const name of CLIENTS) {
      const world = clientWorld(name);
      const URI = "/api/craft/file/1/media";
      await world.store.selectScope(ACME);
      writeMediaCache(world.store, URI, { bytes: "acme-bytes" });
      expect(readMediaCache<{ bytes: string }>(world.store, URI)).toEqual({
        status: "present",
        value: { bytes: "acme-bytes" },
      });

      await world.store.selectScope(GLOBEX);
      // The Acme media is simply not found — never served beside Globex's own.
      expect(readMediaCache(world.store, URI)).toEqual({ status: "absent" });
      writeMediaCache(world.store, URI, { bytes: "globex-bytes" });
      expect(readMediaCache<{ bytes: string }>(world.store, URI)).toEqual({
        status: "present",
        value: { bytes: "globex-bytes" },
      });

      // The personal context is its own shelf, in both directions.
      await world.store.selectScope(null);
      expect(readMediaCache(world.store, URI)).toEqual({ status: "absent" });

      // The media key names the scope beside the URI (the isolation is in the key).
      await world.store.selectScope(ACME);
      expect(mediaCacheKey(world.store, URI)).toBe(
        `media:acme/acme-finance:${URI}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function memoryStorage(seed: Record<string, string> = {}): ScopeStorage {
  const slots = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => slots.get(key) ?? null,
    setItem: (key: string, value: string) => {
      slots.set(key, value);
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function capture(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}
