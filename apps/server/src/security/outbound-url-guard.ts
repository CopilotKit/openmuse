/**
 * Outbound URL guard — blocks SSRF on operator-supplied and model-supplied
 * destinations.
 *
 * LIFTED from cntrl `src/lib/security/outbound-url-guard.ts`, which in turn
 * ported it verbatim from OmniRoute v3.8.49. Kept as a lift, not a fork: this
 * file is OpenMuse's, the env prefix is OpenMuse's, and the wiring below is
 * OpenMuse's. Every private-range test, the empty-host-is-private default, the
 * unconditional cloud-metadata block and the protocol/embedded-credential
 * rejections are preserved unchanged — those were the parts worth having.
 *
 * WHY OPENMUSE NEEDS IT
 *
 * Two classes of destination reach `fetch` in this server, and they were both
 * unvalidated at the time this was lifted:
 *
 *   1. Operator-supplied endpoints: `BROWSER_WORKER_URL` and `AGENT_URL`. These
 *      come from the environment, so they are not attacker input — but a
 *      misconfigured or copied `.env` pointing at `169.254.169.254` turns the
 *      server into a cloud-credential relay, and it is exactly the failure the
 *      browser worker already guards against for *its* destinations.
 *   2. Per-request rebinding. Checking a URL once at boot is a lexical check
 *      with a short shelf life; `resolveOutboundHost` re-resolves and
 *      re-validates immediately before the socket opens, which is what makes it
 *      a guard rather than a startup assertion.
 *
 * WHAT IS NOT BUILT — do not read a guarantee into the above:
 *
 *   1. NO IP PINNING. `resolveOutboundHost` returns the addresses that passed;
 *     it does not force the subsequent connection onto one of them. Node's
 *     global fetch gives no per-request address override without a custom
 *     Agent/Dispatcher, and this repo adds no dependency for it. A resolver
 *     that answers benignly to this lookup and privately to the connect()
 *      milliseconds later remains a live TOCTOU rebinding window. This is a
 *     RISK REDUCTION, not a closure.
 *   2. The browser worker guards *browser* destinations separately and more
 *     strictly (`apps/worker/src/network.ts` requires a global-unicast
 *     address). Nothing here replaces that; this governs the server's own
 *     outbound calls.
 *
 * `lookupFn` is an injection seam so tests can drive resolution without DNS.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export const PRIVATE_URL_BLOCKED_MESSAGE = "Blocked private or local outbound URL";
export const CLOUD_METADATA_BLOCKED_MESSAGE = "Blocked cloud-metadata endpoint";

/**
 * 'block-metadata' allows private/LAN hosts but still rejects cloud-metadata
 * and link-local endpoints (the SSRF -> IAM-credential pivot). It never
 * relaxes the metadata block.
 */
export type OutboundUrlGuardMode = "none" | "public-only" | "block-metadata";
export type OutboundUrlGuardErrorCode = "OUTBOUND_URL_GUARD_BLOCKED" | "OUTBOUND_URL_INVALID";

export class OutboundUrlGuardError extends Error {
  readonly code: OutboundUrlGuardErrorCode;
  readonly url: string;
  readonly hostname: string | null;

  constructor(
    message: string,
    init: { code: OutboundUrlGuardErrorCode; url: string; hostname?: string | null },
  ) {
    super(message);
    this.name = "OutboundUrlGuardError";
    this.code = init.code;
    this.url = init.url;
    this.hostname = init.hostname ?? null;
  }
}

function normalizeHost(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) return normalized.slice(1, -1);
  return normalized;
}

/** Private/reserved IPv4 ranges, in one place so the two call paths cannot drift. */
function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map((segment) => Number.parseInt(segment, 10));
  const a = octets[0];
  const b = octets[1];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * Unwraps an IPv4-mapped / IPv4-compatible IPv6 address to its dotted-quad
 * form, returning null when `host` is not such an address.
 *
 * WHY: WHATWG `URL` canonicalizes the embedded IPv4 literal into hex groups, so
 * `new URL("http://[::ffff:169.254.169.254]/").hostname` is `[::ffff:a9fe:a9fe]`
 * and a string test for `169.254.` never fires. Both spellings must be decoded:
 * `::ffff:a9fe:a9fe` (what URL produces) and `::ffff:169.254.169.254` (what a
 * human writes). The deprecated compatible form `::a9fe:a9fe` routes to the
 * same v4 destination and is handled here too.
 */
