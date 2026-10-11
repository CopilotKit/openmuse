import { formatDate } from "./i18n/format.ts";
import { translate } from "./i18n/locale.ts";

/**
 * Relative time for activity timestamps. Values slightly in the future are
 * clock skew and still read as just now; further future values fall back to a
 * date instead of claiming they just happened.
 */
export function relativeDate(value: string, now = Date.now(), locale = "en"): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  const diff = now - parsed;
  if (diff < -60_000) return dayLabel(parsed, locale);
  const elapsed = Math.max(0, diff);
  if (elapsed < 60_000) return translate(locale, "time.justNow");
  if (elapsed < 3600_000)
    return translate(locale, "time.minutesAgo", { count: Math.floor(elapsed / 60_000) });
  if (elapsed < 86400_000)
    return translate(locale, "time.hoursAgo", { count: Math.floor(elapsed / 3600_000) });
  return dayLabel(parsed, locale);
}

function dayLabel(value: number, locale: string): string {
  return formatDate(new Date(value).toISOString(), locale, { month: "short", day: "numeric" });
}
