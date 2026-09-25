/**
 * Pure form-generation logic for plugin config screens.
 *
 * buildConfigFields() turns a PluginConfigView (GET /api/plugins/:id/config)
 * into an ordered list of field descriptors — one per configSchema property.
 * This module is UI-framework-free so it can be unit-tested in plain node;
 * apps/mobile/src/connectors/generated.tsx renders the descriptors.
 *
 * SECURITY: the server redacts writeOnly values to "" in the config view and
 * this module never invents a value for a secure field — the rendered form
 * must show secureTextEntry with no prefilled text, and submit "" to mean
 * "leave the stored secret unchanged".
 */
import type { PluginConfigProperty, PluginConfigView } from "./api";

export type ConfigFieldKind = "string" | "number" | "boolean" | "enum";

export interface ConfigField {
  key: string;
  title: string;
  description?: string;
  kind: ConfigFieldKind;
  /**
   * widget === "password" (or listed in writeOnly): render a secure input and
   * NEVER prefill it. value is always "" for secure fields.
   */
  secure: boolean;
  group?: string;
  options?: string[];
  required: boolean;
  /** Current value for non-secure fields; "" for secure fields (redacted). */
  value: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

function fieldKind(prop: PluginConfigProperty): ConfigFieldKind {
  if (prop.enum && prop.enum.length > 0) return "enum";
  if (prop.type === "boolean" || prop.widget === "switch") return "boolean";
  if (prop.type === "number" || prop.type === "integer") return "number";
  return "string";
}

export function buildConfigFields(view: PluginConfigView): ConfigField[] {
  const properties = view.configSchema.properties ?? {};
  const required = new Set(view.configSchema.required ?? []);
  const writeOnly = new Set(view.writeOnly ?? []);
  return Object.entries(properties).map(([key, prop]) => {
    // Belt and braces: the server validates writeOnly ⇒ widget "password",
    // but a secure-looking field must never be prefilled even if the server
    // contract ever loosened.
    const secure = prop.widget === "password" || writeOnly.has(key);
    return {
      key,
      title: prop.title ?? key,
      description: prop.description,
      kind: fieldKind(prop),
      secure,
      group: prop.group,
      options: prop.enum,
      required: required.has(key),
      value: secure ? "" : (view.config[key] ?? prop.default ?? ""),
      minLength: prop.minLength,
      maxLength: prop.maxLength,
      minimum: prop.minimum,
      maximum: prop.maximum,
    };
  });
}

/**
 * Build the PATCH body from edited values. Secure fields the user left blank
 * submit "" (server: "leave the stored secret unchanged"); untouched
 * non-secure fields are omitted so the server keeps their current values.
 */
export function buildConfigPatch(
  fields: ConfigField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of fields) {
    if (!(field.key in values)) continue;
    const value = values[field.key];
    if (field.secure) {
      config[field.key] = typeof value === "string" && value !== "" ? value : "";
    } else if (field.kind === "number") {
      const n = typeof value === "string" ? Number(value) : value;
      config[field.key] = value === "" ? "" : n;
    } else {
      config[field.key] = value;
    }
  }
  return config;
}
