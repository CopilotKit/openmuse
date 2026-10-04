/**
 * Browser-driven-request controls: is this request being issued by a page on
 * some OTHER site?
 *
 * LIFTED from cntrl `src/lib/security/local-endpoints.ts`, itself ported from
 * OmniRoute. What is lifted is the pair of controls that answer "who is the
 * REQUESTER"; what is deliberately NOT lifted is that file's locality policy,
 * because it is incompatible with this product. See DEVIATION below.
 *
 * ---------------------------------------------------------------------------
 * DEVIATION FROM SOURCE (read before assuming parity)
 * ---------------------------------------------------------------------------
 * cntrl's `isLocalRequestAllowed` also enforces LOCALITY: the `Host` header
 * must be loopback, the first `x-forwarded-for` hop must be absent or loopback,
 * a shared bearer token may substitute, and a production build refuses outright
 * without an explicit opt-in. That policy is correct for cntrl, a desktop app
 * whose whole surface is host execution.
 *
 * OpenMuse is the opposite shape. Requirement 3 of the product is that the
 * server is the central control plane the user reaches from a phone and a
 * desktop alike, `ALLOWED_ORIGINS` deliberately lists non-loopback origins, and
 * live mode requires `HOST` to be non-loopback. Imposing loopback locality on
 * the execution surfaces would break the product's central requirement while
 * adding nothing an attacker crossing the network does not already have to
 * defeat at the session-token boundary.
 *
 * So the boundary this file supports is: *an authenticated session, not a page
 * on someone else's site*. Auth is `Auth.session`/`Auth.device`; this file is
 * what stops a browser from manufacturing one of those authenticated writes
 * out of a victim's ambient credentials. Locality is enforced where it is
 * actually true in this product — `readConfig` already refuses a non-loopback
 * HOST in sample mode.
 *
 * ---------------------------------------------------------------------------
 * WHY `Origin` ALONE WAS NOT ENOUGH (the cntrl finding, still true here)
 * ---------------------------------------------------------------------------
 * `app.ts` already rejects a request whose `Origin` is not allowlisted. That
 * check cannot be the whole control for two reasons, both of which survive the
 * lift:
 *
 *   1. It reads a header the CALLER can influence. `app.ts` treats a MISSING
 *      Origin as allowed, correctly — non-browser callers (the Expo client,
 *      curl, tests) send none and are not the threat model. But that same
 *      leniency means the check is only ever as good as a browser attaching
 *      the header, and `Sec-Fetch-Site` is a second, independent signal that
 *      states the relationship directly instead of requiring it to be re-derived.
 *   2. It says nothing about preflight. A cross-origin write is CORS-simple
 *      only because `text/plain` / `application/x-www-form-urlencoded` /
 *      `multipart/form-data` avoid a preflight. Every JSON-parsing mutation
 *      route here parses those bytes anyway.
 *
 * That second property is why `isCorsSimpleWrite` exists and why it is applied
 * to the execution surfaces only, not globally: OpenMuse's own `POST /api/files`
 * legitimately reads `multipart/form-data` via `c.req.parseBody()`, so a
 * blanket rule would refuse a real feature. It is scoped to routes whose bodies
 * are JSON, which is what makes the rule true.
 */
import { isIP } from "node:net";

export type RequestOriginVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Is `value` an identity that denotes this host?
 *
 * Deliberately NOT a string test. Accepts the literal name `localhost`, the
 * IPv6 loopback (bare or bracketed), and any IPv4 literal in 127.0.0.0/8.
 * Anything that is neither a parseable IP nor exactly `localhost` is rejected,
 * so an attacker-registrable DNS name can never satisfy it by resembling one.
 *
 * (cntrl's source tested `/^127\.|^::1$|^localhost$/`, whose `^127\.`
 * alternative is an UNANCHORED PREFIX over a hostname rather than an address
 * test. Measured there: it accepted `127.evil.com` and `127.0.0.1.nip.io`. The
 * inconsistency gave it away — the `localhost` alternative in the same regex
 * was fully anchored. The fix is preserved below rather than re-copied from
 * cntrl, because a guard nobody exercises is what let that defect ship there.)
 */
export function isLoopbackAddress(value: string): boolean {
  // Strip an optional port first. This function is called with a `host:port`
  // pair from `URL.host`, and cntrl's original compared against the bare
  // literals — so `localhost:8081`, the single most common local origin there
  // is, would have failed the `=== "localhost"` arm.
  const host = value
    .trim()
    .toLowerCase()
    // Port FIRST, then brackets: `[::1]:8081` becomes `[::1]` and then `::1`.
    // The other order leaves `::1]:8081`, which matches nothing.
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) === 4) return host.split(".")[0] === "127";
  return false;
}

/** Header bag + method, so both this module and its tests can supply a fake. */
export interface RequestOriginLike {
  headers: { get(name: string): string | null };
  method?: string | undefined;
}

