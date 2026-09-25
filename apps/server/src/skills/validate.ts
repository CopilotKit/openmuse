/**
 * Skill pack validation — the TypeScript twin of
 * ~/workspace/skills/_tools/validate_skill.py. Both enforce the same
 * contract (~/workspace/skills/SKILLS.md); keep the issue codes and the
 * check semantics identical when either one changes.
 *
 * Zero model calls, no dependencies: frontmatter is parsed with a minimal
 * YAML-subset reader (scalars, folded scalars, lists, one-level maps).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { Skill, SkillProblem } from "./types.ts";

export const SKILL_FILENAME = "SKILL.md";
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;
const ORDERED_STEP_RE = /^\s*\d+[.)]\s+\S/m;
const VERIFICATION_RE = /^#{1,6}\s+verification\s*$/gim;
const LINK_RE = /!?\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g;
const MD_LINK_IN_TEXT_RE = /!?\[[^\]]+\]\([^)]+\)/;

const ALLOWED_KEYS = new Set([
  "name",
  "description",
  "allowed-tools",
  "user-invocable",
  "disable-model-invocation",
  "metadata",
  "homepage",
  "license",
]);

const CURL_RE = /\bcurl\b/;
const SHELL_RE = /(?:^|[\s;|&`'"])sh(?=[\s;|&]|$)/;
const SECRET_RES = [
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[bap]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:api[_-]?key|passwd|password|secret|token)\s*[:=]\s*["'][^"']{4,}["']/i,
];
const NETWORK_RES = [
  /\burllib\b/,
  /\brequests\b/,
  /\bhttp\.client\b/,
  /\bsocket\b/,
  /\bfetch\(/,
  /XMLHttpRequest/,
];

function scalar(value: string): string | boolean {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0])
    return v.slice(1, -1);
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}

type FrontmatterValue = string | boolean | string[] | Record<string, string>;

/**
 * Parse `---` frontmatter. Returns the data map, the body, and an error
 * string when the block is missing or unterminated.
 */
export function parseFrontmatter(text: string): {
  data: Record<string, FrontmatterValue> | null;
  body: string;
  error?: string;
} {
  const lines = text.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---")
    return { data: null, body: text, error: "missing-frontmatter: SKILL.md must start with ---" };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { data: null, body: text, error: "missing-frontmatter: no closing ---" };
  const data: Record<string, FrontmatterValue> = {};
  const fm = lines.slice(1, end);
  let i = 0;
  while (i < fm.length) {
    const raw = fm[i];
    if (!raw.trim() || raw.trim().startsWith("#")) {
      i++;
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    if (indent > 0) {
      i++;
      continue;
    }
    const colon = raw.indexOf(":");
    if (colon === -1) {
      i++;
      continue;
    }
    const key = raw.slice(0, colon).trim();
    const value = raw.slice(colon + 1).trim();
    if (value === ">-" || value === ">" || value === "|") {
      const parts: string[] = [];
      i++;
      while (i < fm.length) {
        const nxt = fm[i];
        const nindent = nxt.length - nxt.trimStart().length;
        if (nindent === 0 || !nxt.trim()) break;
        parts.push(nxt.trim());
        i++;
      }
      data[key] = parts.join(" ");
      continue;
    }
    if (value === "") {
      const items: string[] = [];
      const mapping: Record<string, string> = {};
      let isMap = false;
      i++;
      while (i < fm.length) {
        const nxt = fm[i];
        const nindent = nxt.length - nxt.trimStart().length;
        const s = nxt.trim();
        if (nindent === 0 || !s) break;
        if (s.startsWith("- ")) {
          const item = scalar(s.slice(2));
          items.push(typeof item === "string" ? item : String(item));
        } else {
          const c = s.indexOf(":");
          if (c !== -1) {
            const sv = scalar(s.slice(c + 1).trim());
            mapping[s.slice(0, c).trim()] = typeof sv === "string" ? sv : String(sv);
            isMap = true;
          }
        }
        i++;
      }
      data[key] = isMap ? mapping : items;
      continue;
    }
    data[key] = scalar(value);
    i++;
  }
  return { data, body: lines.slice(end + 1).join("\n") };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full));
    else if (st.isFile()) out.push(full);
  }
  return out.sort();
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

export interface ValidatedSkill {
  skill: Skill | null;
  problems: SkillProblem[];
}

/**
 * Validate one skill folder. Returns the Skill when it is error-free,
 * otherwise null with the problems list populated (warnings included).
 * Never throws for malformed skill content.
 */
