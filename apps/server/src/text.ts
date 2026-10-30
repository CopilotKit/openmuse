/**
 * Clips untrusted text (page text, mail bodies, titles) at a UTF-16 limit
 * without splitting a surrogate pair: a lone half of a pair is not a
 * character, renders as a replacement character and breaks consumers that
 * encode the result to UTF-8. When the cut lands between a pair's high and
 * low half, the high half is dropped with it.
 *
 * Untrusted input may already contain a lone surrogate half — malformed
 * upstream, a bad copy/paste — that no cut of ours produced. Each lone half
 * is normalized to U+FFFD before the clip, the same treatment
 * `String.prototype.toWellFormed()` applies, so the result is always
 * well-formed UTF-16 and survives a UTF-8 encode even when no cut happens.
 */
const LONE_SURROGATE_HALF =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|[\uDC00-\uDFFF](?<![\uD800-\uDBFF])/gu;

export function clipText(text: string, limit: number): string {
  const wellFormed = text.replace(LONE_SURROGATE_HALF, "\uFFFD");
  const clipped = wellFormed.slice(0, limit);
  return (
    wellFormed.length > limit && /[\uD800-\uDBFF]$/.test(clipped)
      ? clipped.slice(0, -1)
      : clipped
  );
}