/**
 * Is a WebSocket upgrade's `Origin` safe to accept?
 *
 * SEPARATE FROM {@link isCrossSiteRequest} ON PURPOSE. `Origin` on a WebSocket
 * handshake names the ATTACKER (`https://evil.example`), not the target, and
 * WebSockets are exempt from the same-origin policy and carry no preflight —
 * so nothing else stops the connection being established. That is cross-site
 * WebSocket hijacking.
 *
 * OpenMuse has no WebSocket surface today (task streaming is SSE), so this is
 * lifted as the guard the device-side agent loop and pairing work will need
 * rather than left to be reinvented when a WS route first appears. A MISSING
 * Origin is allowed: browsers always send one on a WS handshake, so absence
 * means a non-browser client, which is not this threat model.
 */
export function isLocalWebSocketOrigin(origin: string | null | undefined): RequestOriginVerdict {
  if (origin === null || origin === undefined || origin === "") return { allowed: true };
  // Sandboxed iframes and file:// send the literal "null". Never local.
  if (origin === "null") return { allowed: false, reason: "null origin" };
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return { allowed: false, reason: "unparseable origin" };
  }
  return isLoopbackAddress(host)
    ? { allowed: true }
    : { allowed: false, reason: "cross-site websocket origin" };
}

/**
 * Is this request driven by a page on a site other than this one?
 *
 * `Sec-Fetch-Site` is checked first: it is browser-set, unforgeable from
 * script, and states the relationship directly. `same-site` is disqualifying
 * too — a sibling subdomain is not this origin.
 *
 * A MISSING Origin is NOT treated as cross-site. Non-browser callers send none,
 * and a CSRF attack is by definition mounted through a browser, which always
 * sends one here. Failing closed on absence would break the Expo client to
 * defend against an attacker who is not the one being modelled.
 */
export function isCrossSiteRequest(request: RequestOriginLike): RequestOriginVerdict {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site" || fetchSite === "same-site")
    return { allowed: false, reason: `cross-site request (sec-fetch-site: ${fetchSite})` };

  const origin = request.headers.get("origin");
  if (origin === null || origin === "") return { allowed: true };
  if (origin === "null") return { allowed: false, reason: "null origin" };
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    // Fail CLOSED: an Origin we cannot parse is one we cannot vouch for.
    return { allowed: false, reason: "unparseable origin" };
  }
  return isLoopbackAddress(host)
    ? { allowed: true }
    : { allowed: false, reason: "cross-site origin" };
}

/**
 * Types a browser can send on a write WITHOUT triggering a preflight. A write
 * declaring one of these reached the server even when the preflight would have
 * failed — which is why a JSON route that parses the bytes anyway is reachable
 * cross-site on the strength of the Origin check alone.
 *
 * The rule is "reject simple", not "require JSON": a request with NO
 * content-type is not the CORS-simple shape and never was, and refusing it
 * would break the mobile client and every test-constructed Request for no
 * threat gain.
 */
const CORS_SIMPLE_CONTENT_TYPES = new Set([
  "text/plain",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
]);

const NON_MUTATING_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isCorsSimpleWrite(request: RequestOriginLike): RequestOriginVerdict {
  const method = request.method;
  // No method means a header-only caller, not an HTTP request. Nothing to
  // classify; the Origin rule is what protects those.
  if (method === undefined || NON_MUTATING_METHODS.has(method.toUpperCase()))
    return { allowed: true };
  const raw = request.headers.get("content-type");
  // Absence is NOT the attack shape — see the note above.
  if (raw === null || raw === "") return { allowed: true };
  // A parameterised type (`text/plain; charset=utf-8`) is what browsers
  // actually send, so match the media type before the `;`.
  const mediaType = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  if (CORS_SIMPLE_CONTENT_TYPES.has(mediaType))
    return {
      allowed: false,
      reason: `cors-simple content-type on a write (${mediaType}); this route parses JSON and must be preflighted`,
    };
  return { allowed: true };
}

/**
 * The composed verdict for a route that executes processes on the server's
 * host (or in a container it owns) on behalf of a session.
 *
 * ORDER IS LOAD-BEARING and both checks come before any other consideration:
 * a caller learns only that the request is refused, never which of the two
 * controls refused it. `app.ts` evaluates the Origin allowlist separately and
 * earlier; this is the part that does not depend on that allowlist being
 * correctly configured.
 *
 * Fails CLOSED on a missing request: a caller that forgot to pass one must not
 * silently receive an allow.
 */
export function isBrowserDrivenRequestAllowed(
  request?: RequestOriginLike | null,
  controls: { crossSite: boolean; corsSimpleWrite: boolean } = {
    crossSite: true,
    corsSimpleWrite: true,
  },
): RequestOriginVerdict {
  if (!request) return { allowed: false, reason: "no request context" };
  if (controls.crossSite) {
    const crossSite = isCrossSiteRequest(request);
    if (!crossSite.allowed) return crossSite;
  }
  if (controls.corsSimpleWrite) {
    const simpleWrite = isCorsSimpleWrite(request);
    if (!simpleWrite.allowed) return simpleWrite;
  }
  return { allowed: true };
}
