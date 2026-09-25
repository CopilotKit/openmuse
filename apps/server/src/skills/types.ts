/**
 * AgentSkills types. A skill is a deterministic procedure pack:
 * `name` + model-facing `description` frontmatter is the routing trigger,
 * the body is an ordered procedure ending in a `## Verification` section.
 * Contract: ~/workspace/skills/SKILLS.md
 */

export interface SkillFrontmatter {
  name: string;
  description: string;
  /** Restriction, never a grant: intersected with the registered toolset. */
  allowedTools?: string[];
  userInvocable: boolean;
  disableModelInvocation: boolean;
  metadata: Record<string, string>;
  homepage?: string;
  license?: string;
}

export interface Skill {
  name: string;
  /** Absolute path of the skill folder. */
  dir: string;
  description: string;
  allowedTools?: string[];
  userInvocable: boolean;
  disableModelInvocation: boolean;
  metadata: Record<string, string>;
  homepage?: string;
  license?: string;
  /** Where the skill came from: the workspace dir or a plugin. */
  source: string;
}

export type SkillProblemLevel = "error" | "warning";

export interface SkillProblem {
  /** Skill folder name (or dir) when the frontmatter parsed. */
  skill?: string;
  dir: string;
  level: SkillProblemLevel;
  code: string;
  message: string;
}

/** Model-facing routing index entry. Sorted by name, no embeddings. */
export interface SkillIndexEntry {
  name: string;
  description: string;
}

export interface SkillLoadResult {
  skills: Skill[];
  problems: SkillProblem[];
}
