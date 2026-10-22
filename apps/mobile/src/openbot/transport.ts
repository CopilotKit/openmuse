/*
 * The mobile tenancy adapter's transport half, MT105 (Issue #148).
 *
 * THE RULES ARE THE WEB TRANSPORT'S, in both registers. The REST register is `client.ts`'s: the
 * selection pair rides as HEADERS (`x-openbot-tenant`, `x-openbot-workspace`) on reviewed
 * same-origin business paths only — a closed inventory, each entry owned by the ticket that
 * reviewed it, never widened by accident. The stream register is `stream-scope.ts`'s: a streaming
 * connection cannot carry request headers (an SSE read, a WebSocket upgrade), so on those surfaces
 * the SAME pair rides the URL's query under the same two names, on the same kind of closed
 * inventory — one vocabulary, so the server-side wiring (MT125) reads one set of names wherever
 * the connection came from.
 *
 * THE LIFECYCLE HALF IS THE TICKET'S REAL SUBJECT, as it was MT082's: a stream that outlives its
 * scope is a pipe pushing one company's events into a screen that has moved on, and a media cache
 * that outlives its scope is yesterday's company file one tap away. So every business connection
 * this module serves is bound to the tenancy store's live scope: it opens only once the scope
 * source has resolved (never on a guess), is torn down when the scope moves, re-reads the CURRENT
 * selection at every (re)connect — a dropped line that comes back answers under the scope that is
 * current THEN, never a defaulted one (spec A6) — and every answer is checked against the
 * generation it left under, so an in-flight response that lands after a switch is refused rather
 * than applied (the same `stillCurrent` rule the web streams and caches share).
 */

import { type ScopeSelection, type TenancyStore } from "./tenancy";

/** The header names, identical to the web client's — one vocabulary across clients. */
export const TENANT_HEADER = "x-openbot-tenant";
export const WORKSPACE_HEADER = "x-openbot-workspace";

/** One reviewed REST path the selection pair may ride as headers. */
export interface ScopeHeaderPathEntry {
  readonly id: string;
  readonly prefix: string;
  readonly reason: string;
  readonly ownerTicket: string;
}

/**
 * The closed inventory of reviewed same-origin REST paths the mobile client may carry the
 * selection pair on (MT105 / Issue #148).
 *
 * The families are the same ones the web client's inventory reviews (`client.ts`, MT081 onward):
 * the mobile app is another client of the same deployment API, so the review that admitted a
 * family on the web admits the mobile client onto it — and a family neither ticket reviewed stays
 * undecorated until one does. Widening this list is a review, not an accident.
 */
export const SCOPE_HEADER_ALLOWED_PATHS: readonly ScopeHeaderPathEntry[] = [
  {
    id: "enterprise-api",
    prefix: "/api/enterprise/",
    reason:
      "the enterprise API is the scope middleware's own surface: it resolves the selection pair into a trusted scope (MT005 ruling #1 — the headers only select; database membership decides)",
    ownerTicket: "MT105",
  },
  {
    id: "agents-rest",
    prefix: "/api/agents",
    reason:
      "the coworker surface's reads and writes, the same family the web review admitted (MT084); the server consumes the pair when the legacy assembly reads it (MT125)",
    ownerTicket: "MT105",
  },
  {
    id: "team-bots-rest",
    prefix: "/api/team-bots",
    reason:
      "the Team Bot publication surface, the same family the web review admitted (MT085)",
    ownerTicket: "MT105",
  },
  {
    id: "approvals-rest",
    prefix: "/api/approvals",
    reason:
      "the approval surface, the same family the web review admitted (MT086)",
    ownerTicket: "MT105",
  },
  {
    id: "responsibilities-rest",
    prefix: "/api/responsibilities",
    reason:
      "the standing-responsibility surface, the same family the web review admitted (MT086)",
    ownerTicket: "MT105",
  },
  {
    id: "computers-rest",
    prefix: "/api/computers",
    reason:
      "the computer surface — the fleet, its action boundary and the live screen it streams, the same family the web review admitted (MT086)",
    ownerTicket: "MT105",
  },
  {
    id: "channels-rest",
    prefix: "/api/channels",
    reason:
      "the conversation surface — roster, detail, attachments and member writes, the same family the web review admitted (MT087)",
    ownerTicket: "MT105",
  },
  {
    id: "groups-rest",
    prefix: "/api/groups",
    reason:
      "the group-conversation surface, the same family the web review admitted (MT087)",
    ownerTicket: "MT105",
  },
  {
    id: "plugins-rest",
    prefix: "/api/plugins",
    reason:
      "the plugin surface, the same family the web review admitted (MT088)",
    ownerTicket: "MT105",
  },
  {
    id: "memory-rest",
    prefix: "/api/memory",
    reason:
      "the personal/company memory surface, the same family the web review admitted",
    ownerTicket: "MT105",
  },
  {
    id: "routines-rest",
    prefix: "/api/routines",
    reason:
      "the routine surface, the same family the web review admitted",
    ownerTicket: "MT105",
  },
  {
    id: "craft-rest",
    prefix: "/api/craft",
    reason:
      "the craft surface — sessions, files, artifacts and their downloads, the same family the web review admitted",
    ownerTicket: "MT105",
  },
  {
    id: "workshop-rest",
    prefix: "/api/workshop",
    reason:
      "the workshop surface — turns, artifacts and their uploads/downloads, the same family the web review admitted",
    ownerTicket: "MT105",
  },
  {
    id: "marketplace-rest",
    prefix: "/api/marketplace",
    reason:
      "the marketplace surface, the same family the web review admitted",
    ownerTicket: "MT105",
  },
  {
    id: "components-rest",
    prefix: "/api/components",
    reason:
      "the component surface, the same family the web review admitted",
    ownerTicket: "MT105",
  },
  {
    id: "billing-rest",
    prefix: "/api/billing",
    reason:
      "the billing surface, the same family the web review admitted (MT097)",
    ownerTicket: "MT105",
  },
  {
    id: "voice-mobile-aggregate-rest",
    prefix: "/api/voice/mobile",
    reason:
      "the mobile aggregation snapshot surface — the BFF shape MT066's readMobileAggregate answers behind the voice family, whose every sub-query must answer under the scope the client currently holds. The review admitting the family is MT107's own ticket; the server's HTTP wiring of the exact route lands with MT125, and the client pair rides the moment it does",
    ownerTicket: "MT107",
  },
];

