import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import DateFields from "./DateFields";
import { isCompleteInstant, localDateTime, zonedInstant } from "./date-time";
import { colors, s } from "./ui";

// An unknown time zone surfaces as Intl's RangeError; the other errors are already readable.
function editorError(e: unknown) {
  if (e instanceof RangeError) return "Choose a valid time zone.";
  return e instanceof Error ? e.message : String(e);
}

export default function DateTimeEditor({
  label,
  value,
  timeZone,
  allDay,
  onChange,
}: {
  label: string;
  value: string;
  timeZone: string;
  allDay: boolean;
  onChange: (value: string) => void;
}) {
  const [date, setDate] = useState(value.slice(0, 10));
  const [time, setTime] = useState("09:00");
  const [error, setError] = useState("");
  useEffect(() => {
    try {
      if (allDay) {
        setDate(value.slice(0, 10));
        setError("");
      } else if (isCompleteInstant(value)) {
        const local = localDateTime(value, timeZone);
        setDate(local.date);
        setTime(local.time);
        setError("");
      } else if (value === `${date} ${time}`) {
        // A date or time entered while the zone was invalid; convert it now the zone changed.
        onChange(zonedInstant(date, time, timeZone));
        setError("");
      }
    } catch (e) {
      setError(editorError(e));
    }
  }, [value, timeZone, allDay]);
  function change(nextDate: string, nextTime: string) {
    setDate(nextDate);
    setTime(nextTime);
    setError("");
    if (allDay) {
      onChange(nextDate);
      return;
    }
    try {
      onChange(zonedInstant(nextDate, nextTime, timeZone));
    } catch (e) {
      onChange(`${nextDate} ${nextTime}`);
      setError(editorError(e));
    }
  }
  return (
    <View>
      <DateFields label={label} date={date} time={time} allDay={allDay} onChange={change} />
      {!!error && (
        <Text style={[s.small, { color: colors.danger, marginBottom: 12 }]}>{error}</Text>
      )}
    </View>
  );
}
