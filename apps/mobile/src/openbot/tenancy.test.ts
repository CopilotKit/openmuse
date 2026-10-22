// MT104 (Issue #147): the mobile tenancy adapter's selection and cache half, pinned against the
// WEB side's contract. Every behavior here has its twin in the web suites
// (app/tests/multitenancy/selection.test.tsx, cache-generation.test.tsx): the same six kinds, the
// same refusal mapping, the same URL-authority and never-default rules, the same
// one-generation/one-removal switch. The file imports nothing but bun:test and the adapter — no
// React Native, no app runtime — which is AC4: the adapter layer's tests run in CI independently.

import { describe, expect, test } from "bun:test";

import {
  createTenancyStore,
  type ScopeSelection,
  type ScopeStorage,
  selectionFromSources,
  selectionState,
  selectionStorageKey,
  readStoredSelection,
  readWorkspaceScopeListing,
  scopeRefusalOf,
  storeSelection,
  WorkspaceScopeRefusedError,
} from "./tenancy";

const USER = "user-1";
const ACME: ScopeSelection = { tenantId: "acme", workspaceId: "acme-finance" };
const ACME_OPS: ScopeSelection = { tenantId: "acme", workspaceId: "acme-ops" };
const GLOBEX: ScopeSelection = {
  tenantId: "globex",
  workspaceId: "globex-ops",
};

const LISTING = {
  companies: [
    {
      tenantId: "acme",
      name: "Acme",
      role: "member",
      memberEpoch: 7,
      teams: [
        { workspaceId: "acme-finance", name: "Finance" },
        { workspaceId: "acme-ops", name: "Ops" },
      ],
    },
    {
      tenantId: "globex",
      name: "Globex",
      role: "member",
      memberEpoch: 2,
      teams: [{ workspaceId: "globex-ops", name: "Ops" }],
    },
  ],
};

/** An in-memory storage stand-in, so the persistence rules run the adapter's real code in CI. */
function memoryStorage(seed: Record<string, string> = {}): ScopeStorage {
  const slots = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => slots.get(key) ?? null,
    setItem: (key: string, value: string) => {
      slots.set(key, value);
    },
  };
}

// ---------------------------------------------------------------------------
// The listing read: refusal semantics identical to the web's
// ---------------------------------------------------------------------------

