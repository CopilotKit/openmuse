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

// Lines that differ only in numbers or relative times ("posted 1 day ago" → "posted 2 days
// ago", "58 minutes ago" → "1 hour ago", "3 comments") are updates, not news.
const relativeTime =
  /\b(?:\d+|an?|one)\s+(?:sec(?:ond)?|min(?:ute)?|hour|hr|day|week|month|year)s?\s+ago\b|\bvor\s+(?:\d+|einer?|einem)\s+(?:sekunde|minute|stunde|tag|woche|monat|jahr)(?:e|en|n)?\b/giu;
const shape = (line: string) =>
  line
    .replace(relativeTime, "<time>")
    .replace(/\d+(?:[.,]\d+)*/g, "#")
    .replace(/(\p{L})s\b/gu, "$1")
    .toLowerCase();

/** Whether anything besides numbers and relative times changed. */
export function meaningfulPageDiff(diff: PageDiff) {
  return diff.added.length > 0 || diff.removed.length > 0;
}

export function diffPage(previous: string[], current: string[]): PageDiff {
  const before = new Set(previous);
  const after = new Set(current);
  const beforeShapes = new Set(previous.map(shape));
  const afterShapes = new Set(current.map(shape));
  const changed = current.filter((line) => !before.has(line));
  return {
    added: changed.filter((line) => !beforeShapes.has(shape(line))),
    updated: changed.filter((line) => beforeShapes.has(shape(line))),
    removed: previous.filter((line) => !after.has(line) && !afterShapes.has(shape(line))),
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
