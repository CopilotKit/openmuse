import {
  localDateTime,
  startOfZonedDay,
  zonedInstant,
} from "../../../packages/domain/src/date-time.ts";

export { compareEventStart } from "../../../packages/domain/src/date-time.ts";
export { localDateTime, startOfZonedDay, zonedInstant };

/** Only fully serialized instants may reset a date editor's local text. */
export function isCompleteInstant(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
