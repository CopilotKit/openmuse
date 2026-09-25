/**
 * Deterministic validation for plugin configSchema (a JSON-Schema subset).
 * Zero model calls: pure structural checks.
 */
import type { ConfigPropertySchema, PluginManifest } from "./types.ts";

const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const TOOL_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const PROP_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{1,63}$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

/** Tool names that always perform a sensitive action. */
const RISKY_TOOL_NAME = /send|fill|login|delete/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateValue(
  schema: ConfigPropertySchema,
  value: unknown,
  path: string,
  redactSecrets: boolean,
  errors: string[],
): void {
  const label = redactSecrets ? path : `${path}=${JSON.stringify(value)?.slice(0, 80)}`;
  if (value === undefined) return;
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") return void errors.push(`${label}: expected string`);
      if (schema.minLength !== undefined && value.length < schema.minLength)
        errors.push(`${label}: shorter than minLength ${schema.minLength}`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength)
        errors.push(`${label}: longer than maxLength ${schema.maxLength}`);
      if (schema.pattern !== undefined) {
        let re: RegExp;
        try {
          re = new RegExp(schema.pattern);
        } catch {
          errors.push(`${path}: invalid pattern in schema`);
          break;
        }
        if (!re.test(value)) errors.push(`${label}: does not match required pattern`);
      }
      if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
        errors.push(`${label}: not a valid email`);
      if (schema.format === "uri") {
        try {
          new URL(value);
        } catch {
          errors.push(`${label}: not a valid URI`);
        }
      }
      if (schema.format === "hostname" && !/^[a-zA-Z0-9.-]{1,253}$/.test(value))
        errors.push(`${label}: not a valid hostname`);
      break;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value))
        return void errors.push(`${label}: expected number`);
      if (schema.minimum !== undefined && value < schema.minimum)
        errors.push(`${label}: below minimum ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum)
        errors.push(`${label}: above maximum ${schema.maximum}`);
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value))
        return void errors.push(`${label}: expected integer`);
      if (schema.minimum !== undefined && value < schema.minimum)
        errors.push(`${label}: below minimum ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum)
        errors.push(`${label}: above maximum ${schema.maximum}`);
      break;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${label}: expected boolean`);
      break;
    case "array":
      if (!Array.isArray(value)) errors.push(`${label}: expected array`);
      break;
    case "object":
      if (!isRecord(value)) errors.push(`${label}: expected object`);
      break;
    default:
      break;
  }
  if (schema.enum !== undefined && !schema.enum.some((option) => option === value))
    errors.push(`${label}: not one of the allowed values`);
}

/**
 * Validate a config object against a plugin's configSchema.
 * Returns human-readable errors; when redactSecrets is true (the default)
 * the offending values are never echoed — writeOnly values must never leak
 * into logs or error messages.
 */
export function validatePluginConfig(
  manifest: PluginManifest,
  values: unknown,
  options: { redactSecrets?: boolean; forbidUnknown?: boolean } = {},
): string[] {
  const { redactSecrets = true, forbidUnknown = true } = options;
  const errors: string[] = [];
  const schema = manifest.configSchema;
  if (!isRecord(values)) return ["config: expected an object"];
  const properties = schema.properties ?? {};
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(properties, key)) {
      if (forbidUnknown) errors.push(`config.${key}: unknown setting for plugin "${manifest.id}"`);
      continue;
    }
    validateValue(properties[key], values[key], `config.${key}`, redactSecrets, errors);
  }
  for (const key of schema.required ?? []) {
    if (values[key] === undefined) errors.push(`config.${key}: required`);
  }
  return errors;
}

/** Fill schema defaults for missing keys. Never mutates the input. */
export function applyConfigDefaults(
  manifest: PluginManifest,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...values };
  for (const [key, prop] of Object.entries(manifest.configSchema.properties ?? {}))
    if (result[key] === undefined && prop.default !== undefined) result[key] = prop.default;
  return result;
}

/** True when a config key is write-only (never rendered back, never logged). */
export function isWriteOnly(manifest: PluginManifest, key: string): boolean {
  return manifest.writeOnly.includes(key);
}

/**
 * Redact writeOnly values for API responses. The returned object has every
 * writeOnly key present but set to "" — the client can tell the field exists
 * without ever seeing the secret.
 */
export function redactConfigForResponse(
  manifest: PluginManifest,
  resolved: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...resolved };
  for (const key of manifest.writeOnly) if (key in result) result[key] = "";
  return result;
}

/** Reject path traversal in skills/ and cliCommands entries. */
export function hasPathTraversal(entries: string[]): string[] {
  return entries.filter((entry) =>
    entry.split(/[\\/]/).some((segment) => segment === ".." || segment === ""),
  );
}

/**
 * Generic JSON-Schema-subset validation for dataBinding paramShapes
 * (POST /api/plugins/:id/invoke). Supports type, properties, required,
 * additionalProperties, enum, min/maxLength, minimum/maximum. Never echoes
 * values into error messages.
 */
export function validateJsonSchema(schema: unknown, value: unknown): string[] {
  const errors: string[] = [];
  const check = (node: unknown, val: unknown, path: string): void => {
    if (!isRecord(node)) return;
    const type = (node as Record<string, unknown>).type;
    if (typeof type === "string") {
      const ok =
        (type === "string" && typeof val === "string") ||
        (type === "number" && typeof val === "number") ||
        (type === "integer" && typeof val === "number" && Number.isInteger(val)) ||
        (type === "boolean" && typeof val === "boolean") ||
        (type === "array" && Array.isArray(val)) ||
        (type === "object" && isRecord(val)) ||
        (type === "null" && val === null);
      if (!ok) {
        errors.push(`${path || "params"}: expected ${type}`);
        return;
      }
    }
    const rec = node as Record<string, unknown>;
    if (Array.isArray(rec.enum) && !rec.enum.some((option) => option === val))
      errors.push(`${path || "params"}: not one of the allowed values`);
    if (typeof val === "string") {
      if (typeof rec.minLength === "number" && val.length < rec.minLength)
        errors.push(`${path}: shorter than minLength ${rec.minLength}`);
      if (typeof rec.maxLength === "number" && val.length > rec.maxLength)
        errors.push(`${path}: longer than maxLength ${rec.maxLength}`);
    }
    if (typeof val === "number") {
      if (typeof rec.minimum === "number" && val < rec.minimum)
        errors.push(`${path}: below minimum ${rec.minimum}`);
      if (typeof rec.maximum === "number" && val > rec.maximum)
        errors.push(`${path}: above maximum ${rec.maximum}`);
    }
    if (isRecord(val) && isRecord(rec.properties)) {
      for (const key of Object.keys(val)) {
        if (!Object.hasOwn(rec.properties, key)) {
          if (rec.additionalProperties === false)
            errors.push(`${path ? `${path}.` : ""}${key}: unknown param`);
          continue;
        }
        check(
          rec.properties[key],
          (val as Record<string, unknown>)[key],
          path ? `${path}.${key}` : key,
        );
      }
      if (Array.isArray(rec.required))
        for (const key of rec.required)
          if ((val as Record<string, unknown>)[key as string] === undefined)
            errors.push(`${path ? `${path}.` : ""}${key}: required`);
    }
  };
  check(schema, value, "");
  return errors;
}

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a parsed manifest: structural rules plus the cross-field rules
 * JSON Schema cannot express (tools↔toolMetadata, configGroups↔configSchema,
 * writeOnly↔password widget, risky tool approval lint, path traversal).
 * Pure deterministic logic — no model calls, no I/O.
 */
export function validateManifest(raw: unknown): ManifestValidation {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["manifest: expected an object"] };
  const m = raw as Record<string, unknown>;
  const required = [
    "id",
    "name",
    "description",
    "version",
    "categories",
    "enabledByDefault",
    "activation",
    "contracts",
    "toolMetadata",
    "configGroups",
    "configSchema",
    "writeOnly",
    "skills",
    "cliCommands",
    "dashboard",
    "doctorContract",
    "catalog",
  ];
  for (const key of required)
    if (!(key in m)) errors.push(`manifest: missing required key "${key}"`);
  for (const key of Object.keys(m))
    if (!required.includes(key)) errors.push(`manifest: unknown root key "${key}"`);
  if (typeof m.id !== "string" || !ID_PATTERN.test(m.id))
    errors.push('manifest.id: must match ^[a-z][a-z0-9-]{1,63}$ (e.g. "email")');
  if (typeof m.name !== "string" || !m.name.trim()) errors.push("manifest.name: required");
  if (typeof m.description !== "string" || !m.description.trim())
    errors.push("manifest.description: required");
  if (typeof m.version !== "string" || !VERSION_PATTERN.test(m.version))
    errors.push('manifest.version: must be semver, e.g. "1.0.0"');
  if (!Array.isArray(m.categories) || m.categories.length === 0)
    errors.push("manifest.categories: at least one category is required");
  if (typeof m.enabledByDefault !== "boolean")
    errors.push("manifest.enabledByDefault: must be boolean");
  if (m.activation !== "eager" && m.activation !== "lazy")
    errors.push('manifest.activation: must be "eager" or "lazy"');

  // contracts
  const contracts = isRecord(m.contracts) ? m.contracts : undefined;
  const tools: string[] = [];
  if (!contracts) errors.push("manifest.contracts: must be an object");
  else {
    if (
      !Array.isArray(contracts.tools) ||
      contracts.tools.some((t) => typeof t !== "string" || !TOOL_PATTERN.test(t))
    )
      errors.push("manifest.contracts.tools: array of tool names ([a-z][a-z0-9_]*)");
    else tools.push(...(contracts.tools as string[]));
    const routes = isRecord(contracts.routes) ? contracts.routes : undefined;
    if (!routes || typeof routes.mountPath !== "string" || !routes.mountPath.startsWith("/api/"))
      errors.push('manifest.contracts.routes.mountPath: must start with "/api/"');
    for (const key of ["channels", "webSearchProviders"] as const)
      if (!Array.isArray(contracts[key]))
        errors.push(`manifest.contracts.${key}: must be an array`);
  }

  // toolMetadata: every declared tool needs an entry; risky names need approval.
  const metadata = isRecord(m.toolMetadata) ? (m.toolMetadata as Record<string, unknown>) : {};
  if (!isRecord(m.toolMetadata)) errors.push("manifest.toolMetadata: must be an object");
  for (const name of tools) {
    const entry = isRecord(metadata[name])
      ? (metadata[name] as Record<string, unknown>)
      : undefined;
    if (!entry) {
      errors.push(`manifest.toolMetadata: missing entry for tool "${name}"`);
      continue;
    }
    if (typeof entry.requiresApproval !== "boolean")
      errors.push(`manifest.toolMetadata.${name}.requiresApproval: must be boolean`);
    if (!["chat", "worker", "both"].includes(entry.kind as string))
      errors.push(`manifest.toolMetadata.${name}.kind: must be "chat", "worker" or "both"`);
    if (!["direct", "workspace-fallback"].includes(entry.providedBy as string))
      errors.push(
        `manifest.toolMetadata.${name}.providedBy: must be "direct" or "workspace-fallback"`,
      );
    if (RISKY_TOOL_NAME.test(name) && entry.requiresApproval !== true)
      errors.push(
        `manifest.toolMetadata.${name}: tools named *send*/*fill*/*login*/*delete* must declare requiresApproval: true`,
      );
  }
  for (const name of Object.keys(metadata))
    if (!tools.includes(name))
      errors.push(`manifest.toolMetadata.${name}: no matching entry in contracts.tools`);

  // configGroups ↔ configSchema
  const configGroups = Array.isArray(m.configGroups) ? (m.configGroups as unknown[]) : undefined;
  const configSchema = isRecord(m.configSchema) ? (m.configSchema as Record<string, unknown>) : {};
  if (!configGroups || configGroups.some((g) => typeof g !== "string"))
    errors.push("manifest.configGroups: must be an array of strings");
  if (configSchema.type !== "object" || !isRecord(configSchema.properties))
    errors.push('manifest.configSchema: must be { type: "object", properties: {...} }');
  else {
    const properties = configSchema.properties as Record<string, unknown>;
    for (const key of Object.keys(properties))
      if (!PROP_PATTERN.test(key))
        errors.push(`manifest.configSchema.properties: bad key "${key}"`);
    const usedGroups = new Set<string>();
    for (const [key, prop] of Object.entries(properties)) {
      if (!isRecord(prop)) {
        errors.push(`manifest.configSchema.properties.${key}: must be an object`);
        continue;
      }
      if (typeof prop.group === "string") {
        usedGroups.add(prop.group);
        if (configGroups && !configGroups.includes(prop.group))
          errors.push(
            `manifest.configSchema.properties.${key}.group: "${prop.group}" is not in configGroups`,
          );
      }
    }
    for (const group of configGroups ?? [])
      if (typeof group === "string" && !usedGroups.has(group))
        errors.push(
          `manifest.configGroups: "${group}" is not referenced by any configSchema property`,
        );
  }

  // writeOnly: must be schema properties with the password widget.
  const writeOnly = Array.isArray(m.writeOnly) ? (m.writeOnly as unknown[]) : undefined;
  if (!writeOnly || writeOnly.some((w) => typeof w !== "string"))
    errors.push("manifest.writeOnly: must be an array of strings");
  else {
    const properties = (isRecord(configSchema.properties) ? configSchema.properties : {}) as Record<
      string,
      unknown
    >;
    for (const key of writeOnly as string[]) {
      const prop = isRecord(properties[key])
        ? (properties[key] as Record<string, unknown>)
        : undefined;
      if (!prop) errors.push(`manifest.writeOnly: "${key}" is not a configSchema property`);
      else if (prop.widget !== "password")
        errors.push(`manifest.writeOnly: "${key}" must use widget "password"`);
    }
  }

  // skills / cliCommands: stub for AgentSkills; reject traversal.
  for (const key of ["skills", "cliCommands"] as const) {
    const entries = m[key];
    if (!Array.isArray(entries) || entries.some((e) => typeof e !== "string"))
      errors.push(`manifest.${key}: must be an array of strings`);
    else
      for (const bad of hasPathTraversal(entries as string[]))
        errors.push(`manifest.${key}: path traversal is rejected ("${bad}")`);
  }

  // dashboard
  const dashboard = isRecord(m.dashboard) ? m.dashboard : undefined;
  if (!dashboard) errors.push("manifest.dashboard: must be an object");
  else {
    const bindings = (dashboard as Record<string, unknown>).dataBindings;
    if (!Array.isArray(bindings)) errors.push("manifest.dashboard.dataBindings: must be an array");
    else {
      const names = new Set<string>();
      for (const binding of bindings) {
        if (
          !isRecord(binding) ||
          typeof binding.name !== "string" ||
          !TOOL_PATTERN.test(binding.name)
        )
          errors.push("manifest.dashboard.dataBindings: each needs a valid name");
        else if (names.has(binding.name))
          errors.push(`manifest.dashboard.dataBindings: duplicate name "${binding.name}"`);
        else names.add(binding.name);
        if (!isRecord(binding) || !isRecord(binding.paramShape))
          errors.push("manifest.dashboard.dataBindings: each needs a paramShape object");
      }
    }
    if (!Array.isArray((dashboard as Record<string, unknown>).actionVerbs))
      errors.push("manifest.dashboard.actionVerbs: must be an array");
  }

  // doctorContract
  const doctor = isRecord(m.doctorContract) ? m.doctorContract : undefined;
  if (!doctor) errors.push("manifest.doctorContract: must be an object");
  else {
    const migrations = (doctor as Record<string, unknown>).stateMigrations;
    if (!Array.isArray(migrations))
      errors.push("manifest.doctorContract.stateMigrations: must be an array");
    else {
      const ids = new Set<string>();
      for (const migration of migrations) {
        if (
          !isRecord(migration) ||
          typeof migration.id !== "string" ||
          !ID_PATTERN.test(migration.id)
        )
          errors.push("manifest.doctorContract.stateMigrations: each needs a valid id");
        else if (ids.has(migration.id))
          errors.push(`manifest.doctorContract.stateMigrations: duplicate id "${migration.id}"`);
        else ids.add(migration.id);
      }
    }
    const repair = (doctor as Record<string, unknown>).configRepair;
    if (!isRecord(repair) || typeof repair.dropUnknownKeys !== "boolean")
      errors.push("manifest.doctorContract.configRepair.dropUnknownKeys: must be boolean");
  }

  const catalog = isRecord(m.catalog) ? m.catalog : undefined;
  if (
    !catalog ||
    typeof catalog.title !== "string" ||
    typeof catalog.blurb !== "string" ||
    !Array.isArray(catalog.tags)
  )
    errors.push("manifest.catalog: needs { title, blurb, tags[] }");

  return { ok: errors.length === 0, errors };
}
