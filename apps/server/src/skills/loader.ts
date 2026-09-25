/**
 * Skill discovery + loading. Scans two roots:
 *
 *   1. the workspace skills dir (~/workspace/skills, or SKILLS_ROOT) —
 *      the user's own skills, greenfield;
 *   2. each loaded plugin manifest's `skills` field (the item-3 wiring
 *      point) — skill-folder paths relative to the plugin folder.
 *
 * Fail-open: invalid packs are skipped and reported as problems; loading
 * never throws because of a bad skill. CI runs the same contract
 * fail-closed via `pnpm skills:lint`.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { PluginRegistry } from "../plugins/registry.ts";
import type { Skill, SkillLoadResult, SkillProblem } from "./types.ts";
import { validateSkill } from "./validate.ts";

/** Skills root: SKILLS_ROOT or ~/workspace/skills. */
export function defaultSkillsRoot(): string {
  const env = process.env.SKILLS_ROOT?.trim();
  if (env) return resolve(env);
  return join(homedir(), "workspace", "skills");
}

/** Allow-list from config/env: when non-empty, only these skill names load. */
export function defaultSkillsAllow(): string[] {
  return (process.env.SKILLS_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface LoadSkillsInput {
  workspaceDir?: string;
  plugins?: PluginRegistry;
  /** Owner for per-plugin enablement checks; without it all loaded plugins count. */
  owner?: string;
  allowList?: string[];
}

interface CandidateDir {
  dir: string;
  source: string;
}

function childDirs(root: string): string[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(".") || entry === "_tools") continue;
    const full = join(root, entry);
    try {
      if (statSync(full).isDirectory()) out.push(full);
    } catch {}
  }
  return out.sort();
}

/** Plugin-declared skill folders, resolved against the plugin dir. */
async function pluginSkillDirs(
  plugins: PluginRegistry,
  owner: string | undefined,
): Promise<CandidateDir[]> {
  const out: CandidateDir[] = [];
  for (const plugin of plugins.loadedPlugins()) {
    if (plugin.status !== "active") continue; // errored plugins contribute nothing
    const entries = plugin.manifest.skills ?? [];
    if (entries.length === 0) continue;
    if (owner && !(await plugins.isEnabled(owner, plugin.manifest.id))) continue;
    for (const entry of entries) {
      const resolved = resolve(plugin.dir, entry);
      // Belt and braces: the manifest schema already rejects ".." segments.
      if (resolved !== plugin.dir && !resolved.startsWith(`${plugin.dir}/`)) continue;
      out.push({ dir: resolved, source: `plugin:${plugin.manifest.id}` });
    }
  }
  return out;
}

/**
 * Load every valid skill. Invalid packs are skipped with a problem entry —
 * the caller decides whether to log (startup) or ignore (already logged).
 */
export async function loadSkills(input: LoadSkillsInput = {}): Promise<SkillLoadResult> {
  const workspaceDir = input.workspaceDir ?? defaultSkillsRoot();
  const allowList = input.allowList ?? defaultSkillsAllow();
  const allowed = allowList.length > 0 ? new Set(allowList) : undefined;

  const candidates: CandidateDir[] = childDirs(workspaceDir).map((dir) => ({
    dir,
    source: "workspace",
  }));
  if (input.plugins) candidates.push(...(await pluginSkillDirs(input.plugins, input.owner)));

  const skills: Skill[] = [];
  const problems: SkillProblem[] = [];
  const seen = new Set<string>();
  for (const { dir, source } of candidates) {
    const { skill, problems: ps } = validateSkill(dir, source);
    problems.push(...ps);
    if (!skill) continue; // invalid: skipped, fail-open
    if (allowed && !allowed.has(skill.name)) continue; // deny-by-default allow-list
    if (seen.has(skill.name)) {
      problems.push({
        skill: skill.name,
        dir: skill.dir,
        level: "warning",
        code: "duplicate-name",
        message: `skill ${JSON.stringify(skill.name)} from ${source} is shadowed by an earlier pack`,
      });
      continue;
    }
    seen.add(skill.name);
    skills.push(skill);
  }
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { skills, problems };
}

const loggedDirs = new Set<string>();

/**
 * Structured startup log for skipped/invalid packs. Each dir logs once per
 * process so per-run reloads stay quiet. Fail-open: the server starts anyway.
 */
export function logSkillProblems(problems: SkillProblem[]): void {
  for (const problem of problems) {
    if (problem.level !== "error") continue;
    const key = `${problem.dir}:${problem.code}`;
    if (loggedDirs.has(key)) continue;
    loggedDirs.add(key);
    console.error({
      timestamp: new Date().toISOString(),
      context: { phase: "skills", skill: problem.skill, dir: relative(process.cwd(), problem.dir) },
      error: `invalid skill pack skipped: ${problem.code}: ${problem.message}`,
    });
  }
}
