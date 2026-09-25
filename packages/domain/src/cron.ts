// Minimal 5-field cron parser with timezone-aware next-fire computation.
// Fields: minute hour day-of-month month day-of-week.
// Per field supports "*", lists (1,15), ranges (9-17) and steps (*/15, 9-17/2).
// Numbers only (no month/day names). Day-of-week accepts 0-6 and 7 (Sunday).
export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}
interface CronSchedule {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}
function parseField(
  raw: string,
  min: number,
  max: number,
  name: string,
): { values: Set<number>; restricted: boolean } {
  const field = raw.trim();
  if (!field) throw new CronError(`${name}: empty field`);
  const restricted = field !== "*";
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepRaw] = part.split("/");
    if (stepRaw !== undefined && !/^\d+$/.test(stepRaw))
      throw new CronError(`${name}: bad step in "${part}"`);
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (step < 1) throw new CronError(`${name}: step must be >= 1 in "${part}"`);
    let start: number;
    let end: number;
    if (range === "*") {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) throw new CronError(`${name}: bad range "${part}"`);
      start = Number(a);
      end = Number(b);
      if (start > end) throw new CronError(`${name}: range start > end in "${part}"`);
    } else {
      if (!/^\d+$/.test(range)) throw new CronError(`${name}: bad value "${part}"`);
      start = Number(range);
      end = Number(range);
    }
    if (start < min || end > max)
      throw new CronError(`${name}: value out of range ${min}-${max} in "${part}"`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (!values.size) throw new CronError(`${name}: no values`);
  return { values, restricted };
}
export function parseCron(expression: string): CronSchedule {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new CronError(
      `Expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
    );
  const minute = parseField(parts[0], 0, 59, "minute");
  const hour = parseField(parts[1], 0, 23, "hour");
  const dayOfMonth = parseField(parts[2], 1, 31, "day of month");
  const month = parseField(parts[3], 1, 12, "month");
  const dayOfWeek = parseField(parts[4], 0, 7, "day of week");
  if (dayOfWeek.values.has(7)) {
    dayOfWeek.values.delete(7);
    dayOfWeek.values.add(0);
  }
  return {
    minute: minute.values,
    hour: hour.values,
    dayOfMonth: dayOfMonth.values,
    month: month.values,
    dayOfWeek: dayOfWeek.values,
    dayOfMonthRestricted: dayOfMonth.restricted,
    dayOfWeekRestricted: dayOfWeek.restricted,
  };
}
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function assertTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new CronError(`Unknown timezone "${timezone}"`);
  }
}
function zonedParts(date: Date, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const weekday = WEEKDAYS.indexOf(parts.weekday);
  if (weekday < 0) throw new CronError(`Could not resolve weekday in "${timezone}"`);
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    weekday,
  };
}
const MAX_MINUTES = 366 * 24 * 60;
// Next fire time strictly after `from`, matched against wall-clock fields in `timezone`.
export function nextCronRun(expression: string, timezone: string, from: Date): Date {
  const cron = parseCron(expression);
  assertTimezone(timezone);
  let candidate = Math.floor(from.getTime() / 60000) * 60000 + 60000;
  for (let i = 0; i < MAX_MINUTES; i++, candidate += 60000) {
    const at = new Date(candidate);
    const part = zonedParts(at, timezone);
    if (!cron.minute.has(part.minute)) continue;
    if (!cron.hour.has(part.hour)) continue;
    if (!cron.month.has(part.month)) continue;
    const domMatch = cron.dayOfMonth.has(part.day);
    const dowMatch = cron.dayOfWeek.has(part.weekday);
    const dayMatch =
      cron.dayOfMonthRestricted && cron.dayOfWeekRestricted
        ? domMatch || dowMatch
        : cron.dayOfMonthRestricted
          ? domMatch
          : cron.dayOfWeekRestricted
            ? dowMatch
            : true;
    if (!dayMatch) continue;
    return at;
  }
  throw new CronError("No fire time within 366 days");
}
