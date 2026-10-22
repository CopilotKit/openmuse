// MT106 (Issue #149): selection, empty states, switching and revocation answered
// CONSISTENTLY by three clients over ONE identity matrix, with no cache crossing a scope.
//
// The three clients. iOS and Android run the same JavaScript layer (one Expo app, one shared
// src/openbot), so "the iOS client" and "the Android client" are two independent instances of this
// adapter over the same account — and "the web client" is the contract the adapter re-expresses
// (app/src/lib/enterprise/tenant, pinned by the web suites). Each world here is therefore a full
// client: its own store, its own device storage slot, its own scoped fetch — never a shared cache,
// because consistency is sameness of answers, not shared state.
//
// The identity matrix is one set of server facts — the same listing answers (the eligibility
// listing IS the membership fact, per MT104) — replayed at every client. What the matrix says, all
// three must answer identically: what is eligible (AC1), what no-eligibility and revocation look
// like (AC2), and what a switch leaves behind (AC3). Platform deltas beyond this shared layer are
// recorded, not guessed at: the register lives in the parent worktree's run report — real-device
// and simulator runs are explicitly UNVERIFIED there (the ticket's own note), and this file runs
// the whole matrix in CI with no runtime beneath it, exactly like the MT104/MT105 suites it builds
// on.
//
// Rerun: bun test apps/openmuse/apps/mobile/src/openbot/three-client-selection.test.ts

import { describe, expect, test } from "bun:test";

import {
  createTenancyStore,
  type ListingRead,
  readStoredSelection,
  readWorkspaceScopeListing,
  type ScopeSelection,
  type ScopeStorage,
  scopeRefusalOf,
  selectionFromSources,
  selectionState,
  type TenancyStore,
  type WorkspaceScopeCompany,
  type WorkspaceScopeListing,
  WorkspaceScopeRefusedError,
} from "./tenancy";
import {
  createScopedFetch,
  TenantSelectionChangedError,
} from "./transport";

// ---------------------------------------------------------------------------
// The identity matrix — one source of server facts, replayed at every client
// ---------------------------------------------------------------------------

const USER = "user-1";
const ACME: ScopeSelection = { tenantId: "acme", workspaceId: "acme-finance" };
const ACME_OPS: ScopeSelection = { tenantId: "acme", workspaceId: "acme-ops" };
const GLOBEX: ScopeSelection = { tenantId: "globex", workspaceId: "globex-ops" };

/** The companies the server currently calls eligible, with the teams under each. */
function listingOf(
  ...tenantIds: string[]
): { status: "success"; listing: WorkspaceScopeListing } {
  const catalogue: Record<string, WorkspaceScopeCompany> = {
    acme: {
      tenantId: "acme",
      name: "Acme",
      role: "member",
      memberEpoch: 7,
      teams: [
        { workspaceId: "acme-finance", name: "Finance" },
        { workspaceId: "acme-ops", name: "Ops" },
      ],
    },
    globex: {
      tenantId: "globex",
      name: "Globex",
      role: "member",
      memberEpoch: 2,
      teams: [{ workspaceId: "globex-ops", name: "Ops" }],
    },
  };
  return {
    status: "success",
    listing: {
      companies: tenantIds.map((id) => catalogue[id]),
    },
  };
}

/** The matrix's moments: full eligibility, one company suspended, everything gone, infra down. */
const MATRIX = {
  both: listingOf("acme", "globex"),
  globexOnly: listingOf("globex"),
  none: listingOf(),
  error: { status: "error" } as ListingRead,
};

const CLIENTS = ["web-mirror", "ios", "android"] as const;
type ClientName = (typeof CLIENTS)[number];

/** One whole client over the matrix: its own store, storage slot and scoped fetch. */
function clientWorld(name: ClientName, answer: () => Promise<Response>) {
  const storage = memoryStorage();
  const store = createTenancyStore({ userId: USER, storage });
  const fetch = createScopedFetch({ store, fetchLike: () => answer() });
  return { name, storage, store, fetch };
}

/** Run the matrix at every client and fold the answers into one comparable array. */
async function atEveryClient(
  run: (world: ReturnType<typeof clientWorld>) => Promise<unknown> | unknown,
  answer: () => Promise<Response> = () => Promise.resolve(new Response("{}")),
): Promise<Record<ClientName, unknown>> {
  const answers = {} as Record<ClientName, unknown>;
  for (const name of CLIENTS) {
    answers[name] = await run(clientWorld(name, answer));
  }
  return answers;
}

