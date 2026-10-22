import { View } from "react-native";
import { t } from "./strings";
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
          label={t("labelDate", { label })}
          value={date}
          onChangeText={(value) => onChange(value, time)}
          placeholder={t("phDate")}
          keyboardType="numbers-and-punctuation"
        />
      </View>
      {!allDay && (
        <View style={{ flex: 1 }}>
          <Field
            label={t("labelTime", { label })}
            value={time}
            onChangeText={(value) => onChange(date, value)}
            placeholder={t("phTime")}
            keyboardType="numbers-and-punctuation"
          />
        </View>
      )}
    </View>
  );
}
