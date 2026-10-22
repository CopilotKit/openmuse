/*
 * The mobile tenancy adapter's selection half, MT104 (Issue #147).
 *
 * THE CONTRACT IS THE WEB SIDE'S. The OpenBot web workbench shipped its selection as three seams
 * — `lib/enterprise/tenant/selection.ts` (the choice and its state machine), `scoped-cache.ts`
 * (where one scope's business entries live) and `stream-scope.ts` (the live selection + the
 * generation) — and this module is that same design re-expressed for a mobile app: the same
 * listing shape, the same six kinds, the same refusal behavior, the same storage discipline, the
 * same one-generation rule. Where the web reads `window.localStorage` and a `QueryClient`, the
 * mobile adapter takes injected collaborators (`ScopeStorage`, a plain store) because a React
 * Native app owns neither — and because injected collaborators are what let this file's tests run
 * in CI with no runtime beneath them (AC4).
 *
 * WHAT STAYS TRUE, BIT FOR BIT:
 * - The listing is the server's own eligibility fact (`GET /api/enterprise/workspace-scope`, the
 *   MT006 lister); nothing is selected unless a person picks it, and nothing is ever defaulted
 *   (spec A6).
 * - A non-ok listing is a typed refusal (`WorkspaceScopeRefusedError`) and a broken body is
 *   `WORKSPACE_SCOPE_MALFORMED` — an infrastructure failure never masquerades as "no companies".
 * - A deep link is the authority whenever it names anything; a link naming only a company is an
 *   incomplete scope, never half of the stored one.
 * - The switch advances ONE generation and removes the old scope's business entries; a response
 *   that left under one selection and lands under another is refused on arrival.
 */

/** One team the actor belongs to, named by the tenant-scoped data read. */
export type WorkspaceScopeTeam = {
  workspaceId: string;
  name: string;
};

/** One company the actor is an active member of, with the teams they belong to. */
export type WorkspaceScopeCompany = {
  tenantId: string;
  name: string;
  role: string;
  memberEpoch: number;
  teams: WorkspaceScopeTeam[];
};

/** The listing's whole answer: eligible companies, nothing pre-selected. */
export type WorkspaceScopeListing = {
  companies: WorkspaceScopeCompany[];
};

/** A complete selection: both halves, or no selection at all. */
export type ScopeSelection = {
  tenantId: string;
  workspaceId: string;
};

/**
 * The refusal a non-ok listing raises — the same facts the web error carries (status and the
 * server's own code), never flattened into a sentence an empty state could mistake for its own.
 */
export class WorkspaceScopeRefusedError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(
      `The workspace-scope listing refused the request (${status} ${code}).`,
    );
    this.name = "WorkspaceScopeRefusedError";
    this.status = status;
    this.code = code;
  }
}

/** The typed refusal behind an error, for callers that branch on it; anything else is not one. */
export function scopeRefusalOf(
  error: unknown,
): WorkspaceScopeRefusedError | null {
  return error instanceof WorkspaceScopeRefusedError ? error : null;
}

/**
 * Read one listing from a fetch-like answer, with the web side's exact refusal mapping: a non-ok
 * answer refuses with the server's own error code (or `WORKSPACE_SCOPE_REFUSED`), and a 200 that
 * is not a listing of companies with teams refuses as `WORKSPACE_SCOPE_MALFORMED` — because a
 * broken body must never read as "you have no companies".
 */
export async function readWorkspaceScopeListing(
  fetchListing: () => Promise<Response>,
): Promise<WorkspaceScopeListing> {
  const response = await fetchListing();
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    const envelope = body?.error;
    const code =
      envelope !== null &&
      typeof envelope === "object" &&
      typeof (envelope as Record<string, unknown>).code === "string"
        ? (envelope as { code: string }).code
        : "WORKSPACE_SCOPE_REFUSED";
    throw new WorkspaceScopeRefusedError(response.status, code);
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (
    body === null ||
    typeof body !== "object" ||
    !Array.isArray((body as Record<string, unknown>).companies)
  ) {
    throw new WorkspaceScopeRefusedError(
      response.status,
      "WORKSPACE_SCOPE_MALFORMED",
    );
  }
  const companies: unknown[] = (body as { companies: unknown[] }).companies;
  const shaped = companies.every(
    (company) =>
      company !== null &&
      typeof company === "object" &&
      typeof (company as Record<string, unknown>).tenantId === "string" &&
      Array.isArray((company as Record<string, unknown>).teams),
  );
  if (!shaped) {
    throw new WorkspaceScopeRefusedError(
      response.status,
      "WORKSPACE_SCOPE_MALFORMED",
    );
  }
  return body as WorkspaceScopeListing;
}

