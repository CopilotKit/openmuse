import type { Cookie, CookieParam } from "@cloudflare/puppeteer";
import { DemoError, publicUrl } from "./core";

export const CHECKPOINT_LIMIT = 524_288;

export interface PageStorage {
  origin: string;
  local: [string, string][];
  session: [string, string][];
  scrollX: number;
  scrollY: number;
}

export interface BrowserCheckpoint {
  version: 1;
  savedAt: string;
  url: string;
  title: string;
  cookies: CookieParam[];
  storage: PageStorage;
}

export function encodeCheckpoint(checkpoint: BrowserCheckpoint): string {
  publicUrl(checkpoint.url);
  if (new URL(checkpoint.url).origin !== checkpoint.storage.origin)
    throw new DemoError("页面在保存期间跳转了，请重新保存", 409, "checkpoint_changed");
  const encoded = JSON.stringify(checkpoint);
  if (new TextEncoder().encode(encoded).byteLength > CHECKPOINT_LIMIT)
    throw new DemoError("浏览器存档超过 512 KiB，未覆盖之前的存档", 413, "checkpoint_too_large");
  return encoded;
}

export function checkpointInfo(checkpoint: BrowserCheckpoint) {
  return {
    savedAt: checkpoint.savedAt,
    url: checkpoint.url,
    title: checkpoint.title,
    cookieCount: checkpoint.cookies.length,
    storageItems: checkpoint.storage.local.length + checkpoint.storage.session.length,
  };
}

export function restorableCookies(cookies: CookieParam[], now = Date.now() / 1000): CookieParam[] {
  return cookies.filter((cookie) => cookie.expires === undefined || cookie.expires > now);
}

export function cookieParameters(cookie: Cookie): CookieParam {
  return {
    name: cookie.name,
    value: cookie.value,
    // Host-only cookies (including __Host- cookies) must retain their host scope.
    ...(cookie.domain.startsWith(".")
      ? { domain: cookie.domain }
      : {
          url: `${cookie.secure ? "https" : "http"}://${cookie.domain}/`,
        }),
    path: cookie.path,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    priority: cookie.priority,
    sourceScheme: cookie.sourceScheme,
    ...(cookie.expires > 0 ? { expires: cookie.expires } : {}),
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
  };
}
