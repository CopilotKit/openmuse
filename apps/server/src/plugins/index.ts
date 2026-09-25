/**
 * Plugin manifest system: every capability = one folder + openmuse.plugin.json.
 * See docs/plugin-manifest.md for the convention.
 */
export { applyConfigDefaults, validateManifest, validatePluginConfig } from "./config-schema.ts";
export { defaultPluginRoots, discoverPlugins, MANIFEST_FILENAME } from "./discovery.ts";
export { loadPluginSystem, loadPlugins } from "./loader.ts";
export type {
  DataBindingHandler,
  PluginActivation,
  PluginBindings,
  PluginContext,
  PluginModule,
  ToolRegistration,
  WorkerToolHost,
} from "./plugin-api.ts";
export { PluginRegistry, resolvePluginConfig } from "./registry.ts";
export { pluginSystemRoutes } from "./routes.ts";
export type {
  DiscoveredPlugin,
  PluginManifest,
  PluginProblem,
  PluginStatus,
  PluginSummary,
  ToolKind,
  ToolMetadataEntry,
  ToolProvider,
} from "./types.ts";