/** The battery every client must answer identically: each matrix moment × each selection. */
const STATE_BATTERY: Array<{
  read: ListingRead;
  selection: ScopeSelection | null;
}> = [
  ...([MATRIX.both, MATRIX.globexOnly, MATRIX.none, MATRIX.error] as const).flatMap(
    (read) => [
      { read, selection: null },
      { read, selection: ACME },
      { read, selection: ACME_OPS },
      { read, selection: GLOBEX },
    ],
  ),
];

// ---------------------------------------------------------------------------
// AC1: the selection surface lists only truly eligible companies and teams,
//      and every client answers alike
// ---------------------------------------------------------------------------

describe("MT106 AC1 three clients list only real eligibility, identically", () => {
  test("the whole matrix × selection battery answers identically on all three clients", async () => {
    const answers = await atEveryClient((world) =>
      STATE_BATTERY.map(({ read, selection }) =>
        JSON.stringify(selectionState(read, selection)),
      ),
    );
    const web = answers["web-mirror"];
    for (const name of CLIENTS) {
      expect(answers[name]).toEqual(web);
      expect(answers[name]).toHaveLength(STATE_BATTERY.length);
    }
  });

  test("a selected screen carries the listing's own row, never a local invention", async () => {
    const answers = await atEveryClient(() => selectionState(MATRIX.both, ACME));
    for (const name of CLIENTS) {
      const state = answers[name] as ReturnType<typeof selectionState>;
      expect(state).toEqual({
        kind: "selected",
        // The company and team objects are the matrix's own rows, byte for byte: the screen's
        // data comes from the server's eligibility fact, and both teams appear under Acme —
        // eligibility is the listing's word, not the selection's.
        company: MATRIX.both.listing.companies[0],
        team: MATRIX.both.listing.companies[0].teams[0],
      });
    }
  });

  test("a deep link is the authority on every client, including the half-pair refusal", async () => {
    const answers = await atEveryClient(() => [
      selectionFromSources({ company: "acme", team: "acme-ops" }, GLOBEX),
      // A link naming only a company is an incomplete scope, never half of the stored one.
      selectionFromSources({ company: "acme" }, GLOBEX),
      selectionFromSources({}, GLOBEX),
    ]);
    for (const name of CLIENTS) {
      expect(answers[name]).toEqual([ACME_OPS, null, GLOBEX]);
    }
  });
});

// ---------------------------------------------------------------------------
// AC2: no-eligibility and revocation are explicit states with explicit
//      refusals, on every client
// ---------------------------------------------------------------------------

