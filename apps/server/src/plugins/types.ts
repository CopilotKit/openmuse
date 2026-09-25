/**
 * TypeScript mirror of openmuse.plugin.schema.json. The JSON Schema file is
 * the machine-readable contract; validateManifest() in this module enforces
 * the same rules plus the cross-field rules (tools↔toolMetadata,
 * configGroups↔configSchema, writeOnly↔password widget) that plain JSON
 * Schema cannot express.
 */

export type ToolKind = "chat" | "worker" | "both";
export type ToolProvider = "direct" | "workspace-fallback";

export interface ToolMetadataEntry {
  requiresApproval: boolean;
  kind: ToolKind;
  providedBy: ToolProvider;
  description?: string;
}

export interface ConfigPropertySchema {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  title?: string;
  description?: string;
  enum?: unknown[];
  widget?: "text" | "textarea" | "password" | "number" | "switch" | "select";
  group?: string;
  format?: "email" | "uri" | "hostname";
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
}

export interface PluginConfigSchema {
  type: "object";
  properties: Record<string, ConfigPropertySchema>;
  required?: string[];
  additionalProperties: false;
}

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  categories: string[];
  enabledByDefault: boolean;
  activation: "eager" | "lazy";
  contracts: {
    tools: string[];
    routes: { mountPath: string; paths: string[] };
    channels: string[];
    webSearchProviders: string[];
  };
  toolMetadata: Record<string, ToolMetadataEntry>;
  configGroups: string[];
  configSchema: PluginConfigSchema;
  /** OpenMuse extension: never rendered back, never logged, stored encrypted. */
  writeOnly: string[];
  /** OpenMuse extension (stub for AgentSkills): skill-folder paths. */
  skills: string[];
  cliCommands: string[];
  dashboard: {
    dataBindings: Array<{
      name: string;
      paramShape: Record<string, unknown>;
      description?: string;
    }>;
    actionVerbs: string[];
  };
  doctorContract: {
    stateMigrations: Array<{ id: string; description: string }>;
    configRepair: { dropUnknownKeys: boolean };
  };
  catalog: { title: string; blurb: string; tags: string[] };
}

export interface PluginProblem {
  /** Plugin id when the manifest parsed; otherwise the directory. */
  pluginId?: string;
  dir: string;
  message: string;
}

export interface DiscoveredPlugin {
  dir: string;
  manifest: PluginManifest;
}

export type PluginStatus = "active" | "error";

export interface PluginSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  categories: string[];
  enabled: boolean;
  status: PluginStatus;
  mountPath: string;
  tools: string[];
  writeOnly: string[];
  configGroups: string[];
  hasConfig: boolean;
}
