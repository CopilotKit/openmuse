import { createHash } from "node:crypto";
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
    let entry = entries.get(key);
    if (entry && entry.expiresAt <= now) entry = undefined;
    if (!entry) {
      if (entries.size >= maxEntries) {
        cleanupExpired(now);
        if (entries.size >= maxEntries) return false;
      }
      entry = { count: 0, expiresAt: now + windowMs };
      entries.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= maxRequests;
  }

  return { take, size: () => entries.size };
}

export function resolveClientKey(input: {
  authorization?: string;
  trustProxy: boolean;
  forwardedFor?: string;
  realIp?: string;
  connectionAddress?: string;
}): string {
  if (input.authorization?.startsWith("Bearer "))
    return `session:${createHash("sha256").update(input.authorization).digest("hex")}`;
  if (input.trustProxy) {
    const forwarded = input.forwardedFor?.split(",")[0]?.trim();
    if (forwarded) return `proxy:${forwarded}`;
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

export function rateLimit(trustProxy: boolean, options?: RateLimitStoreOptions) {
  const store = createRateLimitStore(options);
  return async (c: Context, next: () => Promise<void>) => {
    const key = resolveClientKey({
      authorization: c.req.header("authorization"),
      trustProxy,
      forwardedFor: c.req.header("x-forwarded-for"),
      realIp: c.req.header("x-real-ip"),
      connectionAddress: connectionAddress(c),
    });
    if (!store.take(key, Date.now()))
      throw new AppError("Too many requests. Try again in a minute.", 429);
    await next();
  };
}