describe("MT106 AC2 no-eligibility and revocation are explicit on every client", () => {
  test("no eligible companies is the empty state — never an error, never a silent default", async () => {
    const answers = await atEveryClient(() => selectionState(MATRIX.none, null));
    for (const name of CLIENTS) {
      expect(answers[name]).toEqual({ kind: "empty" });
    }
  });

  test("a revoked selection is shown, not silently cleared — and re-admission re-selects", async () => {
    const answers = await atEveryClient(async (world) => {
      // The user's explicit choice sits in the slot; the matrix then suspends Acme.
      await world.store.selectScope(ACME);
      const revoked = selectionState(MATRIX.globexOnly, ACME);
      // The slot still holds the pair: revocation is displayed, not erased.
      const storedWhileRevoked = await readStoredSelection(
        world.storage,
        USER,
      );
      // The matrix re-admits Acme: the same stored pair selects again, no re-prompt.
      const readmitted = selectionState(MATRIX.both, ACME);
      return { revoked, storedWhileRevoked, readmitted };
    });
    for (const name of CLIENTS) {
      expect(answers[name]).toEqual({
        revoked: { kind: "revoked", selection: ACME },
        storedWhileRevoked: ACME,
        readmitted: {
          kind: "selected",
          company: MATRIX.both.listing.companies[0],
          team: MATRIX.both.listing.companies[0].teams[0],
        },
      });
    }
  });

  test("an infrastructure failure is an error, never 'no companies'", async () => {
    const answers = await atEveryClient(() => selectionState(MATRIX.error, ACME));
    for (const name of CLIENTS) {
      expect(answers[name]).toEqual({ kind: "error" });
    }
  });

  test("the listing refusal is typed and identical on every client", async () => {
    const answers = await atEveryClient(() =>
      Promise.all([
        capture(() =>
          readWorkspaceScopeListing(async () =>
            jsonResponse(403, { error: { code: "WORKSPACE_FORBIDDEN" } }),
          ),
        ),
        capture(() =>
          readWorkspaceScopeListing(async () => textResponse(200, "not json")),
        ),
      ]),
    );
    for (const name of CLIENTS) {
      const [refused, malformed] = answers[name] as [unknown, unknown];
      expect(scopeRefusalOf(refused)?.status).toBe(403);
      expect(scopeRefusalOf(refused)?.code).toBe("WORKSPACE_FORBIDDEN");
      expect(scopeRefusalOf(malformed)?.code).toBe(
        "WORKSPACE_SCOPE_MALFORMED",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// AC3: after a switch, no old-scope cache and no in-flight answer — on every
//      client, and never across clients
// ---------------------------------------------------------------------------

describe("MT106 AC3 switching leaves no old-scope cache or in-flight answer", () => {
  test("every switch shape drops exactly the old scope's entries, on all three clients", async () => {
    const answers = await atEveryClient(async (world) => {
      const trace: string[] = [];
      await world.store.selectScope(ACME);
      world.store.write("threads", ["acme-finance-threads"]);
      trace.push(present(world.store, "threads"));
      // Team change inside Acme: only the old team's bucket goes.
      await world.store.selectScope(ACME_OPS);
      trace.push(present(world.store, "threads"));
      world.store.write("threads", ["acme-ops-threads"]);
      // Company change: Acme's whole subtree goes.
      await world.store.selectScope(GLOBEX);
      trace.push(present(world.store, "threads"));
      world.store.write("threads", ["globex-threads"]);
      // Scope → personal: the scoped subtree goes beside the personal shelf.
      await world.store.selectScope(null);
      trace.push(present(world.store, "threads"));
      world.store.write("threads", ["personal-threads"]);
      // Personal → scope: the personal business subtree goes too.
      await world.store.selectScope(ACME);
      trace.push(present(world.store, "threads"));
      return trace;
    });
    for (const name of CLIENTS) {
      // Present under its own scope, absent the moment that scope is left — no shape of
      // switch leaves the old scope's data readable.
      expect(answers[name]).toEqual([
        "present",
        "absent",
        "absent",
        "absent",
        "absent",
      ]);
    }
  });

  test("an answer that outlives its scope is refused on arrival, on all three clients", async () => {
    const deferred = deferredResponse();
    const answers = await atEveryClient(async (world) => {
      await world.store.selectScope(ACME);
      const asked = world.fetch("/api/enterprise/threads");
      await world.store.selectScope(GLOBEX);
      deferred.resolve(jsonResponse(200, { threads: ["acme-finance-threads"] }));
      const error = await capture(() => asked);
      // And nothing of the refused answer landed anywhere: not under the new scope…
      const newScope = present(world.store, "threads");
      await world.store.selectScope(ACME);
      // …and not back under the scope it was asked for.
      const oldScope = present(world.store, "threads");
      return { error, newScope, oldScope };
    }, () => deferred.promise);
    for (const name of CLIENTS) {
      const { error, newScope, oldScope } = answers[name] as {
        error: unknown;
        newScope: string;
        oldScope: string;
      };
      expect(error).toBeInstanceOf(TenantSelectionChangedError);
      expect(newScope).toBe("absent");
      expect(oldScope).toBe("absent");
    }
  });

  test("clients are independent worlds: no shared cache, no cross-client eviction", async () => {
    // Same account, three devices: a write on one client is invisible on the others, and a
    // switch on one client never drops another client's entries — consistency without shared
    // state is the whole point.
    const worlds = CLIENTS.map((name) =>
      clientWorld(name, () => Promise.resolve(new Response("{}"))),
    );
    const [web, ios, android] = worlds;
    for (const world of worlds) await world.store.selectScope(ACME);
    ios.store.write("threads", ["ios-only-threads"]);
    expect(present(web.store, "threads")).toBe("absent");
    expect(present(android.store, "threads")).toBe("absent");
    // iOS moves to Globex; web and android keep reading their own Acme entries.
    await ios.store.selectScope(GLOBEX);
    expect(present(ios.store, "threads")).toBe("absent");
    expect(present(web.store, "threads")).toBe("absent"); // web never had ios's entry
    web.store.write("threads", ["web-threads"]);
    expect(present(web.store, "threads")).toBe("present");
    expect(present(android.store, "threads")).toBe("absent");
    // The account's slot is the user's explicit choice on each client — ios's switch moved
    // only ios's slot.
    expect(await readStoredSelection(web.storage, USER)).toEqual(ACME);
    expect(await readStoredSelection(ios.storage, USER)).toEqual(GLOBEX);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function present(store: TenancyStore, key: string): "present" | "absent" {
  const read = store.read(key);
  return read.status;
}

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

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

/** One answer whose arrival the test controls, for the in-flight refusal cases. */
function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
} {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function capture(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}
