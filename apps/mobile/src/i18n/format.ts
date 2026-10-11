import { resolveLocale } from "./locale.ts";

/** Format a calendar date in the active interface locale. Unparseable values stay unchanged. */
export function formatDate(
  value: string,
  locale: string,
  options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" },
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(resolveLocale(locale), options);
}

/** Format a clock time in the active interface locale. Unparseable values stay unchanged. */
export function formatTime(value: string, locale: string, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(resolveLocale(locale), {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
}
