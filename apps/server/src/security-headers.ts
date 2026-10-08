import type { Context } from "hono";
import type { Config } from "./config.ts";

/**
 * Response hardening for the API edge.
 *
 * The API previously sent only `X-Content-Type-Options`, `Referrer-Policy`
 * and `Cache-Control`. Signed file/preview/console links are bearer-equivalent
 * URLs that users open in a browser, so without framing and content policies
 * any third-party page could embed them (clickjacking) and any injected markup
 * in an HTML response would run unsandboxed.
 *
 * Two first-party embeds constrain the design, both verified in the clients:
 * - `apps/mobile/src/BrowserConsole.web.tsx` loads `/api/browsers/:id/console`
 *   in an `<iframe>` from the web-app origin.
 * - `apps/mobile/src/PdfReader.web.tsx` loads `/api/files/:id/content` (PDF)
 *   in an `<iframe>` from the web-app origin.
 * A blanket `DENY`/`SAMEORIGIN` would break those embeds because the web app
 * runs on a different origin than the API, so framing is restricted with a
 * `frame-ancestors` allowlist built from the configured clients instead, and
 * byte responses (PDF/PNG) carry framing protection only — no content
 * directives that could interfere with plugin/image rendering.
 */

/** First-party origins permitted to frame API responses. */
export function frameAncestorSources(config: Config): string[] {
  const sources = ["'self'"];
  for (const entry of [...config.allowedOrigins, config.publicUrl]) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      const origin = new URL(trimmed).origin;
      if (origin !== "null" && !sources.includes(origin)) sources.push(origin);
    } catch {
      // Unparseable entries never match an Origin header either; leaving them
      // out keeps the directive valid instead of breaking the whole header.
    }
  }
  return sources;
}

export function frameAncestorsDirective(config: Config): string {
  return `frame-ancestors ${frameAncestorSources(config).join(" ")}`;
}

/** Single source of truth for bearer-equivalent signed routes (see app.ts auth gate). */
export const signedFileContentPattern = /^\/api\/files\/[^/]+\/content$/;
export const browserPreviewPattern = /^\/api\/browsers\/[^/]+\/preview$/;
export const browserConsolePattern = /^\/api\/browsers\/[^/]+\/console$/;

export function isSignedRoute(path: string): boolean {
  return (
    signedFileContentPattern.test(path) ||
    browserPreviewPattern.test(path) ||
    browserConsolePattern.test(path)
  );
}

export function isConsolePage(method: string, path: string): boolean {
  return method === "GET" && browserConsolePattern.test(path);
}

export function isByteRoute(method: string, path: string): boolean {
  return (
    method === "GET" && (signedFileContentPattern.test(path) || browserPreviewPattern.test(path))
  );
}

export function isFileDownload(method: string, path: string): boolean {
  return method === "GET" && signedFileContentPattern.test(path);
}

/** Directives preserved from the browser-console route when it is centralized here. */
export const consoleContentPolicyBase =
  "default-src 'self'; img-src 'self' blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'";

export function contentSecurityPolicy(method: string, path: string, config: Config): string {
  const framing = frameAncestorsDirective(config);
  // The console is an HTML page that fetches its preview over the network, so
  // it keeps its script/style allowances and only gains framing protection.
  if (isConsolePage(method, path)) return `${consoleContentPolicyBase}; ${framing}`;
  // Byte responses: framing protection only, so plugin/image rendering is untouched.
  if (isByteRoute(method, path)) return framing;
  // JSON, OAuth pages, and everything else: nothing may load or submit anywhere.
  return `default-src 'none'; base-uri 'none'; form-action 'none'; ${framing}`;
}

/** File downloads render in an iframe PDF viewer on web (PdfReader.web.tsx),
 * whose fullscreen button needs the delegation, so `fullscreen` stays enabled there. */
const defaultPermissionsPolicy =
  "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), " +
  "magnetometer=(), gyroscope=(), accelerometer=(), ambient-light-sensor=(), " +
  "autoplay=(), encrypted-media=(), fullscreen=(), picture-in-picture=()";
const filePermissionsPolicy =
  "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), " +
  "magnetometer=(), gyroscope=(), accelerometer=(), ambient-light-sensor=(), " +
  "autoplay=(), encrypted-media=(), picture-in-picture=()";

export function permissionsPolicy(method: string, path: string): string {
  return isFileDownload(method, path) ? filePermissionsPolicy : defaultPermissionsPolicy;
}

/** Headers that are identical on every response. */
export function baseSecurityHeaders(config: Config): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
  // Browsers ignore HSTS on plaintext, and emitting it there would be a lie in
  // local/sample setups, so only advertise it when the public URL is https.
  try {
    if (new URL(config.publicUrl).protocol === "https:")
      headers["Strict-Transport-Security"] = "max-age=15552000; includeSubDomains";
  } catch {
    // An invalid public URL fails fast in createApp before this ever matters.
  }
  return headers;
}

/**
 * Single builder for both response paths. The framing directive only depends
 * on config, so it (and every policy derived from it) is built once at
 * startup instead of on every request.
 *
 * Handlers that return a raw `Response` (the CopilotKit stream passthrough)
 * bypass context headers, so they use `headersFor()` to apply the exact same
 * policy the middleware sets.
 */
export function createEdgeHeaders(config: Config) {
  const framing = frameAncestorsDirective(config);
  const strictCsp = `default-src 'none'; base-uri 'none'; form-action 'none'; ${framing}`;
  const consoleCsp = `${consoleContentPolicyBase}; ${framing}`;
  const byteCsp = framing;
  const base = baseSecurityHeaders(config);

  const cspFor = (method: string, path: string): string => {
    if (isConsolePage(method, path)) return consoleCsp;
    if (isByteRoute(method, path)) return byteCsp;
    return strictCsp;
  };

  const headersFor = (method: string, path: string): Record<string, string> => ({
    ...base,
    // The API serves data, never media capture: deny the powerful features outright.
    "Permissions-Policy": permissionsPolicy(method, path),
    "Content-Security-Policy": cspFor(method, path),
  });

  const middleware = async (c: Context, next: () => Promise<void>) => {
    for (const [name, value] of Object.entries(headersFor(c.req.method, c.req.path)))
      c.header(name, value);
    await next();
  };

  return { base, cspFor, headersFor, middleware };
}

/**
 * Sets hardening headers on every response, including error responses produced
 * by `onError`. Handlers that return a raw `Response` (the CopilotKit stream
 * passthrough) bypass context headers and must apply these explicitly via
 * `createEdgeHeaders(config).headersFor()`.
 */
export function securityHeaders(config: Config) {
  return createEdgeHeaders(config).middleware;
}
