/**
 * Helpers for calling APIs whose option objects are compiled without
 * `exactOptionalPropertyTypes`.
 *
 * Under that flag, `{ signal: maybeUndefined }` is not assignable to a target
 * whose `signal?: AbortSignal` means "absent or an AbortSignal, never an explicit
 * undefined". Node, `fetch`, the E2B SDK and the model SDKs all predate the flag,
 * so callers here cannot opt out per dependency — they have to omit the key.
 *
 * These helpers keep that omission in one place instead of scattering
 * `...(x ? { x } : {})` across every call site. Falsy-but-meaningful values are
 * never involved: the inputs are all objects, strings, or abort signals.
 */

/** Omit keys whose value is `undefined`, so the object matches strict-optional targets. */
export function defined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) if (entry !== undefined) out[key] = entry;
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}

/** `RequestInit`/`fetch` init with undefined-valued keys removed. */
export function requestInit(init: {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): RequestInit {
  return defined(init);
}

/** Assign to an optional property only when the value is present. */
export function setIfPresent<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}
