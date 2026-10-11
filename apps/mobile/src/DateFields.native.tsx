import { View } from "react-native";
import { i18n } from "./i18n";
import { Field } from "./ui";
export interface DateFieldsProps {
  label: string;
  date: string;
  time: string;
  allDay: boolean;
  onChange: (date: string, time: string) => void;
}
export default function DateFields({ label, date, time, allDay, onChange }: DateFieldsProps) {
  return (
    <View style={{ flexDirection: "row", gap: 12 }}>
      <View style={{ flex: 1.2 }}>
        <Field
          label={i18n.t("a11y.datePart", { label })}
          value={date}
          onChangeText={(value) => onChange(value, time)}
          placeholder="YYYY-MM-DD"
          keyboardType="numbers-and-punctuation"
        />
      </View>
      {!allDay && (
        <View style={{ flex: 1 }}>
          <Field
            label={i18n.t("a11y.timePart", { label })}
            value={time}
            onChangeText={(value) => onChange(date, value)}
            placeholder={i18n.t("date.hourHint")}
            keyboardType="numbers-and-punctuation"
          />
        </View>
      )}
    </View>
  );
}
