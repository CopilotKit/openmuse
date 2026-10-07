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
// tick on their own, so a change in them alone is not news.
const relativeTime =
  /\b(?:\d+|an?|one)\s+(?:sec(?:ond)?|min(?:ute)?|hour|hr|day|week|month|year)s?\s+ago\b|\bvor\s+(?:\d+|einer?|einem)\s+(?:sekunde|minute|stunde|tag|woche|monat|jahr)(?:e|en|n)?\b/giu;

/** Text with relative times blanked out: equal results mean only those times changed. */
export function withoutRelativeTimes(text: string) {
  return text.replace(relativeTime, "<time>");
}

// Any other number change (a price, stock count or version) is news, listed as an update.
const numberless = (line: string) =>
  withoutRelativeTimes(line)
    .replace(/\d+(?:[.,]\d+)*/g, "#")
    .replace(/(\p{L})s\b/gu, "$1")
    .toLowerCase();

/**
 * Pairs each current line with one unused previous line of the same key, so one remaining
 * line can never account for another that was removed.
 */
function pair(previous: string[], current: string[], key: (line: string) => string) {
  const open = new Map<string, string[]>();
  for (const line of previous) open.set(key(line), [...(open.get(key(line)) ?? []), line]);
  const used = new Set<string>();
  const paired: string[] = [];
  const unpaired: string[] = [];
  for (const line of current) {
    const match = open.get(key(line))?.shift();
    if (match === undefined) unpaired.push(line);
    else {
      used.add(match);
      paired.push(line);
    }
  }
  return { paired, unpaired, left: previous.filter((line) => !used.has(line)) };
}

export function diffPage(previous: string[], current: string[]): PageDiff {
  const same = pair(previous, current, (line) => line);
  // A line where only a relative time changed is left out.
  const retimed = pair(same.left, same.unpaired, withoutRelativeTimes);
  const renumbered = pair(retimed.left, retimed.unpaired, numberless);
  return { added: renumbered.unpaired, updated: renumbered.paired, removed: renumbered.left };
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