function unmapIpv4MappedHost(host: string): string | null {
  if (isIP(host) !== 6) return null;
  const dotted = host.match(/:((?:\d{1,3}\.){3}\d{1,3})$/);
  const dottedAddress = dotted?.[1];
  if (dottedAddress !== undefined && isIP(dottedAddress) === 4) return dottedAddress;
  const hex = host.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  const high = hex?.[1];
  const low = hex?.[2];
  if (high !== undefined && low !== undefined) {
    const highWord = Number.parseInt(high, 16);
    const lowWord = Number.parseInt(low, 16);
    if (Number.isFinite(highWord) && Number.isFinite(lowWord))
      return [highWord >> 8, highWord & 0xff, lowWord >> 8, lowWord & 0xff].join(".");
  }
  return null;
}

const CLOUD_METADATA_HOSTNAMES = new Set([
  "169.254.169.254", // AWS / GCP / Azure / Oracle IMDS
  "metadata.google.internal", // GCP
  "metadata.goog", // GCP
  "100.100.100.200", // Alibaba Cloud
  "fd00:ec2::254", // AWS IPv6 IMDS
]);

function matchesMetadataLiteral(host: string): boolean {
  if (CLOUD_METADATA_HOSTNAMES.has(host)) return true;
  // The whole IPv4 link-local /16, not just the well-known hostnames.
  if (host.startsWith("169.254.")) return true;
  return false;
}

export function isPrivateHost(hostname: string): boolean {
  const normalized = normalizeHost(hostname);
  // An empty host is private: fail closed rather than guess.
  if (!normalized) return true;

  if (
    normalized === "localhost" ||
    normalized === "0.0.0.0" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    // `.internal` is reserved for private use and is the suffix GCP/Azure
    // metadata probes use (metadata.google.internal).
    normalized.endsWith(".internal") ||
    // IPv4-mapped IPv6 is private WHOLESALE rather than decoded. That
    // over-blocks a mapped public address such as `::ffff:8.8.8.8`; retained
    // deliberately, because no legitimate endpoint here is written in mapped
    // notation and decoding it would open a second lexical path to keep in
    // sync. The IPv6 branch below decodes the forms that are not
    // self-identifying.
    normalized.startsWith("::ffff:")
  )
    return true;

  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);

  if (isIP(normalized) === 6) {
    if (
      normalized === "::1" ||
      // The unspecified address. `0.0.0.0` is already private above and `::` is
      // its IPv6 spelling, routing to local interfaces the same way.
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    )
      return true;
    // Re-test the IPv4 destination behind an IPv4-in-IPv6 wrapper. The mapped
    // `::ffff:` form already matched the prefix above, but the deprecated
    // IPv4-COMPATIBLE form (`::7f00:1`) has no `ffff:` marker and would
    // otherwise return false — a full bypass of `public-only`.
    const unmapped = unmapIpv4MappedHost(normalized);
    return unmapped !== null ? isPrivateIpv4(unmapped) : false;
  }

  return false;
}

/**
 * Cloud-metadata and IPv4 link-local endpoints are the classic SSRF ->
 * IAM-credential pivot and have no legitimate use here. Blocked
 * UNCONDITIONALLY, even when private targets are explicitly opted in.
 */
export function isCloudMetadataHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host) return false;
  // Unmap BEFORE the literal test so `::ffff:169.254.169.254` is caught by it.
  const unmapped = unmapIpv4MappedHost(host);
  return matchesMetadataLiteral(unmapped ?? host);
}

