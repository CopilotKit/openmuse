/**
 * Clips untrusted text (page text, mail bodies, titles) at a UTF-16 limit
 * without splitting a surrogate pair: a lone half of a pair is not a
 * character, renders as a replacement character and breaks consumers that
 * encode the result to UTF-8. When the cut lands between a pair's high and
 * low half, the high half is dropped with it.
 */
export function clipText(text: string, limit: number): string {
  const clipped = text.slice(0, limit);
  return text.length > limit && /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped;
}