export function validateSkill(dir: string, source = "workspace"): ValidatedSkill {
  const absDir = resolve(dir);
  const folderName = basename(absDir);
  const problems: SkillProblem[] = [];
  const err = (code: string, message: string) =>
    problems.push({ skill: folderName, dir: absDir, level: "error", code, message });
  const warn = (code: string, message: string) =>
    problems.push({ skill: folderName, dir: absDir, level: "warning", code, message });

  const skillFile = join(absDir, SKILL_FILENAME);
  if (!existsSync(skillFile)) {
    err("missing-skill-md", "SKILL.md is missing");
    return { skill: null, problems };
  }
  const text = readFileSync(skillFile, "utf-8");
  const { data, body, error } = parseFrontmatter(text);
  if (!data || error) {
    err("missing-frontmatter", error ?? "frontmatter missing");
    return { skill: null, problems };
  }

  for (const key of Object.keys(data))
    if (!ALLOWED_KEYS.has(key))
      err("unknown-key", `unknown frontmatter key: ${JSON.stringify(key)}`);

  const name = data.name;
  if (!isStr(name) || !name) {
    err("bad-name", "frontmatter 'name' is required and must be a string");
  } else {
    if (!NAME_RE.test(name)) err("bad-name", `name ${JSON.stringify(name)} must match [a-z0-9-]`);
    if (name !== folderName)
      err(
        "name-mismatch",
        `name ${JSON.stringify(name)} does not match folder ${JSON.stringify(folderName)}`,
      );
  }

  let description = data.description;
  if (!isStr(description) || !description.trim()) {
    err("missing-description", "frontmatter 'description' is required");
    description = "";
  } else {
    description = description.split(/\s+/).join(" ");
    if (description.length > 500)
      err("description-too-long", `description is ${description.length} chars (max 500)`);
    if (MD_LINK_IN_TEXT_RE.test(description))
      err("description-markdown", "description must not contain markdown links/images");
  }

  const allowed = data["allowed-tools"];
  let allowedTools: string[] | undefined;
  if (allowed !== undefined) {
    if (!Array.isArray(allowed) || !allowed.every((t) => isStr(t) && TOOL_NAME_RE.test(t)))
      err("bad-allowed-tools", "'allowed-tools' must be a list of tool names");
    else allowedTools = [...allowed];
  }

  let userInvocable = true;
  if (data["user-invocable"] !== undefined) {
    if (typeof data["user-invocable"] !== "boolean")
      err("bad-frontmatter-type", "'user-invocable' must be true/false");
    else userInvocable = data["user-invocable"];
  }
  let disableModelInvocation = false;
  if (data["disable-model-invocation"] !== undefined) {
    if (typeof data["disable-model-invocation"] !== "boolean")
      err("bad-frontmatter-type", "'disable-model-invocation' must be true/false");
    else disableModelInvocation = data["disable-model-invocation"];
  }

  let metadata: Record<string, string> = {};
  if (data.metadata !== undefined) {
    const m = data.metadata;
    if (
      typeof m !== "object" ||
      m === null ||
      Array.isArray(m) ||
      !Object.entries(m).every(([k, v]) => isStr(k) && isStr(v))
    )
      err("bad-frontmatter-type", "'metadata' must be a string map");
    else metadata = { ...(m as Record<string, string>) };
  }

  let homepage: string | undefined;
  if (data.homepage !== undefined) {
    if (!isStr(data.homepage)) err("bad-frontmatter-type", "'homepage' must be a string");
    else homepage = data.homepage;
  }
  let license: string | undefined;
  if (data.license !== undefined) {
    if (!isStr(data.license)) err("bad-frontmatter-type", "'license' must be a string");
    else license = data.license;
  }

  if (!ORDERED_STEP_RE.test(body))
    err("no-steps", "body needs at least one ordered (numbered) step");
  VERIFICATION_RE.lastIndex = 0;
  if (!VERIFICATION_RE.test(body))
    err("no-verification", "body must end with a '## Verification' section");

  // Links: no dangling references, no traversal outside the skill folder.
  const linkTargets = new Set<string>();
  for (const match of body.matchAll(LINK_RE)) {
    const target = match[1].split("#")[0].trim();
    if (!target || /^(https?:|mailto:|#)/.test(target)) continue;
    const resolved = resolve(absDir, target);
    if (relative(absDir, resolved).startsWith("..")) {
      err("dangling-reference", `link escapes the skill folder: ${JSON.stringify(target)}`);
      continue;
    }
    linkTargets.add(resolved);
    if (!existsSync(resolved) || !statSync(resolved).isFile())
      err("dangling-reference", `link target does not exist: ${JSON.stringify(target)}`);
  }

  // No orphan files under references/ scripts/ assets/.
  for (const sub of ["references", "scripts", "assets"]) {
    const subdir = join(absDir, sub);
    if (!existsSync(subdir) || !statSync(subdir).isDirectory()) continue;
    for (const file of listFiles(subdir)) {
      if (!linkTargets.has(resolve(file)))
        err("orphan-file", `${relative(absDir, file)} is not linked from SKILL.md`);
    }
  }

  // Scripts: no curl/sh, no hardcoded secrets; network calls flagged.
  const scriptsDir = join(absDir, "scripts");
  if (existsSync(scriptsDir) && statSync(scriptsDir).isDirectory()) {
    for (const file of listFiles(scriptsDir)) {
      let content: string;
      try {
        content = readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      const rel = relative(absDir, file);
      if (CURL_RE.test(content)) err("script-curl", `${rel} invokes curl`);
      if (SHELL_RE.test(content)) err("script-shell", `${rel} invokes sh as a command`);
      if (SECRET_RES.some((re) => re.test(content))) {
        err("script-secret", `${rel} looks like it contains a hardcoded secret`);
      }
      if (NETWORK_RES.some((re) => re.test(content)))
        warn("script-network", `${rel} makes network calls (review before running)`);
    }
  }

  const hasError = problems.some((p) => p.level === "error");
  if (hasError) return { skill: null, problems };
  const skillName = isStr(name) && NAME_RE.test(name) ? name : folderName;
  const skill: Skill = {
    name: skillName,
    dir: absDir,
    description,
    allowedTools,
    userInvocable,
    disableModelInvocation,
    metadata,
    homepage,
    license,
    source,
  };
  return { skill, problems };
}