// ---------------------------------------------------------------------------
// The state machine — pure, the web's six kinds verbatim
// ---------------------------------------------------------------------------

/** The listing read a screen holds, narrowed to the facts the state machine answers on. */
export type ListingRead =
  | { status: "pending" }
  | { status: "error" }
  | { status: "success"; listing: WorkspaceScopeListing };

export type SelectionState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "empty" }
  /** Eligible companies exist; nobody has chosen a scope. Nothing is picked for them. */
  | { kind: "ready" }
  | {
      kind: "selected";
      company: WorkspaceScopeCompany;
      team: WorkspaceScopeTeam;
    }
  | {
      kind: "revoked";
      /** The selection that no longer matches the listing — shown, never silently cleared. */
      selection: ScopeSelection;
    };

/**
 * Where the chosen pair sits in the listing, or null when it does not.
 *
 * This IS the revocation judgment, as on the web: the server's lister is the live membership fact
 * (a suspended company hides whole, a suspended team hides alone), so an absent pair means
 * revoked access — and an erroring listing stays an error, because infrastructure trouble is not
 * an authorization fact and must not dress up as one.
 */
export function findSelection(
  listing: WorkspaceScopeListing,
  selection: ScopeSelection,
): { company: WorkspaceScopeCompany; team: WorkspaceScopeTeam } | null {
  const company = listing.companies.find(
    (candidate) => candidate.tenantId === selection.tenantId,
  );
  if (company === undefined) return null;
  const team = company.teams.find(
    (candidate) => candidate.workspaceId === selection.workspaceId,
  );
  if (team === undefined) return null;
  return { company, team };
}

export function selectionState(
  read: ListingRead,
  selection: ScopeSelection | null,
): SelectionState {
  if (read.status === "pending") return { kind: "loading" };
  if (read.status === "error") return { kind: "error" };
  if (read.listing.companies.length === 0) return { kind: "empty" };
  if (selection === null) return { kind: "ready" };
  const found = findSelection(read.listing, selection);
  if (found === null) return { kind: "revoked", selection };
  return { kind: "selected", company: found.company, team: found.team };
}

/**
 * The selection this screen holds, from the two user-explicit sources — the web rule, with the
 * mobile deep link in the URL's seat. A deep link is the authority whenever it names anything;
 * a link that names only a company is an incomplete scope — not half of the stored one. Storage
 * fills only a silent link with the user's own last explicit choice; it never invents one.
 */
export function selectionFromSources(
  deepLink: { company?: string; team?: string },
  stored: ScopeSelection | null,
): ScopeSelection | null {
  if (deepLink.company !== undefined || deepLink.team !== undefined) {
    if (deepLink.company !== undefined && deepLink.team !== undefined) {
      return { tenantId: deepLink.company, workspaceId: deepLink.team };
    }
    return null;
  }
  return stored;
}

// ---------------------------------------------------------------------------
// Persistence — the choice itself is user-explicit; storage only remembers it
// ---------------------------------------------------------------------------

/** The storage contract this module needs; AsyncStorage satisfies it, and so does a Map in CI. */
export interface ScopeStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
}

/** Same prefix as the web mirror, so one account's slot means the same thing on both clients. */
const STORAGE_PREFIX = "openbot.workspace-scope.v1:";

export function selectionStorageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

function scopeOf(value: unknown): ScopeSelection | null {
  if (value === null || typeof value !== "object") return null;
  const tenantId = (value as Record<string, unknown>).tenantId;
  const workspaceId = (value as Record<string, unknown>).workspaceId;
  if (
    typeof tenantId !== "string" ||
    tenantId === "" ||
    typeof workspaceId !== "string" ||
    workspaceId === ""
  ) {
    return null;
  }
  return { tenantId, workspaceId };
}

