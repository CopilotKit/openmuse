/**
 * The Hono-native plugin host API. This is intentionally NOT openclaw's
 * Gateway API: plugins get a small, explicit context object with the store,
 * the server config, host-provided service bindings, and registration
 * functions. Nothing else.
 */

import type { ToolDefinition } from "@copilotkit/runtime/v2";
import type { Hono } from "hono";
import type { z } from "zod";
import type { Evidence } from "../../../../packages/domain/src/agent.ts";
import type { Config } from "../config.ts";
import type { PluginState, Store } from "../db.ts";

/** Host services a plugin may build on (browser, files, google, …). */
export interface PluginBindings {
  browser?: unknown;
  files?: unknown;
  google?: unknown;
  [key: string]: unknown;
}

/** One tool registration: factories for the chat agent and/or the worker. */
export interface ToolRegistration {
  /** Build the chat-agent tool definitions for an owner. */
  chat?: (owner: string) => ToolDefinition[];
  /** Build the worker tool definition; host applies the engine's policy wrapper. */
  worker?: (host: WorkerToolHost) => ToolDefinition;
}

/**
 * What a worker tool factory receives. defineTool wraps the tool exactly
 * like the engine's own worker toolset (argument parsing, the policy chain,
 * serialization); addEvidence appends to the current task's evidence.
 */
export interface WorkerToolHost {
  owner: string;
  defineTool<T extends z.ZodType>(
    name: string,
    description: string,
    parameters: T,
    execute: (args: z.output<T>) => Promise<unknown>,
  ): ToolDefinition;
  addEvidence(entry: {
    id: string;
    kind: Evidence["kind"];
    title: string;
    url: string;
    excerpt: string;
  }): Promise<void>;
}

/** Owner-scoped, metadata-only data handler for POST /api/plugins/:id/invoke. */
export type DataBindingHandler = (owner: string, params: unknown) => Promise<unknown>;

export interface PluginContext {
  /** The manifest id of the plugin being activated. */
  pluginId: string;
  db: Store;
  config: Config;
  bindings: PluginBindings;
  /**
   * Register agent tools. Every name must appear in the manifest's
   * contracts.tools with a toolMetadata entry; every manifest-declared tool
   * with providedBy "direct" must be registered here.
   */
  registerTools(tools: Record<string, ToolRegistration>): void;
  /**
   * Register a read-only, owner-scoped data binding exposed at
   * POST /api/plugins/:id/invoke. The name must be declared in the
   * manifest's dashboard.dataBindings. Handlers must return metadata only —
   * never secrets.
   */
  registerDataBinding(name: string, handler: DataBindingHandler): void;
  /** Named lifecycle hooks (e.g. "beforeToolCall" narrowers). */
  onHook(name: string, handler: (...args: unknown[]) => unknown): void;
  /**
   * The plugin's resolved, schema-validated config for an owner
   * (writeOnly values decrypted). Use for runtime behavior, never for
   * responses — the config API redacts those separately.
   */
  getConfig(owner: string): Promise<Record<string, unknown>>;
}

export interface PluginActivation {
  /**
   * The plugin's service instance (e.g. EmailService). app.ts wires it into
   * the workspace/agent where the hand-wired constructor arguments used to go.
   */
  service?: unknown;
  /** Hono sub-app mounted at the manifest's contracts.routes.mountPath. */
  routes?: Hono<any, any, any>;
  /** Doctor state migrations, keyed by the ids declared in doctorContract. */
  migrations?: Record<string, (ctx: PluginDoctorContext) => Promise<void>>;
}

/**
 * What a doctor state migration receives. Deliberately NOT the full Store:
 * migrations are scoped to the plugin's own plugin_config rows, so one
 * plugin's migration can never read or write another plugin's state, another
 * owner's unrelated records, or any other table.
 */
export interface PluginDoctorDb {
  /** This plugin's state for an owner (its own plugin_config row). */
  get(owner: string): Promise<PluginState | null>;
  /** Replace this plugin's state for an owner. */
  put(owner: string, state: PluginState): Promise<void>;
  /** Owners that have a state row for this plugin. */
  listOwners(): Promise<string[]>;
}

export interface PluginDoctorContext {
  /** The manifest id of the plugin being doctored. */
  pluginId: string;
  config: Config;
  /** Per-plugin scoped state access (see PluginDoctorDb). */
  state: PluginDoctorDb;
  /** This plugin's resolved config for an owner (writeOnly decrypted). */
  getConfig(owner: string): Promise<Record<string, unknown>>;
}

/** A plugin.ts module must export an async activate function. */
export interface PluginModule {
  activate: (ctx: PluginContext) => Promise<PluginActivation>;
}