describe("readWorkspaceScopeListing", () => {
  test("a listing answers as itself", async () => {
    const listing = await readWorkspaceScopeListing(async () =>
      jsonResponse(200, LISTING),
    );
    expect(listing.companies).toHaveLength(2);
  });

  test("a non-ok listing refuses with the server's own code", async () => {
    const error = await capture(async () =>
      readWorkspaceScopeListing(() =>
        jsonResponse(403, { error: { code: "WORKSPACE_FORBIDDEN" } }),
      ),
    );
    expect(error).toBeInstanceOf(WorkspaceScopeRefusedError);
    const refusal = scopeRefusalOf(error);
    expect(refusal?.status).toBe(403);
    expect(refusal?.code).toBe("WORKSPACE_FORBIDDEN");
  });

  test("a broken body is malformed, never 'no companies'", async () => {
    for (const body of ["not json", "{}", '{"companies": "acme"}', '{"companies": [{}]}']) {
      const error = await capture(async () =>
        readWorkspaceScopeListing(() => textResponse(200, body)),
      );
      expect(scopeRefusalOf(error)?.code).toBe("WORKSPACE_SCOPE_MALFORMED");
    }
  });

  test("anything else thrown is not a scope refusal", () => {
    expect(scopeRefusalOf(new Error("network died"))).toBeNull();
    expect(scopeRefusalOf(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The state machine: the web's six kinds
// ---------------------------------------------------------------------------

describe("selectionState", () => {
  test("pending is loading; an error stays an error — infrastructure is not an authorization fact", () => {
    expect(selectionState({ status: "pending" }, null)).toEqual({
      kind: "loading",
    });
    expect(selectionState({ status: "error" }, ACME)).toEqual({ kind: "error" });
  });

  test("no eligible companies is the empty state", () => {
    expect(
      selectionState({ status: "success", listing: { companies: [] } }, null),
    ).toEqual({ kind: "empty" });
  });

  test("eligible companies and no choice is ready — nothing is picked for the person", () => {
    expect(
      selectionState({ status: "success", listing: LISTING }, null),
    ).toEqual({ kind: "ready" });
  });

  test("a listed pair is selected", () => {
    const state = selectionState(
      { status: "success", listing: LISTING },
      ACME,
    );
    expect(state.kind).toBe("selected");
    if (state.kind === "selected") {
      expect(state.company.tenantId).toBe("acme");
      expect(state.team.workspaceId).toBe("acme-finance");
    }
  });

  test("a pair the listing no longer names is revoked — shown, never silently cleared", () => {
    expect(
      selectionState({ status: "success", listing: LISTING }, {
        tenantId: "gone",
        workspaceId: "gone-team",
      }),
    ).toEqual({ kind: "revoked", selection: { tenantId: "gone", workspaceId: "gone-team" } });
    // A company that still exists but hid this team is revoked too, not re-homed.
    expect(
      selectionState({ status: "success", listing: LISTING }, {
        tenantId: "acme",
        workspaceId: "acme-hid",
      }),
    ).toEqual({ kind: "revoked", selection: { tenantId: "acme", workspaceId: "acme-hid" } });
  });
});

describe("selectionFromSources", () => {
  test("a complete deep link is the authority", () => {
    expect(
      selectionFromSources({ company: "acme", team: "acme-ops" }, GLOBEX),
    ).toEqual(ACME_OPS);
  });

  test("a link naming only a company is an incomplete scope, never half of the stored one", () => {
    expect(selectionFromSources({ company: "acme" }, GLOBEX)).toBeNull();
    expect(selectionFromSources({ team: "acme-ops" }, GLOBEX)).toBeNull();
  });

  test("a silent link falls back to the stored choice; storage never invents one", () => {
    expect(selectionFromSources({}, GLOBEX)).toEqual(GLOBEX);
    expect(selectionFromSources({}, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("stored selection", () => {
  test("the slot is per-account and damaged slots read as nothing", async () => {
    const storage = memoryStorage();
    await storeSelection(storage, USER, ACME);
    expect(await readStoredSelection(storage, USER)).toEqual(ACME);
    expect(await readStoredSelection(storage, "user-2")).toBeNull();

    const damaged = memoryStorage({
      [selectionStorageKey(USER)]: "{corrupted",
    });
    expect(await readStoredSelection(damaged, USER)).toBeNull();

    const halfShaped = memoryStorage({
      [selectionStorageKey(USER)]: JSON.stringify({ tenantId: "acme" }),
    });
    expect(await readStoredSelection(halfShaped, USER)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The store: one generation, one removal discipline (the MT083 rule, mobile-shaped)
// ---------------------------------------------------------------------------

describe("createTenancyStore", () => {
  test("the scope world: pending before the user resolves, then open with the live pair", async () => {
    const unresolved = createTenancyStore({
      userId: undefined,
      storage: memoryStorage(),
    });
    expect(unresolved.scope()).toEqual({ status: "pending" });

    const storage = memoryStorage();
    await storeSelection(storage, USER, ACME);
    const store = createTenancyStore({
      userId: USER,
      storage,
      selection: await readStoredSelection(storage, USER),
    });
    expect(store.scope()).toEqual({
      status: "open",
      userId: USER,
      selection: ACME,
      generation: 0,
      key: "acme/acme-finance@0",
    });
  });

  test("business keys name user, company and team: two scopes never read one entry (AC2)", async () => {
    const store = createTenancyStore({
      userId: USER,
      storage: memoryStorage(),
    });
    await store.selectScope(ACME);
    store.write("channels", ["acme-channel"]);
    expect(store.read<string[]>("channels")).toEqual({
      status: "present",
      value: ["acme-channel"],
    });

    await store.selectScope(GLOBEX);
    // The new scope's read is absent: the old scope's entry does not appear after the switch.
    expect(store.read("channels")).toEqual({ status: "absent" });
    store.write("channels", ["globex-channel"]);
    expect(store.read<string[]>("channels")).toEqual({
      status: "present",
      value: ["globex-channel"],
    });

    // And the personal context is its own subtree, in both directions.
    await store.selectScope(null);
    expect(store.read("channels")).toEqual({ status: "absent" });
    store.write("channels", ["personal-channel"]);
    await store.selectScope(ACME);
    expect(store.read("channels")).toEqual({ status: "absent" });
  });

  test("a team change drops only the old team's entries; a company change drops the company's", async () => {
    const store = createTenancyStore({
      userId: USER,
      storage: memoryStorage(),
    });
    await store.selectScope(ACME);
    store.write("draft", "finance draft");
    await store.selectScope(ACME_OPS);
    // Same company, other team: the finance draft is gone and does not bleed through.
    expect(store.read("draft")).toEqual({ status: "absent" });
    store.write("draft", "ops draft");
    await store.selectScope(GLOBEX);
    expect(store.read("draft")).toEqual({ status: "absent" });
    // Back into Acme: the old team's entries were dropped with the company switch, not parked.
    await store.selectScope(ACME);
    expect(store.read("draft")).toEqual({ status: "absent" });
  });

  test("every switch advances the generation, and an in-flight answer is refused on arrival", async () => {
    const storage = memoryStorage();
    const store = createTenancyStore({ userId: USER, storage });
    await store.selectScope(ACME);
    const at = store.generationNow();

    // An answer that lands while the scope is unchanged is accepted.
    expect(store.stillCurrent(at)).toBe(true);

    await store.selectScope(GLOBEX);
    // The generation moved BEFORE anything else: the answer that left under Acme is refused.
    expect(store.stillCurrent(at)).toBe(false);
    expect(store.generationNow()).toBe(at + 1);

    // The new generation's captures are current until the next switch.
    const next = store.generationNow();
    expect(store.stillCurrent(next)).toBe(true);
    await store.selectScope(null);
    expect(store.stillCurrent(next)).toBe(false);
  });

  test("a same-scope switch is a no-op: the generation does not churn", async () => {
    const store = createTenancyStore({
      userId: USER,
      storage: memoryStorage(),
    });
    await store.selectScope(ACME);
    const at = store.generationNow();
    await store.selectScope(ACME);
    expect(store.generationNow()).toBe(at);
  });

  test("the switch mirrors the choice to the per-account storage slot", async () => {
    const storage = memoryStorage();
    const store = createTenancyStore({ userId: USER, storage });
    await store.selectScope(ACME);
    expect(await readStoredSelection(storage, USER)).toEqual(ACME);
    await store.selectScope(GLOBEX);
    expect(await readStoredSelection(storage, USER)).toEqual(GLOBEX);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

async function capture(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}
