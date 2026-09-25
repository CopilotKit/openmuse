/**
 * PluginRegistry: the runtime home for loaded plugins. Owns enablement,
 * per-owner config (writeOnly values encrypted with the AES-256-GCM vault),
 * tool factories, data bindings, and the doctor pass.
 *
 * Invalid manifests never crash startup: discovery/load problems are recorded
 * and surfaced at GET /api/plugins/errors.
 */

import type { Hono } from "hono";
import { decryptSecret, encryptSecret } from "../../../../packages/integrations/src/vault.ts";
import type { Config } from "../config.ts";
import type { PluginState, Store } from "../db.ts";
import { AppError } from "../errors.ts";
import {
  applyConfigDefaults,
  isWriteOnly,
  redactConfigForResponse,
  validateJsonSchema,
  validatePluginConfig,
} from "./config-schema.ts";
import type {
  DataBindingHandler,
  PluginActivation,
  PluginBindings,
  PluginDoctorContext,
  ToolRegistration,
  WorkerToolHost,
} from "./plugin-api.ts";
import type {
  DiscoveredPlugin,
  PluginManifest,
  PluginProblem,
  PluginStatus,
  PluginSummary,
} from "./types.ts";

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  status: PluginStatus;
  activation?: PluginActivation;
  tools: Record<string, ToolRegistration>;
  dataBindings: Record<string, DataBindingHandler>;
  hooks: Map<string, (...args: unknown[]) => unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const GLOBAL_OWNER = "";
const nowIso = () => new Date().toISOString();

/**
 * Resolve a plugin's full config for an owner: stored values over schema
 * defaults, writeOnly values decrypted. Throws a safe AppError (no secret
 * material) when a stored secret cannot be decrypted.
 */
export async function resolvePluginConfig(
  db: Store,
  config: Config,
  manifest: PluginManifest,
  owner: string,
): Promise<Record<string, unknown>> {
  const state = await db.getPluginState(owner, manifest.id);
  const stored = state?.config ?? {};
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (isWriteOnly(manifest, key) && typeof value === "string" && value !== "") {
      if (!config.encryptionKey)
        throw new AppError(
          `Plugin "${manifest.id}" has an encrypted setting but no encryption key is configured`,
          503,
        );
      try {
        resolved[key] = decryptSecret(value, config.encryptionKey);
      } catch {
        throw new AppError(
          `Stored secret for plugin "${manifest.id}" could not be decrypted; re-enter it in the plugin settings`,
          500,
        );
      }
    } else {
      resolved[key] = value;
    }
  }
  return applyConfigDefaults(manifest, resolved);
}

/**
 * Enforce the metadata-only contract on dataBinding results: the value must
 * be JSON-serializable and is capped at 256 KB serialized. Anything else
 * (class instances, BigInts, unbounded dumps) is a 502, not a truncated
 * guess — bindings are for small metadata, not bulk data transfer.
 */
function sanitizeBindingResult(result: unknown): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(result) ?? "null";
  } catch {
    throw new AppError("Data binding returned a non-serializable value", 502);
  }
  if (serialized.length > 256 * 1024)
    throw new AppError("Data binding result exceeds the 256 KB metadata limit", 502);
  return JSON.parse(serialized) as unknown;
}

export class PluginRegistry {
  private readonly loaded = new Map<string, LoadedPlugin>();
  private readonly pendingLazy = new Map<string, () => Promise<void>>();
  private readonly problems: PluginProblem[] = [];

  constructor(
    private readonly db: Store,
    private readonly config: Config,
  ) {}

  reportError(problem: PluginProblem): void {
    this.problems.push(problem);
  }

  errors(): PluginProblem[] {
    return [...this.problems];
  }

  /** Called by the loader after a plugin activates (or for lazy placeholders). */
  addLoaded(plugin: LoadedPlugin): void {
    this.loaded.set(plugin.manifest.id, plugin);
  }

  registerLazy(id: string, load: () => Promise<void>): void {
    this.pendingLazy.set(id, load);
  }

