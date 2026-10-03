/** Lines of page text for comparing two checks of a watched page. */
export function pageLines(text: string, limit = 2000): string[] {
  const lines = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim().slice(0, 300);
    if (line) lines.add(line);
    if (lines.size >= limit) break;
  }
  return [...lines];
}

export type PageDiff = { added: string[]; updated: string[]; removed: string[] };

// Relative times ("posted 1 day ago" → "posted 2 days ago", "58 minutes ago" → "1 hour ago")
// tick on their own, so a line where only they changed is not news and is left out.
const relativeTime =
  /\b(?:\d+|an?|one)\s+(?:sec(?:ond)?|min(?:ute)?|hour|hr|day|week|month|year)s?\s+ago\b|\bvor\s+(?:\d+|einer?|einem)\s+(?:sekunde|minute|stunde|tag|woche|monat|jahr)(?:e|en|n)?\b/giu;
const timeless = (line: string) => line.replace(relativeTime, "<time>");
// Any other number change (a price, stock count or version) is news, listed as an update.
const numberless = (line: string) =>
  timeless(line)
    .replace(/\d+(?:[.,]\d+)*/g, "#")
    .replace(/(\p{L})s\b/gu, "$1")
    .toLowerCase();

/** Whether any line was added, updated or removed. */
export function meaningfulPageDiff(diff: PageDiff) {
  return diff.added.length > 0 || diff.updated.length > 0 || diff.removed.length > 0;
}

export function diffPage(previous: string[], current: string[]): PageDiff {
  const before = new Set(previous);
  const after = new Set(current);
  const beforeTimeless = new Set(previous.map(timeless));
  const afterTimeless = new Set(current.map(timeless));
  const beforeNumberless = new Set(previous.map(numberless));
  const afterNumberless = new Set(current.map(numberless));
  const changed = current.filter(
    (line) => !before.has(line) && !beforeTimeless.has(timeless(line)),
  );
  return {
    added: changed.filter((line) => !beforeNumberless.has(numberless(line))),
    updated: changed.filter((line) => beforeNumberless.has(numberless(line))),
    removed: previous.filter(
      (line) =>
        !after.has(line) &&
        !afterTimeless.has(timeless(line)) &&
        !afterNumberless.has(numberless(line)),
    ),
  };
}

/** A short "New / Updated / Removed" summary, or "" when no line changed. */
export function describePageDiff(diff: PageDiff) {
  const section = (title: string, lines: string[], limit: number) => {
    if (!lines.length) return [];
    const shown = lines.slice(0, limit).map((line) => `• ${line.slice(0, 160)}`);
    const more = lines.length > limit ? [`+${lines.length - limit} more`] : [];
    return [`${title}:`, ...shown, ...more];
  };
  return [
    ...section("New", diff.added, 8),
    ...section("Updated", diff.updated, 4),
    ...section("Removed", diff.removed, 4),
  ].join("\n");
}

/** A one-line count for task results, such as "3 lines changed (2 new, 1 updated)". */
export function countPageDiff(diff: PageDiff) {
  const total = diff.added.length + diff.updated.length + diff.removed.length;
  if (!total) return "";
  const parts = [
    diff.added.length && `${diff.added.length} new`,
    diff.updated.length && `${diff.updated.length} updated`,
    diff.removed.length && `${diff.removed.length} removed`,
  ].filter(Boolean);
  return `${total} line${total === 1 ? "" : "s"} changed (${parts.join(", ")})`;
}
