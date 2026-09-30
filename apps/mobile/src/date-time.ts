import type { CalendarEvent } from "../../../packages/domain/src/index";

/** Format a timed event in its calendar's named time zone. */
export function localDateTime(value: string, timeZone: string): { date: string; time: string } {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()))
    return { date: value.slice(0, 10), time: value.slice(11, 16) };
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (name: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === name)?.value || "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}
/** Resolve a local wall-clock time, rejecting gaps at daylight-saving transitions. */
export function zonedInstant(date: string, time: string, timeZone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time))
    throw new Error("Enter a complete date and time.");
  const desired = Date.parse(`${date}T${time}:00Z`);
  if (
    !Number.isFinite(desired) ||
    new Date(desired).toISOString().slice(0, 16) !== `${date}T${time}`
  )
    throw new Error("Choose a valid date and time.");
  let candidate = desired;
  for (let pass = 0; pass < 4; pass++) {
    const local = localDateTime(new Date(candidate).toISOString(), timeZone);
    const actual = Date.parse(`${local.date}T${local.time}:00Z`);
    const delta = desired - actual;
    if (delta === 0) return new Date(candidate).toISOString();
    candidate += delta;
  }
  throw new Error("This time does not exist in the selected time zone. Choose another time.");
}

/** Instant range for an event; all-day events cover their date in the event's own zone. */
export function calendarInterval(
  event: Pick<CalendarEvent, "start" | "end" | "allDay" | "timeZone">,
): { start: number; end: number } | null {
  try {
    const start = event.allDay ? zonedInstant(event.start, "00:00", event.timeZone) : event.start;
    const end = event.allDay ? zonedInstant(event.end, "00:00", event.timeZone) : event.end;
    const from = Date.parse(start);
    const to = Date.parse(end);
    return Number.isFinite(from) && Number.isFinite(to) ? { start: from, end: to } : null;
  } catch {
    return null;
  }
}

/** Half-open overlap: events that only touch at a boundary are not a conflict. */
export function calendarOverlap(
  left: Pick<CalendarEvent, "start" | "end" | "allDay" | "timeZone">,
  right: Pick<CalendarEvent, "start" | "end" | "allDay" | "timeZone">,
): boolean {
  const a = calendarInterval(left);
  const b = calendarInterval(right);
  return Boolean(a && b && a.start < b.end && a.end > b.start);
}

/** Only fully serialized instants may reset a date editor's local text. */
export function isCompleteInstant(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