  private async ensureActive(id: string): Promise<LoadedPlugin | undefined> {
    const pending = this.pendingLazy.get(id);
    if (pending) {
      this.pendingLazy.delete(id);
      try {
        await pending();
      } catch (error) {
        this.reportError({
          pluginId: id,
          dir: "",
          message: `lazy activation failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return this.loaded.get(id);
  }

  loadedIds(): string[] {
    return [...this.loaded.keys(), ...this.pendingLazy.keys()];
  }

  getLoaded(id: string): LoadedPlugin | undefined {
    return this.loaded.get(id);
  }

  /**
   * Every loaded plugin, including ones that failed activation
   * (status "error"). Used by the AgentSkills loader to scan each
   * manifest's `skills` field — the loader skips errored plugins.
   */
  loadedPlugins(): LoadedPlugin[] {
    return [...this.loaded.values()];
  }

  private requireLoaded(id: string): LoadedPlugin {
    const plugin = this.loaded.get(id);
    if (!plugin) throw new AppError(`Unknown plugin "${id}"`, 404);
    return plugin;
  }

  private requireHealthy(plugin: LoadedPlugin): void {
    if (plugin.status === "error")
      throw new AppError(
        `Plugin "${plugin.manifest.id}" is unavailable (see /api/plugins/errors)`,
        503,
      );
  }

  markError(id: string, message: string, dir = ""): void {
    const plugin = this.loaded.get(id);
    if (plugin) plugin.status = "error";
    this.reportError({ pluginId: id, dir, message });
  }

  /** The plugin's service instance for app.ts wiring (undefined when unavailable). */
  service<T>(id: string): T | undefined {
    const plugin = this.loaded.get(id);
    if (!plugin || plugin.status === "error") return undefined;
    return plugin.activation?.service as T | undefined;
  }

  async isEnabled(owner: string, id: string): Promise<boolean> {
    const plugin = await this.ensureActive(id);
    if (!plugin || plugin.status === "error") return false;
    const state = await this.db.getPluginState(owner, id);
    return state?.enabled ?? plugin.manifest.enabledByDefault;
  }

  async setEnabled(owner: string, id: string, enabled: boolean): Promise<void> {
    const plugin = this.requireLoaded(id);
    const state = (await this.db.getPluginState(owner, id)) ?? { id, updatedAt: nowIso() };
    state.enabled = enabled;
    state.updatedAt = nowIso();
    await this.db.putPluginState(owner, id, state);
    void plugin;
  }

  async summaries(owner: string): Promise<PluginSummary[]> {
    const out: PluginSummary[] = [];
    for (const id of this.loadedIds()) {
      const plugin = await this.ensureActive(id);
      if (!plugin) continue;
      const manifest = plugin.manifest;
      out.push({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        categories: manifest.categories,
        enabled: plugin.status === "error" ? false : await this.isEnabled(owner, id),
        status: plugin.status,
        mountPath: manifest.contracts.routes.mountPath,
        tools: manifest.contracts.tools,
        writeOnly: manifest.writeOnly,
        configGroups: manifest.configGroups,
        hasConfig: Object.keys(manifest.configSchema.properties ?? {}).length > 0,
      });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  /** Public config view: writeOnly values are always "" — never the secret. */
  async publicConfig(owner: string, id: string): Promise<Record<string, unknown>> {
    const plugin = this.requireLoaded(id);
    const manifest = plugin.manifest;
    const resolved = await resolvePluginConfig(this.db, this.config, manifest, owner);
    return {
      id: manifest.id,
      enabled: await this.isEnabled(owner, id),
      config: redactConfigForResponse(manifest, resolved),
      configSchema: manifest.configSchema,
      configGroups: manifest.configGroups,
      writeOnly: manifest.writeOnly,
    };
  }

  private encryptWriteOnly(manifest: PluginManifest, value: unknown): string {
    if (!this.config.encryptionKey)
      throw new AppError(
        `Plugin "${manifest.id}" needs an encrypted setting but no encryption key is configured`,
        503,
      );
    return encryptSecret(String(value), this.config.encryptionKey);
  }

  /**
   * PATCH /api/plugins/:id/config. Unknown keys are rejected (422); writeOnly
   * values are encrypted before storage; an empty writeOnly value means
   * "leave the stored secret unchanged" (the GET view always shows "").
   */
  async updateConfig(owner: string, id: string, patch: unknown): Promise<Record<string, unknown>> {
    const plugin = this.requireLoaded(id);
    this.requireHealthy(plugin);
    const manifest = plugin.manifest;
    if (!isRecord(patch)) throw new AppError("Config patch must be an object", 422);
    const state = (await this.db.getPluginState(owner, id)) ?? { id, updatedAt: nowIso() };
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== "boolean")
        throw new AppError(`Plugin "${id}": "enabled" must be boolean`, 422);
      state.enabled = patch.enabled;
    }
    if (patch.config !== undefined) {
      if (!isRecord(patch.config))
        throw new AppError(`Plugin "${id}": "config" must be an object`, 422);
      const properties = manifest.configSchema.properties ?? {};
      for (const key of Object.keys(patch.config))
        if (!Object.hasOwn(properties, key))
          throw new AppError(`Plugin "${id}": unknown config key "${key}"`, 422);
      // Validate the merged logical config; error messages never echo values.
      const current = await resolvePluginConfig(this.db, this.config, manifest, owner);
      const next: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(patch.config)) {
        if (isWriteOnly(manifest, key) && value === "") continue; // unchanged
        next[key] = value;
      }
      const errors = validatePluginConfig(manifest, next, { forbidUnknown: true });
      if (errors.length > 0) throw new AppError(errors.join("; "), 422);
      // Persist: writeOnly values are re-encrypted only when the patch actually
      // changed them; otherwise keep the stored envelope byte-for-byte so an
      // untouched secret never churns (fresh nonces) on unrelated edits.
      const existing = state.config ?? {};
      const patchConfig = patch.config as Record<string, unknown>;
      const stored: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(next)) {
        if (value === undefined) continue;
        if (isWriteOnly(manifest, key) && typeof value === "string") {
          const changed = Object.hasOwn(patchConfig, key) && patchConfig[key] !== "";
          if (changed) {
            stored[key] = value === "" ? value : this.encryptWriteOnly(manifest, value);
          } else if (typeof existing[key] === "string" && existing[key] !== "") {
            stored[key] = existing[key];
          } else {
            stored[key] = value === "" ? value : this.encryptWriteOnly(manifest, value);
          }
          continue;
        }
        stored[key] = value;
      }
      state.config = stored;
    }
    state.updatedAt = nowIso();
    await this.db.putPluginState(owner, id, state);
    return this.publicConfig(owner, id);
  }

  /** Chat-agent tools for an owner: enabled, healthy plugins only. */
  async chatTools(owner: string): Promise<import("@copilotkit/runtime/v2").ToolDefinition[]> {
    const out: import("@copilotkit/runtime/v2").ToolDefinition[] = [];
    for (const id of this.loadedIds()) {
      const plugin = await this.ensureActive(id);
      if (!plugin || plugin.status === "error") continue;
      if (!(await this.isEnabled(owner, id))) continue;
      for (const name of plugin.manifest.contracts.tools) {
        const meta = plugin.manifest.toolMetadata[name];
        if (!meta || (meta.kind !== "chat" && meta.kind !== "both")) continue;
        if (meta.providedBy !== "direct") continue;
        const factory = plugin.tools[name]?.chat;
        if (!factory) continue;
        try {
          out.push(...factory(owner));
        } catch (error) {
          console.error(
            `[openmuse] plugin "${id}" chat tool "${name}" factory failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    return out;
  }

  /** Worker tools for an owner: enabled, healthy plugins only. */
  async workerTools(
    owner: string,
    host: Omit<WorkerToolHost, "owner">,
  ): Promise<import("@copilotkit/runtime/v2").ToolDefinition[]> {
    const out: import("@copilotkit/runtime/v2").ToolDefinition[] = [];
    for (const id of this.loadedIds()) {
      const plugin = await this.ensureActive(id);
      if (!plugin || plugin.status === "error") continue;
      if (!(await this.isEnabled(owner, id))) continue;
      for (const name of plugin.manifest.contracts.tools) {
        const meta = plugin.manifest.toolMetadata[name];
        if (!meta || (meta.kind !== "worker" && meta.kind !== "both")) continue;
        if (meta.providedBy !== "direct") continue;
        const factory = plugin.tools[name]?.worker;
        if (!factory) continue;
        try {
          out.push(factory({ ...host, owner }));
        } catch (error) {
          console.error(
            `[openmuse] plugin "${id}" worker tool "${name}" factory failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    return out;
  }

  /**
   * POST /api/plugins/:id/invoke — owner-scoped RPC for dashboard
   * dataBindings. Params are validated against the manifest's paramShape;
   * handlers must return metadata only, never secrets.
   */
  async invokeBinding(
    owner: string,
    id: string,
    binding: string,
    params: unknown,
  ): Promise<unknown> {
    const plugin = this.requireLoaded(id);
    this.requireHealthy(plugin);
    if (!(await this.isEnabled(owner, id))) throw new AppError(`Plugin "${id}" is disabled`, 409);
    const declared = plugin.manifest.dashboard.dataBindings.find((b) => b.name === binding);
    if (!declared) throw new AppError(`Unknown data binding "${binding}" for plugin "${id}"`, 404);
    const handler = plugin.dataBindings[binding];
    if (!handler) throw new AppError(`Data binding "${binding}" is not implemented`, 503);
    const value = params ?? {};
    const shapeErrors = validateJsonSchema(declared.paramShape, value);
    if (shapeErrors.length > 0)
      throw new AppError(`Invalid params for "${binding}": ${shapeErrors.join("; ")}`, 422);
    return sanitizeBindingResult(await handler(owner, value));
  }

  /** Hono sub-apps to mount, keyed by manifest mountPath (healthy plugins only). */
  mountedRoutes(): Array<{ path: string; routes: Hono }> {
    const out: Array<{ path: string; routes: Hono }> = [];
    for (const plugin of this.loaded.values()) {
      if (plugin.status === "error") continue;
      if (plugin.activation?.routes)
        out.push({
          path: plugin.manifest.contracts.routes.mountPath,
          routes: plugin.activation.routes,
        });
    }
    return out;
  }

  /** Named hook handlers registered by a plugin. */
  getHook(pluginId: string, name: string): ((...args: unknown[]) => unknown) | undefined {
    return this.loaded.get(pluginId)?.hooks.get(name);
  }

  /**
   * Doctor pass: state migrations run once per plugin (recorded under the
   * global plugin scope), then configRepair drops unknown stored keys with a
   * warning instead of failing startup. A migration failure blocks only that
   * plugin — it is marked errored and its tools/routes are skipped.
   */
  async runDoctor(id: string): Promise<void> {
    const plugin = await this.ensureActive(id);
    if (!plugin || plugin.status === "error") return;
    const manifest = plugin.manifest;
    const state = (await this.db.getPluginState(GLOBAL_OWNER, manifest.id)) ?? {
      id: manifest.id,
      updatedAt: nowIso(),
    };
    const done = new Set(state.doctorMigrations ?? []);
    for (const migration of manifest.doctorContract.stateMigrations) {
      if (done.has(migration.id)) continue;
      const run = plugin.activation?.migrations?.[migration.id];
      if (!run) {
        this.reportError({
          pluginId: manifest.id,
          dir: plugin.dir,
          message: `doctor: migration "${migration.id}" is declared but not implemented`,
        });
        done.add(migration.id);
        continue;
      }
      try {
        await run(this.doctorContext(plugin));
        done.add(migration.id);
      } catch (error) {
        this.markError(
          manifest.id,
          `doctor: migration "${migration.id}" failed: ${error instanceof Error ? error.message : String(error)}`,
          plugin.dir,
        );
        return; // Blocks only this plugin.
      }
    }
    state.doctorMigrations = [...done];
    state.updatedAt = nowIso();
    await this.db.putPluginState(GLOBAL_OWNER, manifest.id, state);
    // configRepair: drop unknown keys with a warning, never fail startup.
    if (manifest.doctorContract.configRepair.dropUnknownKeys) {
      const properties = manifest.configSchema.properties ?? {};
      for (const { owner, state: ownerState } of await this.db.listPluginStates(manifest.id)) {
        const stored = ownerState.config;
        if (!stored) continue;
        let dropped = 0;
        for (const key of Object.keys(stored))
          if (!Object.hasOwn(properties, key)) {
            delete stored[key];
            dropped += 1;
          }
        if (dropped > 0) {
          console.warn(
            `[openmuse] doctor: dropped ${dropped} unknown config key(s) for plugin "${manifest.id}"`,
          );
          ownerState.updatedAt = nowIso();
          await this.db.putPluginState(owner, manifest.id, ownerState);
        }
      }
    }
  }

  private doctorContext(plugin: LoadedPlugin): PluginDoctorContext {
    const manifest = plugin.manifest;
    const db = this.db;
    const pluginId = manifest.id;
    return {
      pluginId,
      config: this.config,
      // Per-plugin scope: only this plugin's own plugin_config rows. A
      // migration cannot reach other plugins, other owners' records, or any
      // other table — the full Store is never handed out here.
      state: {
        get: (owner: string) => db.getPluginState(owner, pluginId),
        put: (owner: string, state: PluginState) => db.putPluginState(owner, pluginId, state),
        listOwners: async () => (await db.listPluginStates(pluginId)).map(({ owner }) => owner),
      },
      getConfig: (owner: string) => resolvePluginConfig(db, this.config, manifest, owner),
    };
  }
}

export type { DiscoveredPlugin, PluginBindings, WorkerToolHost };
