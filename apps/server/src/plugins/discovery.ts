/**
 * Plugin discovery: scans connector folders for openmuse.plugin.json.
 * Invalid manifests are reported, never crash startup.
 *
 * Security: discovery roots are limited to server subtrees (apps/server/…)
 * plus explicit operator-configured paths. Any other root whose path contains
 * a "workspace" or "uploads" segment is rejected — plugin roots must never
 * point at user-writable data directories where a dropped manifest + plugin.ts
 * would be import()ed (arbitrary code execution).
 */
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { validateManifest } from "./config-schema.ts";
import type { DiscoveredPlugin, PluginManifest, PluginProblem } from "./types.ts";

export const MANIFEST_FILENAME = "openmuse.plugin.json";

function rootAllowed(root: string): boolean {
  const resolved = resolve(root);
  const serverSubtree = resolve("apps/server");
  if (resolved === serverSubtree || resolved.startsWith(serverSubtree + sep)) return true;
  const segments = resolved.split(sep).map((segment) => segment.toLowerCase());
  return !segments.includes("workspace") && !segments.includes("uploads");
}

export interface DiscoveryResult {
  plugins: DiscoveredPlugin[];
  errors: PluginProblem[];
}

async function discoverRoot(root: string, errors: PluginProblem[]): Promise<DiscoveredPlugin[]> {
  const found: DiscoveredPlugin[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    errors.push({ dir: root, message: `plugin root is not readable: ${root}` });
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(root, entry.name);
    const manifestPath = join(dir, MANIFEST_FILENAME);
    let raw: string;
    try {
      await stat(manifestPath);
    } catch {
      continue; // Not a plugin folder; ignore.
    }
    try {
      raw = await readFile(manifestPath, "utf8");
    } catch (error) {
      errors.push({
        dir,
        message: `could not read ${MANIFEST_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      errors.push({
        dir,
        message: `${MANIFEST_FILENAME} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const validation = validateManifest(parsed);
    if (!validation.ok) {
      const id = (parsed as { id?: unknown }).id;
      errors.push({
        dir,
        pluginId: typeof id === "string" ? id : undefined,
        message: `invalid manifest: ${validation.errors.join("; ")}`,
      });
      continue;
    }
    found.push({ dir, manifest: parsed as PluginManifest });
  }
  found.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  return found;
}

/** The default server-subtree root: apps/server/src/connectors. */
export function defaultPluginRoots(): string[] {
  return [join("apps/server/src/connectors")];
}

export async function discoverPlugins(roots: string[]): Promise<DiscoveryResult> {
  const errors: PluginProblem[] = [];
  const plugins: DiscoveredPlugin[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const resolved = resolve(root);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (!rootAllowed(root)) {
      errors.push({
        dir: root,
        message:
          "plugin root rejected: outside the server subtree it must not contain a workspace/uploads segment",
      });
      continue;
    }
    plugins.push(...(await discoverRoot(resolved, errors)));
  }
  const byId = new Map<string, DiscoveredPlugin>();
  for (const plugin of plugins) {
    const existing = byId.get(plugin.manifest.id);
    if (existing) {
      errors.push({
        dir: plugin.dir,
        pluginId: plugin.manifest.id,
        message: `duplicate plugin id "${plugin.manifest.id}" (already discovered at ${existing.dir}); ignoring this copy`,
      });
      continue;
    }
    byId.set(plugin.manifest.id, plugin);
  }
  return { plugins: [...byId.values()], errors };
}