/** The user's last explicit selection, or null. A damaged slot reads as nothing. */
export async function readStoredSelection(
  storage: ScopeStorage,
  userId: string,
): Promise<ScopeSelection | null> {
  let raw: string | null;
  try {
    raw = await storage.getItem(selectionStorageKey(userId));
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    return scopeOf(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Remember an explicit choice; storage trouble is swallowed — the caller still holds the choice. */
export async function storeSelection(
  storage: ScopeStorage,
  userId: string,
  selection: ScopeSelection,
): Promise<void> {
  try {
    await storage.setItem(
      selectionStorageKey(userId),
      JSON.stringify(selection),
    );
  } catch {
    /* best-effort mirror, exactly as on the web */
  }
}

// ---------------------------------------------------------------------------
// The store — one selection, one generation, one removal discipline
// ---------------------------------------------------------------------------

/**
 * The scoped cache's answer while the scope source (the signed-in user) is unresolved — the same
 * refusal the web streams live by: a business read is not established on a guess.
 */
export type TenancyScope = { status: "pending" } | {
  status: "open";
  userId: string;
  selection: ScopeSelection | null;
  generation: number;
  /** Changes exactly when a business key must change: the pair moved, or the generation moved. */
  key: string;
};

function sameScope(
  left: ScopeSelection | null,
  right: ScopeSelection | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.tenantId === right.tenantId && left.workspaceId === right.workspaceId
  );
}

/**
 * The mobile tenancy store: the one place the live selection and its generation live. The web
 * holds these in two cache entries a QueryClient owns; a mobile app owns no such thing, so the
 * adapter owns them itself — a plain object, one instance per app session, created with the
 * signed-in user and seeded from that user's storage slot.
 */
export function createTenancyStore(options: {
  userId: string | undefined;
  storage: ScopeStorage;
  selection?: ScopeSelection | null;
  generation?: number;
}) {
  const userId = options.userId;
  let selection: ScopeSelection | null = options.selection ?? null;
  let generation: number = options.generation ?? 0;
  /** One cache per (company, team, generation) prefix, dropped wholesale on a switch. */
  const scopes = new Map<string, Map<string, unknown>>();

  const prefixOf = (pair: ScopeSelection | null): string => {
    if (pair === null) return "personal";
    return `${pair.tenantId}/${pair.workspaceId}`;
  };

  const store = {
    /** The live scope world, in the web `StreamScope`'s shape. */
    scope(): TenancyScope {
      if (userId === undefined) return { status: "pending" };
      return {
        status: "open",
        userId,
        selection,
        generation,
        key: `${prefixOf(selection)}@${generation}`,
      };
    },

    /**
     * The whole switch, in the web `selectWorkspaceScope`'s order: the generation moves FIRST, so
     * a response already in flight against the old scope is refused on arrival, and the old
     * scope's business entries go AFTER — dropped, not invalidated, so a stale row is never
     * visible for one render while the refetch runs. A team change inside one company drops only
     * the old team's entries (leaving one team is not leaving the company); a company change drops
     * the old company's whole subtree; and choosing a scope out of the personal context drops the
     * personal context's business subtree beside it, so no stale personal entry can render beside
     * the scope just chosen.
     */
    async selectScope(next: ScopeSelection | null): Promise<void> {
      if (sameScope(selection, next)) return;
      generation += 1;
      const previous = selection;
      const sameCompany =
        previous !== null &&
        next !== null &&
        previous.tenantId === next.tenantId;
      if (sameCompany) {
        scopes.delete(prefixOf(previous));
      } else {
        if (previous !== null) {
          for (const key of scopes.keys()) {
            if (key.startsWith(`${previous.tenantId}/`)) scopes.delete(key);
          }
        }
        if (previous === null && next !== null) scopes.delete("personal");
      }
      selection = next;
      if (userId !== undefined && next !== null) {
        await storeSelection(options.storage, userId, next);
      }
    },

    // -- The scoped cache half (the web `scoped-cache.ts` rule) ------------------

    /**
     * Where one scope's business entries live: under the selection's own prefix (user, company
     * and team all named), or — when nothing is selected — under the personal context's. A key
     * filed here is gone the moment its scope is (AC2: the cache key names user, company and
     * team; after a switch the old scope's data does not appear).
     */
    cachePrefix(): string {
      return userId === undefined ? "unresolved" : prefixOf(selection);
    },

    read<T>(key: string): { status: "present"; value: T } | { status: "absent" } {
      const bucket = scopes.get(prefixOf(selection));
      if (bucket === undefined || !bucket.has(key)) return { status: "absent" };
      return { status: "present", value: bucket.get(key) as T };
    },

    /** Write under the CURRENT scope's prefix only; a write never leaks into another scope's bucket. */
    write(key: string, value: unknown): void {
      const prefix = prefixOf(selection);
      let bucket = scopes.get(prefix);
      if (bucket === undefined) {
        bucket = new Map();
        scopes.set(prefix, bucket);
      }
      bucket.set(key, value);
    },

    /** The generation at capture time, for the in-flight refusal below. */
    generationNow(): number {
      return generation;
    },

    /**
     * Whether a write that left at `at` may still land — the web `streamWriteStillCurrent` /
     * `cacheWriteGate` rule: once any switch advanced the generation, the old scope's entries are
     * gone, and replaying into them (or into the new scope's key) would resurrect or corrupt what
     * the switch just cleared.
     */
    stillCurrent(at: number): boolean {
      return generation === at;
    },
  };
  return store;
}

export type TenancyStore = ReturnType<typeof createTenancyStore>;
