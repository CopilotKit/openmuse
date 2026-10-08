import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { AppError } from "./errors.ts";

interface RateLimitEntry {
  count: number;
  expiresAt: number;
}

export interface RateLimitStoreOptions {
  windowMs?: number;
  maxRequests?: number;
  maxEntries?: number;
}

export function createRateLimitStore(options: RateLimitStoreOptions = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const maxRequests = options.maxRequests ?? 120;
  const maxEntries = options.maxEntries ?? 10_000;
  const entries = new Map<string, RateLimitEntry>();

  function cleanupExpired(now: number) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
  }

  function take(key: string, now: number): boolean {
    const existing = entries.get(key);
    if (existing && existing.expiresAt > now) {
      // Active hit: refresh recency so eviction drops the
      // least-recently-active bucket, not merely the earliest-inserted one.
      existing.count += 1;
      entries.delete(key);
      entries.set(key, existing);
      return existing.count <= maxRequests;
    }
    // New key or expired renewal. Renewals must move to the back: Map.set() on
    // an existing key keeps its original (front) position, so an actively
    // signing-in client would otherwise be evicted before long-gone entries.
    const hadExpired = existing !== undefined;
    if (hadExpired) {
      entries.delete(key);
      // The window turned over for this key, so peers likely expired too:
      // reclaim them now instead of leaving stale buckets behind.
      cleanupExpired(now);
    }
    if (entries.size >= maxEntries) {
      cleanupExpired(now);
      if (entries.size >= maxEntries) {
        // Evict the least-recently-used entry instead of locking new keys out.
        // Failing closed here would reintroduce the lockout a per-client
        // limiter is meant to prevent (one crowded window blocks newcomers).
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
        else return false;
      }
    }
    const entry = { count: 1, expiresAt: now + windowMs };
    entries.set(key, entry);
    return entry.count <= maxRequests;
  }

  return { take, size: () => entries.size };
}

// This limiter runs before authentication, so the key must never be derived from
// caller-supplied credentials (e.g. Authorization): any string would mint a new bucket.
// When trusted, the client address is the hop our own proxy appended (the last
// entry in X-Forwarded-For), not the leftmost entry, which any caller can spoof.
export function resolveClientKey(input: {
  trustProxy: boolean;
  forwardedFor?: string;
  realIp?: string;
  connectionAddress?: string;
}): string {
  if (input.trustProxy) {
    const hops = input.forwardedFor
      ?.split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    const lastHop = hops?.length ? hops[hops.length - 1] : undefined;
    if (lastHop) return `proxy:${lastHop}`;
    if (input.realIp) return `proxy:${input.realIp}`;
  }
  return `conn:${input.connectionAddress ?? "unknown"}`;
}

// getConnInfo reads the raw Node socket, which only exists behind a real
// @hono/node-server listener; in-memory `app.request()` calls (as used in
// tests) have no socket, so this must degrade rather than throw.
function connectionAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

/** Per-client bucket key for routes with their own limiter (e.g. sign-in). */
export function resolveRequestKey(
  c: Context,
  trustProxy: boolean,
  getAddress: (c: Context) => string | undefined = connectionAddress,
): string {
  return resolveClientKey({
    trustProxy,
    forwardedFor: c.req.header("x-forwarded-for"),
    realIp: c.req.header("x-real-ip"),
    connectionAddress: getAddress(c),
  });
}

export function rateLimit(
  trustProxy: boolean,
  options: RateLimitStoreOptions & { getAddress?: (c: Context) => string | undefined } = {},
) {
  const store = createRateLimitStore(options);
  const getAddress = options.getAddress ?? connectionAddress;
  return async (c: Context, next: () => Promise<void>) => {
    // Health/readiness exemption lives in app.ts registration order (probes are
    // registered before this middleware), so this limiter stays route-agnostic.
    const key = resolveRequestKey(c, trustProxy, getAddress);
    if (!store.take(key, Date.now()))
      throw new AppError("Too many requests. Try again in a minute.", 429);
    await next();
  };
}