/** One reviewed stream path the selection pair may ride as query parameters. */
export interface ScopeStreamPathEntry {
  readonly id: string;
  readonly prefix: string;
  readonly reason: string;
  readonly ownerTicket: string;
}

/**
 * The closed inventory of reviewed same-origin stream paths the mobile client may carry the
 * selection pair on — the same five connection families the web inventory reviews (MT082),
 * because the mobile app opens the same streams against the same deployment.
 */
export const SCOPE_STREAM_ALLOWED_PATHS: readonly ScopeStreamPathEntry[] = [
  {
    id: "workshop-turn-events",
    prefix: "/api/workshop/",
    reason:
      "the workshop turn stream: an SSE read, which cannot carry request headers, so the pair rides the query on the one URL family this stream opens",
    ownerTicket: "MT105",
  },
  {
    id: "craft-turn-events",
    prefix: "/api/craft/",
    reason:
      "the craft session's turn and scheduled-run stream reads: same connection family as the workshop stream",
    ownerTicket: "MT105",
  },
  {
    id: "channel-roster-events",
    prefix: "/api/channels/events",
    reason:
      "the channel roster's event stream: an upgrade or SSE read, which cannot carry request headers, so the pair rides the query",
    ownerTicket: "MT105",
  },
  {
    id: "computer-screen-stream",
    prefix: "/api/computers/",
    reason:
      "the live computer screen stream: an upgrade request, which cannot carry request headers, so the pair rides the query",
    ownerTicket: "MT105",
  },
  {
    id: "voice-call-establishment",
    prefix: "/api/voice/calls",
    reason:
      "the POST that establishes a voice call — the stream's subscription moment; the realtime socket it returns is a third-party origin and never receives the pair",
    ownerTicket: "MT105",
  },
];

/** Whether a path is same-origin shaped for this client: a root-relative path, not protocol-relative. */
function sameOriginPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//");
}

/**
 * The header half of the pair, for REST-shaped requests (fetch can carry headers).
 *
 * `null` (personal context: no company/team selected) attaches NOTHING — a missing selection is
 * carried as absent, never defaulted. A path outside the inventory, or one that is not a
 * same-origin relative path, is left undecorated: the pair must not leak onto a surface no ticket
 * reviewed (AC1).
 */
export function scopeHeaders(
  path: string,
  selection: ScopeSelection | null,
): Record<string, string> | null {
  if (selection === null) return null;
  if (!sameOriginPath(path)) return null;
  const bare = path.split("?")[0] as string;
  if (
    !SCOPE_HEADER_ALLOWED_PATHS.some((entry) => bare.startsWith(entry.prefix))
  ) {
    return null;
  }
  return {
    [TENANT_HEADER]: selection.tenantId,
    [WORKSPACE_HEADER]: selection.workspaceId,
  };
}

/**
 * The query half of the pair, for stream-shaped connections (SSE reads and WebSocket upgrades
 * cannot carry request headers).
 *
 * Same gates as `scopeHeaders`: same-origin relative paths on the reviewed stream inventory only,
 * existing query parameters preserved (a stream's resume cursor rides the same URL), and a `null`
 * selection changes nothing at all.
 */
export function withStreamScope(
  path: string,
  selection: ScopeSelection | null,
): string {
  if (selection === null) return path;
  if (!sameOriginPath(path)) return path;
  const queryAt = path.indexOf("?");
  const bare = queryAt === -1 ? path : path.slice(0, queryAt);
  if (
    !SCOPE_STREAM_ALLOWED_PATHS.some((entry) => bare.startsWith(entry.prefix))
  ) {
    return path;
  }
  const pair =
    `${TENANT_HEADER}=${encodeURIComponent(selection.tenantId)}` +
    `&${WORKSPACE_HEADER}=${encodeURIComponent(selection.workspaceId)}`;
  return queryAt === -1 ? `${path}?${pair}` : `${path}&${pair}`;
}

