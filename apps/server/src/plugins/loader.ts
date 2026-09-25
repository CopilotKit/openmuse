/**
 * Plugin loader: validate → resolve config → import plugin.ts → activate →
 * mount routes → register tools. Any failure is recorded as a PluginProblem
 * and the plugin is skipped — startup never crashes because of a plugin.
 *
 * Approval lint (security): any tool whose name contains send/fill/login/
 * delete MUST declare toolMetadata.<tool>.requiresApproval: true, otherwise
 * the manifest is refused. The engine's policy chain already gates these
 * tools; the lint keeps a manifest from quietly widening that surface.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import { validateManifest } from "./config-schema.ts";
import { discoverPlugins } from "./discovery.ts";
import type {
  DataBindingHandler,
  PluginActivation,
  PluginBindings,
  PluginContext,
  PluginModule,
  ToolRegistration,
  WorkerToolHost,
} from "./plugin-api.ts";
import { type LoadedPlugin, PluginRegistry, resolvePluginConfig } from "./registry.ts";
import type { DiscoveredPlugin, PluginManifest, PluginProblem } from "./types.ts";

const RISKY_TOOL_NAME = /send|fill|login|delete/i;

export interface LoadOptions {
  db: Store;
  config: Config;
  bindings: PluginBindings;
  discovered: DiscoveredPlugin[];
  discoveryErrors: PluginProblem[];
}

function pluginEntryFile(dir: string): string | undefined {
  for (const name of ["plugin.ts", "plugin.js"]) {
    const file = join(dir, name);
    if (existsSync(file)) return file;
  }
  return undefined;
}

/** Build the host context handed to a plugin's activate(). */
function makeContext(
  db: Store,
  config: Config,
  bindings: PluginBindings,
  manifest: PluginManifest,
  sink: {
    tools: Record<string, ToolRegistration>;
    dataBindings: Record<string, DataBindingHandler>;
    hooks: Map<string, (...args: unknown[]) => unknown>;
  },
): PluginContext {
  return {
    pluginId: manifest.id,
    db,
    config,
    bindings,
    registerTools(tools: Record<string, ToolRegistration>): void {
      for (const [name, registration] of Object.entries(tools)) {
        if (sink.tools[name])
          throw new Error(`plugin "${manifest.id}" registered tool "${name}" twice`);
        sink.tools[name] = registration;
      }
    },
    registerDataBinding(name: string, handler: DataBindingHandler): void {
      if (sink.dataBindings[name])
        throw new Error(`plugin "${manifest.id}" registered data binding "${name}" twice`);
      sink.dataBindings[name] = handler;
    },
    onHook(name: string, handler: (...args: unknown[]) => unknown): void {
      sink.hooks.set(name, handler);
    },
    getConfig: (owner: string) => resolvePluginConfig(db, config, manifest, owner),
  };
}

/** tools↔exports match plus kind/registration consistency. */
function checkToolRegistrations(
  manifest: PluginManifest,
  tools: Record<string, ToolRegistration>,
): string[] {
  const errors: string[] = [];
  for (const name of manifest.contracts.tools) {
    const meta = manifest.toolMetadata[name];
    if (meta.providedBy === "workspace-fallback") continue; // Served by an engine path.
    const registration = tools[name];
    if (!registration) {
      errors.push(`tool "${name}" is declared in contracts.tools but not registered by plugin.ts`);
      continue;
    }
    if ((meta.kind === "chat" || meta.kind === "both") && !registration.chat)
      errors.push(`tool "${name}" is kind "${meta.kind}" but registered no chat factory`);
    if ((meta.kind === "worker" || meta.kind === "both") && !registration.worker)
      errors.push(`tool "${name}" is kind "${meta.kind}" but registered no worker factory`);
  }
  for (const name of Object.keys(tools))
    if (!manifest.contracts.tools.includes(name))
      errors.push(`registered tool "${name}" is not declared in contracts.tools`);
  return errors;
}

function checkDataBindings(
  manifest: PluginManifest,
  dataBindings: Record<string, DataBindingHandler>,
): string[] {
  const errors: string[] = [];
  for (const declared of manifest.dashboard.dataBindings)
    if (!dataBindings[declared.name])
      errors.push(`data binding "${declared.name}" is declared but not registered by plugin.ts`);
  for (const name of Object.keys(dataBindings))
    if (!manifest.dashboard.dataBindings.some((declared) => declared.name === name))
      errors.push(`registered data binding "${name}" is not declared in dashboard.dataBindings`);
  return errors;
}

