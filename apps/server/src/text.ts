// String.prototype.toWellFormed is ES2024; this project type-checks against lib ES2023.
const unpairedSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Shorten text to at most `limit` UTF-16 units without cutting a surrogate pair in half,
 * then replace unpaired surrogates the source itself supplied with U+FFFD.
 *
 * Text that becomes part of a saved record passes through here: page, mail, search and
 * prompt-derived values. A lone surrogate survives JSON.stringify as a `\udXXX` escape that
 * Postgres refuses in a jsonb value, so a clip landing between the pair failed the durable
 * write and lost the work it had already gathered.
 */
export function clip(value: string, limit: number): string {
  const units = value.slice(0, limit);
  const tail = units.charCodeAt(units.length - 1);
  return (tail >= 0xd800 && tail <= 0xdbff ? units.slice(0, -1) : units).replace(
    unpairedSurrogate,
    "\uFFFD",
  );
}