export function parseOutboundUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(String(input));
  } catch {
    throw new OutboundUrlGuardError(`Invalid outbound URL: ${String(input)}`, {
      code: "OUTBOUND_URL_INVALID",
      url: String(input),
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new OutboundUrlGuardError(`Invalid outbound URL protocol for ${url.toString()}`, {
      code: "OUTBOUND_URL_INVALID",
      url: url.toString(),
      hostname: url.hostname || null,
    });
  if (url.username || url.password)
    throw new OutboundUrlGuardError("Blocked outbound URL with embedded credentials", {
      code: "OUTBOUND_URL_GUARD_BLOCKED",
      url: url.toString(),
      hostname: url.hostname || null,
    });
  return url;
}

/** Allows private/LAN hosts (a worker on 127.0.0.1 is normal) but ALWAYS
 * rejects cloud-metadata / link-local endpoints. */
export function parseAndValidateNonMetadataUrl(input: string | URL): URL {
  const url = parseOutboundUrl(input);
  if (isCloudMetadataHost(url.hostname))
    throw new OutboundUrlGuardError(CLOUD_METADATA_BLOCKED_MESSAGE, {
      code: "OUTBOUND_URL_GUARD_BLOCKED",
      url: url.toString(),
      hostname: url.hostname || null,
    });
  return url;
}

export function parseAndValidatePublicUrl(input: string | URL): URL {
  const url = parseOutboundUrl(input);
  if (isPrivateHost(url.hostname))
    throw new OutboundUrlGuardError(PRIVATE_URL_BLOCKED_MESSAGE, {
      code: "OUTBOUND_URL_GUARD_BLOCKED",
      url: url.toString(),
      hostname: url.hostname || null,
    });
  return url;
}

export function applyUrlGuard(input: string | URL, mode: OutboundUrlGuardMode): URL {
  if (mode === "none") return parseOutboundUrl(input);
  if (mode === "block-metadata") return parseAndValidateNonMetadataUrl(input);
  // 'public-only' is strict: every metadata host is also private/link-local,
  // so the private test subsumes it.
  return parseAndValidatePublicUrl(input);
}

// ---------------------------------------------------------------------------
// Policy layer (env only)
// ---------------------------------------------------------------------------

const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

/** Full opt-out of private-host blocking. Default OFF. */
export const PRIVATE_OUTBOUND_URLS_ENV = "OPENMUSE_ALLOW_PRIVATE_OUTBOUND_URLS";
/** Require public destinations even for LAN endpoints. Default OFF (local-first). */
export const PUBLIC_ONLY_OUTBOUND_URLS_ENV = "OPENMUSE_REQUIRE_PUBLIC_OUTBOUND_URLS";

function isTrueValue(raw: string | undefined): boolean {
  return raw !== undefined && TRUE_ENV_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Guard mode for operator-configured endpoints. Precedence:
 *   1. explicit full opt-in            -> 'none'
 *   2. explicit public-only requirement -> 'public-only'
 *   3. local-first default             -> 'block-metadata'
 *
 * OpenMuse is local-first: the browser worker normally runs on 127.0.0.1, so
 * `public-only` cannot be the default. Cloud-metadata is blocked in every mode
 * except the full opt-out.
 */
export function outboundGuardMode(env: NodeJS.ProcessEnv = process.env): OutboundUrlGuardMode {
  if (isTrueValue(env[PRIVATE_OUTBOUND_URLS_ENV])) return "none";
  if (isTrueValue(env[PUBLIC_ONLY_OUTBOUND_URLS_ENV])) return "public-only";
  return "block-metadata";
}

// ---------------------------------------------------------------------------
// DNS resolve-then-validate (anti-rebinding). Read the "WHAT IS NOT BUILT"
// paragraph in the file header before treating this as a closure.
// ---------------------------------------------------------------------------

export type OutboundDnsLookup = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

export type ResolvedOutboundHost = {
  hostname: string;
  /** Addresses returned by the resolver, all of which passed the guard. */
  addresses: string[];
};

/**
 * True when a RESOLVED address denotes cloud metadata / IPv4 link-local.
 * Distinct from {@link isCloudMetadataHost} only in that the input is known to
 * be a literal; it still routes through the IPv4-mapped decode so an AAAA
 * answer of `::ffff:169.254.169.254` is rejected exactly like the bare v4
 * literal.
 */
export function isBlockedResolvedAddress(address: string, mode: OutboundUrlGuardMode): boolean {
  const host = normalizeHost(address);
  if (!host) return true; // fail closed on a garbage answer
  const unmapped = unmapIpv4MappedHost(host);
  for (const candidate of unmapped === null ? [host] : [host, unmapped]) {
    if (matchesMetadataLiteral(candidate)) return true;
    if (mode === "public-only" && isPrivateHost(candidate)) return true;
  }
  return false;
}

/**
 * Resolves `hostname` and rejects if ANY returned address violates `mode`.
 *
 * Fails CLOSED: a resolver error, or an empty answer set, throws rather than
 * reading as "nothing bad found". A caller that cannot resolve a host cannot
 * safely reach it either.
 */
export async function resolveOutboundHost(
  hostname: string,
  mode: OutboundUrlGuardMode,
  lookupFn?: OutboundDnsLookup,
): Promise<ResolvedOutboundHost> {
  const host = normalizeHost(hostname);
  if (!host)
    throw new OutboundUrlGuardError(PRIVATE_URL_BLOCKED_MESSAGE, {
      code: "OUTBOUND_URL_GUARD_BLOCKED",
      url: hostname,
      hostname: hostname || null,
    });

  const blocked = (message: string, code: OutboundUrlGuardErrorCode): OutboundUrlGuardError =>
    new OutboundUrlGuardError(message, { code, url: host, hostname: host });

  // An IP literal has nothing to resolve; the lexical guards already classified
  // it, and re-running them keeps one exit path for both shapes.
  if (isIP(host) !== 0) {
    if (isBlockedResolvedAddress(host, mode))
      throw blocked(
        matchesMetadataLiteral(unmapIpv4MappedHost(host) ?? host)
          ? CLOUD_METADATA_BLOCKED_MESSAGE
          : PRIVATE_URL_BLOCKED_MESSAGE,
        "OUTBOUND_URL_GUARD_BLOCKED",
      );
    return { hostname: host, addresses: [host] };
  }

  // Static import, NOT `await import(...)`: the dynamic form throws under
  // `--experimental-vm-modules` the moment this runs from a real fetch path.
  const lookup = lookupFn ?? (dnsLookup as unknown as OutboundDnsLookup);

  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw blocked(`Unable to resolve outbound host ${host}`, "OUTBOUND_URL_INVALID");
  }
  if (!Array.isArray(records) || records.length === 0)
    throw blocked(`Unable to resolve outbound host ${host}`, "OUTBOUND_URL_INVALID");

  for (const record of records as readonly unknown[]) {
    // Typed as `unknown` and narrowed deliberately: the declared resolver shape
    // is non-nullable, but this is a TRUST BOUNDARY with an untrusted answer, so
    // a malformed record must fail closed rather than reach `isIP` as `[object
    // Object]` and read as "not an IP, therefore fine".
    const address =
      typeof record === "object" && record !== null && "address" in record
        ? String((record as { address: unknown }).address ?? "")
        : "";
    if (isBlockedResolvedAddress(address, mode))
      throw blocked(
        matchesMetadataLiteral(
          unmapIpv4MappedHost(normalizeHost(address)) ?? normalizeHost(address),
        )
          ? CLOUD_METADATA_BLOCKED_MESSAGE
          : PRIVATE_URL_BLOCKED_MESSAGE,
        "OUTBOUND_URL_GUARD_BLOCKED",
      );
  }
  return { hostname: host, addresses: records.map((record) => String(record.address)) };
}

export type DnsGuardedUrl = {
  url: URL;
  /** Addresses that passed the guard. NOT pinned onto any connection. */
  addresses: string[];
};

/**
 * Async counterpart of {@link applyUrlGuard}: lexical guard first, then
 * resolve-then-validate. `mode: 'none'` skips both, matching the synchronous
 * function's contract.
 */
export async function applyUrlGuardWithDns(
  input: string | URL,
  mode: OutboundUrlGuardMode,
  lookupFn?: OutboundDnsLookup,
): Promise<DnsGuardedUrl> {
  const url = applyUrlGuard(input, mode);
  if (mode === "none") return { url, addresses: [] };
  const resolved = await resolveOutboundHost(url.hostname, mode, lookupFn);
  return { url, addresses: resolved.addresses };
}
