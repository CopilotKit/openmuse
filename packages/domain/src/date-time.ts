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

/**
 * The first existing instant of a local day. Day-range boundaries are an internal
 * computation, not a user-entered appointment time, so when a DST gap removes
 * midnight (e.g. America/Santiago springs forward 00:00→01:00) the boundary
 * clamps to the first existing local time instead of failing the whole query.
 */
export function startOfZonedDay(date: string, timeZone: string): string {
  try {
    return zonedInstant(date, "00:00", timeZone);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("does not exist")) throw error;
  }
  for (let minutes = 1; minutes < 24 * 60; minutes++) {
    const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    try {
      return zonedInstant(date, time, timeZone);
    } catch {
      // Still inside the gap; keep walking toward the first existing time.
    }
  }
  throw new Error("This day has no existing local time in the selected time zone.");
}

export interface EventStartLike {
  start: string;
  allDay?: boolean;
  timeZone?: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function eventStartMs(event: EventStartLike): number {
  if (event.allDay || DATE_ONLY.test(event.start)) {
    // A date-only start names a day, not an instant: Date.parse would read it
    // as midnight UTC, which lands inside the previous day west of Greenwich.
    // Anchor it to the start of that day in the event's own time zone.
    try {
      return Date.parse(startOfZonedDay(event.start.slice(0, 10), event.timeZone || "UTC"));
    } catch {
      return Number.NaN;
    }
  }
  return Date.parse(event.start);
}

/**
 * Order events by the instant they start. All-day events sit at the start of
 * their day in their own time zone. When either start cannot be parsed,
 * Date.parse yields NaN and subtraction would make the comparator inconsistent,
 * so fall back to the previous text comparison, which is always total.
 */
export function compareEventStart(a: EventStartLike, b: EventStartLike): number {
  const aMs = eventStartMs(a);
  const bMs = eventStartMs(b);
  if (Number.isFinite(aMs) && Number.isFinite(bMs)) return aMs - bMs;
  return a.start.localeCompare(b.start);
}