async function activateDiscovered(
  registry: PluginRegistry,
  db: Store,
  config: Config,
  bindings: PluginBindings,
  discovered: DiscoveredPlugin,
): Promise<void> {
  const { dir, manifest } = discovered;
  const _id = manifest.id;
  // Re-validate at load time (defense in depth; discovery already checked).
  const validation = validateManifest(manifest);
  if (!validation.ok) throw new Error(`invalid manifest: ${validation.errors.join("; ")}`);
  // Approval lint: risky tool names must declare requiresApproval.
  for (const name of manifest.contracts.tools)
    if (RISKY_TOOL_NAME.test(name) && manifest.toolMetadata[name]?.requiresApproval !== true)
      throw new Error(
        `approval lint: tool "${name}" must declare toolMetadata.${name}.requiresApproval: true`,
      );
  const entry = pluginEntryFile(dir);
  if (!entry) throw new Error(`missing plugin.ts in ${dir}`);
  let module: PluginModule;
  try {
    module = (await import(pathToFileURL(entry).href)) as PluginModule;
  } catch (error) {
    throw new Error(
      `could not import ${entry}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!module || typeof module.activate !== "function")
    throw new Error(`plugin.ts must export an async activate(ctx) function`);
  const sink = {
    tools: {} as Record<string, ToolRegistration>,
    dataBindings: {} as Record<string, DataBindingHandler>,
    hooks: new Map<string, (...args: unknown[]) => unknown>(),
  };
  // Register the placeholder BEFORE import/activation so any failure below
  // (import error, activate() throw, registration mismatch) leaves a
  // status:"error" entry that GET /api/plugins can show. markError() flips it.
  const plugin: LoadedPlugin = {
    manifest,
    dir,
    status: "active",
    activation: undefined,
    tools: sink.tools,
    dataBindings: sink.dataBindings,
    hooks: sink.hooks,
  };
  registry.addLoaded(plugin);
  const ctx = makeContext(db, config, bindings, manifest, sink);
  let activation: PluginActivation;
  try {
    activation = await module.activate(ctx);
  } catch (error) {
    throw new Error(`activate() failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!activation || typeof activation !== "object")
    throw new Error(`activate() must return a PluginActivation object`);
  const problems = [
    ...checkToolRegistrations(manifest, sink.tools),
    ...checkDataBindings(manifest, sink.dataBindings),
  ];
  if (problems.length > 0) throw new Error(problems.join("; "));
  plugin.activation = activation;
}

export async function loadPlugins(options: LoadOptions): Promise<PluginRegistry> {
  const { db, config, bindings, discovered, discoveryErrors } = options;
  const registry = new PluginRegistry(db, config);
  for (const problem of discoveryErrors) registry.reportError(problem);
  for (const item of discovered) {
    if (item.manifest.activation === "lazy") {
      // Deferred until first use; ensureActive() runs this exactly once.
      registry.registerLazy(item.manifest.id, () =>
        activateDiscovered(registry, db, config, bindings, item).catch((error: unknown) => {
          registry.markError(
            item.manifest.id,
            error instanceof Error ? error.message : String(error),
            item.dir,
          );
        }),
      );
      continue;
    }
    try {
      await activateDiscovered(registry, db, config, bindings, item);
    } catch (error) {
      registry.markError(
        item.manifest.id,
        error instanceof Error ? error.message : String(error),
        item.dir,
      );
    }
  }
  // Doctor pass per plugin; a failure blocks only that plugin.
  for (const id of registry.loadedIds()) {
    try {
      await registry.runDoctor(id);
    } catch (error) {
      registry.markError(
        id,
        `doctor failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return registry;
}

/**
 * Discover + load in one step. Roots: the server connectors subtree plus any
 * operator-configured config.pluginRoots.
 */
export async function loadPluginSystem(
  db: Store,
  config: Config,
  bindings: PluginBindings,
): Promise<PluginRegistry> {
  const roots = ["apps/server/src/connectors", ...(config.pluginRoots ?? [])];
  const { plugins, errors } = await discoverPlugins(roots);
  return loadPlugins({ db, config, bindings, discovered: plugins, discoveryErrors: errors });
}

export type { WorkerToolHost };
