// String.prototype.toWellFormed is ES2024; this project type-checks against lib ES2023.
const unpairedSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Replace every unpaired surrogate with U+FFFD, so the result can be encoded as UTF-8 and
 * parsed as JSON. A lone surrogate survives JSON.stringify as a `\udXXX` escape that Postgres
 * refuses inside a jsonb value (22P02), which fails the whole durable write.
 */
export function wellFormed(value: string): string {
  return value.replace(unpairedSurrogate, "\uFFFD");
}

/**
 * Shorten text to at most `limit` UTF-16 units without cutting a surrogate pair in half, then
 * repair unpaired surrogates the source itself supplied. Bounded page, mail, search, calendar,
 * monitor and prompt text that becomes part of a saved record passes through here.
 *
 * A bound that lands inside a pair drops the dangling high surrogate instead of replacing it.
 * Callers such as the browser worker hand over text they already clipped at the same limit, so
 * the trailing unit is a real cut and the shorter result is the bound the caller asked for. Any
 * other lone surrogate is replaced, so the result is always well formed.
 */
export function clip(value: string, limit: number): string {
  const units = value.slice(0, limit);
  const tail = units.charCodeAt(units.length - 1);
  const cut = tail >= 0xd800 && tail <= 0xdbff;
  return wellFormed(cut ? units.slice(0, -1) : units);
}
