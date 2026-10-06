/** Format a timed event in its calendar's named time zone. */
export function localDateTime(value: string, timeZone: string): { date: string; time: string } {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()))
    return { date: value.slice(0, 10), time: value.slice(11, 16) };
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    era: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (name: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === name)?.value || "";
  const year = Number(part("year"));
  const isoYear = part("era") === "BC" ? 1 - year : year;
  const yearLabel =
    isoYear < 0 || isoYear > 9999
      ? `${isoYear < 0 ? "-" : "+"}${String(Math.abs(isoYear)).padStart(6, "0")}`
      : String(isoYear).padStart(4, "0");
  return {
    date: `${yearLabel}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}