/**
 * The typed refusal an answer earns when it outlived its scope — the mobile name for the web's
 * `TenantSelectionChangedError`, message included: an answer that arrives after the switch is
 * dropped, never applied to the scope that replaced the one it was asked under (AC3).
 */
export class TenantSelectionChangedError extends Error {
  constructor() {
    super("That answer outlived the tenant it was asked under.");
    this.name = "TenantSelectionChangedError";
  }
}

/**
 * One scope-bound fetch: the pair rides the URL as headers (REST) or query (streams) per the two
 * inventories, and the answer is refused on arrival if the generation moved while it was in
 * flight.
 *
 * `fetchLike` is injected (the app's fetch, a test's stand-in) so the rule runs identically in CI
 * with no runtime beneath it. A pending scope source refuses before dialing: a business read is
 * not established on a guess.
 */
export function createScopedFetch(options: {
  store: TenancyStore;
  fetchLike: (input: string, init?: { headers?: Record<string, string> }) => Promise<Response>;
}): (
  path: string,
  init?: { headers?: Record<string, string> },
) => Promise<Response> {
  return async (path, init) => {
    const scope = options.store.scope();
    if (scope.status === "pending") {
      throw new Error("The scope source has not answered yet.");
    }
    const at = scope.generation;
    const headers = scopeHeaders(path, scope.selection);
    const streamPath = withStreamScope(path, scope.selection);
    const response = await options.fetchLike(streamPath, {
      ...init,
      ...(headers === null ? {} : { headers: { ...init?.headers, ...headers } }),
    });
    if (!options.store.stillCurrent(at)) {
      throw new TenantSelectionChangedError();
    }
    return response;
  };
}

/**
 * A stream subscription bound to the live scope (AC2/AC4).
 *
 * `open(url)` is the app's connection factory (its EventSource/WebSocket adapter); this wrapper
 * owns WHEN it opens and when it tears down: never while the scope source is pending, always
 * under the CURRENT selection at (re)connect — never a defaulted one — and torn down the moment
 * the scope key moves (a pair change or a generation advance, i.e. a switch anywhere), with the
 * old connection's late frames dropped by the generation check `frameStillCurrent`.
 *
 * The app drives reconnects itself (its runtime owns backoff); every reconnect calls `reopen()`,
 * which re-reads the scope world fresh — a dropped line that comes back answers under the scope
 * that is current THEN (AC4).
 */
export function createScopeBoundStream(options: {
  store: TenancyStore;
  open: (url: string) => { close: () => void };
}): {
  /** Open (or reopen) under the current scope; refuses while the scope source is pending. */
  reopen: (path: string) => { url: string; generation: number } | { refused: "scope-pending" };
  /** Tear the live connection down, if one is open. */
  close: () => void;
  /** The scope key the live connection was opened under, for change detection. */
  openedKey: () => string | null;
  /** Whether a frame from the live connection may still be applied (the generation rule). */
  frameStillCurrent: (generation: number) => boolean;
} {
  let live: { connection: { close: () => void }; key: string; generation: number } | null = null;
  return {
    reopen(path) {
      const scope = options.store.scope();
      if (scope.status === "pending") return { refused: "scope-pending" };
      // Reconnects answer under the CURRENT selection — never the one the dropped line had.
      live?.connection.close();
      const url = withStreamScope(path, scope.selection);
      live = {
        connection: options.open(url),
        key: scope.key,
        generation: scope.generation,
      };
      return { url, generation: scope.generation };
    },
    close() {
      live?.connection.close();
      live = null;
    },
    openedKey() {
      return live?.key ?? null;
    },
    frameStillCurrent(generation) {
      // A frame from a connection opened at `generation` may not decorate a screen whose scope
      // has since moved — the belt for a frame already in flight through the teardown.
      return live !== null && live.generation === generation && options.store.stillCurrent(generation);
    },
  };
}

/**
 * The media cache key for one URI: names the user's scope beside the URI itself, so the same
 * company file cached under two scopes is two entries, and an entry filed under one scope is
 * simply not found after a switch (AC2: the old scope's media is no longer served).
 *
 * Filed through the tenancy store's own bucket (the same prefix a switch drops wholesale), so
 * media isolation rides the SAME removal discipline as every other business entry — no second
 * cache to keep in step.
 */
export function mediaCacheKey(store: TenancyStore, uri: string): string {
  return `media:${store.cachePrefix()}:${uri}`;
}

/** Read one URI's cached media bytes through the store (absent after a switch, by the store's rule). */
export function readMediaCache<T>(
  store: TenancyStore,
  uri: string,
): { status: "present"; value: T } | { status: "absent" } {
  return store.read<T>(mediaCacheKey(store, uri));
}

/** Cache one URI's media under the current scope only. */
export function writeMediaCache(
  store: TenancyStore,
  uri: string,
  value: unknown,
): void {
  store.write(mediaCacheKey(store, uri), value);
}
