/**
 * Generated plugin config UI.
 *
 * PluginConfigForm renders a config editor from a plugin's
 * openmuse.plugin.json configSchema — the mobile counterpart of the
 * manifest-driven connector tabs. Fields come from buildConfigFields()
 * (see ./config-fields.ts); this file only renders them.
 *
 * SECURITY: writeOnly (password-widget) fields render secureTextEntry with NO
 * prefilled value and submit "" when left blank, which the server treats as
 * "leave the stored secret unchanged". Secrets are never displayed.
 */
import { useMemo, useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { Button, Card, colors, Field, s } from "../ui";
import type { PluginConfigView } from "./api";
import { buildConfigFields, type ConfigField } from "./config-fields";

export interface PluginConfigPatch {
  enabled: boolean;
  config: Record<string, unknown>;
}

function EnumField({
  field,
  value,
  onChange,
}: {
  field: ConfigField;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <View style={s.field}>
      <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>{field.title}</Text>
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        {(field.options ?? []).map((option) => {
          const active = value === option;
          return (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              onPress={() => onChange(option)}
              style={[
                s.row,
                {
                  paddingVertical: 8,
                  paddingHorizontal: 14,
                  borderRadius: 18,
                  backgroundColor: active ? colors.blue : "#F1F2F3",
                },
              ]}
            >
              <Text style={[s.small, { color: colors.text, fontWeight: "600" }]}>{option}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function PluginConfigForm({
  view,
  busy,
  error,
  onSubmit,
}: {
  view: PluginConfigView;
  busy?: boolean;
  error?: string | null;
  onSubmit: (patch: PluginConfigPatch) => void;
}) {
  const fields = useMemo(() => buildConfigFields(view), [view]);
  const [enabled, setEnabled] = useState(view.enabled);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.secure) continue; // never prefill secrets
      initial[field.key] = field.value;
    }
    return initial;
  });
  const set = (key: string, value: unknown) => setValues((prev) => ({ ...prev, [key]: value }));

  const groups = useMemo(() => {
    const order = view.configGroups.length > 0 ? view.configGroups : ["general"];
    const byGroup = new Map<string, ConfigField[]>();
    for (const field of fields) {
      const group = field.group ?? order[0];
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group)?.push(field);
    }
    return order
      .filter((group) => byGroup.has(group))
      .map((group) => ({ group, fields: byGroup.get(group) ?? [] }));
  }, [fields, view.configGroups]);

  const submit = () => {
    const config: Record<string, unknown> = {};
    for (const field of fields) {
      if (!(field.key in values)) {
        // Untouched secure fields submit "" = "leave unchanged".
        if (field.secure) config[field.key] = "";
        continue;
      }
      const value = values[field.key];
      if (field.secure) {
        config[field.key] = typeof value === "string" && value !== "" ? value : "";
      } else if (field.kind === "number") {
        config[field.key] = value === "" ? "" : Number(value);
      } else {
        config[field.key] = value;
      }
    }
    onSubmit({ enabled, config });
  };

  return (
    <View style={{ gap: 16 }}>
      <Card>
        <View style={[s.row, { justifyContent: "space-between", alignItems: "center" }]}>
          <View style={{ flex: 1 }}>
            <Text style={[s.small, { fontWeight: "700", color: colors.text }]}>Enabled</Text>
            <Text style={[s.muted, { marginTop: 2 }]}>
              When off, the plugin&apos;s tools and routes stay dormant.
            </Text>
          </View>
          <Switch accessibilityLabel="Plugin enabled" value={enabled} onValueChange={setEnabled} />
        </View>
      </Card>

      {groups.map(({ group, fields: groupFields }) => (
        <View key={group} style={{ gap: 4 }}>
          {groups.length > 1 ? (
            <Text style={[s.small, { fontWeight: "700", color: colors.muted }]}>{group}</Text>
          ) : null}
          <Card>
            <View style={{ gap: 14 }}>
              {groupFields.map((field) => {
                if (field.kind === "boolean") {
                  return (
                    <View
                      key={field.key}
                      style={[s.row, { justifyContent: "space-between", alignItems: "center" }]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>
                          {field.title}
                        </Text>
                        {field.description ? (
                          <Text style={[s.muted, { marginTop: 2 }]}>{field.description}</Text>
                        ) : null}
                      </View>
                      <Switch
                        accessibilityLabel={field.title}
                        value={Boolean(values[field.key] ?? false)}
                        onValueChange={(value) => set(field.key, value)}
                      />
                    </View>
                  );
                }
                if (field.kind === "enum") {
                  return (
                    <EnumField
                      key={field.key}
                      field={field}
                      value={String(values[field.key] ?? "")}
                      onChange={(value) => set(field.key, value)}
                    />
                  );
                }
                return (
                  <Field
                    key={field.key}
                    label={field.title + (field.required ? " *" : "")}
                    value={String(values[field.key] ?? "")}
                    onChangeText={(text) => set(field.key, text)}
                    placeholder={
                      field.secure ? "Leave blank to keep the current secret" : field.description
                    }
                    secureTextEntry={field.secure}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType={field.kind === "number" ? "numeric" : "default"}
                    maxLength={field.maxLength}
                  />
                );
              })}
            </View>
          </Card>
        </View>
      ))}

      {error ? <Text style={[s.small, { color: colors.danger }]}>{error}</Text> : null}

      <View style={[s.row, { justifyContent: "flex-end" }]}>
        <Button primary busy={busy} onPress={submit}>
          Save settings
        </Button>
      </View>
    </View>
  );
}
