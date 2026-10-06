/**
 * Relative time for activity timestamps. Values slightly in the future are
 * clock skew and still read "Just now"; further future values fall back to a
 * date instead of claiming they just happened.
 */
export function relativeDate(value: string, now = Date.now()): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  const diff = now - parsed;
  if (diff < -60_000) return dayLabel(parsed);
  const elapsed = Math.max(0, diff);
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86400_000) return `${Math.floor(elapsed / 3600_000)}h ago`;
  return dayLabel(parsed);
}

function dayLabel(value: number): string {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
