/**
 * AgentSkills tests: frontmatter contract, validator rejections, routing.
 * Fixtures are built in tmpdirs (hermetic); the Python twin's fixture corpus
 * lives at ~/workspace/skills/_tools/fixtures/.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadSkills } from "./loader.ts";
import { findSkill, loadSkillBody, skillIndex, skillPromptBlock, toolsForSkill } from "./router.ts";
import type { Skill } from "./types.ts";
import { parseFrontmatter, validateSkill } from "./validate.ts";

const VALID_BODY = `# Title

1. Do the step.
2. Check the result.

## Verification

- The result is checked.
`;

const VALID_FM = (name: string, extra = "") =>
  `name: ${name}\ndescription: >-\n  Use when testing the skill validator. Do not use for anything else.\n${extra}`;

async function writeSkill(
  root: string,
  name: string,
  fm: string,
  body: string,
  files: Record<string, string> = {},
): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\n${fm}\n---\n${body}`);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  return dir;
}

async function withTmp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "openmuse-skills-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function codes(problems: { code: string }[]): string[] {
  return problems.map((p) => p.code);
}

test("parse a valid fixture: skill loads with expected fields", async () => {
  await withTmp(async (root) => {
    const dir = await writeSkill(root, "alpha", VALID_FM("alpha"), VALID_BODY, {
      "references/notes.md": "# Notes\n",
    });
    // Link the reference so it is not an orphan.
    await writeFile(
      join(dir, "SKILL.md"),
      `---\n${VALID_FM("alpha")}\n---\n# Title\n\nSee [notes](references/notes.md).\n\n1. Do the step.\n\n## Verification\n\n- Done.\n`,
    );
    const { skill, problems } = validateSkill(dir);
    assert.deepEqual(codes(problems.filter((p) => p.level === "error")), []);
    assert.ok(skill);
    assert.equal(skill.name, "alpha");
    assert.equal(skill.dir, dir);
    assert.match(skill.description, /Use when testing/);
    assert.equal(skill.userInvocable, true);
    assert.equal(skill.disableModelInvocation, false);
    assert.deepEqual(skill.allowedTools, undefined);
  });
});

test("reject missing description", async () => {
  await withTmp(async (root) => {
    const dir = await writeSkill(root, "nodesc", "name: nodesc\n", VALID_BODY);
    const { skill, problems } = validateSkill(dir);
    assert.equal(skill, null);
    assert.ok(codes(problems).includes("missing-description"));
  });
});

test("reject name/folder mismatch", async () => {
  await withTmp(async (root) => {
    const dir = await writeSkill(root, "folder", VALID_FM("other"), VALID_BODY);
    const { skill, problems } = validateSkill(dir);
    assert.equal(skill, null);
    assert.ok(codes(problems).includes("name-mismatch"));
  });
});

test("reject orphan references", async () => {
  await withTmp(async (root) => {
    const dir = await writeSkill(root, "orphan", VALID_FM("orphan"), VALID_BODY, {
      "references/extra.md": "# Extra\n",
    });
    const { skill, problems } = validateSkill(dir);
    assert.equal(skill, null);
    assert.ok(codes(problems).includes("orphan-file"));
  });
});

test("reject dangling references", async () => {
  await withTmp(async (root) => {
    const dir = await writeSkill(
      root,
      "dangling",
      VALID_FM("dangling"),
      "# T\n\nSee [missing](references/missing.md).\n\n1. Step.\n\n## Verification\n\n- Done.\n",
    );
    const { skill, problems } = validateSkill(dir);
    assert.equal(skill, null);
    assert.ok(codes(problems).includes("dangling-reference"));
  });
});

test("reject unknown frontmatter keys", async () => {
  await withTmp(async (root) => {
    const dir = await writeSkill(root, "weird", VALID_FM("weird", "zzz: 1\n"), VALID_BODY);
    const { skill, problems } = validateSkill(dir);
    assert.equal(skill, null);
    assert.ok(codes(problems).includes("unknown-key"));
  });
});

test("reject oversized description", async () => {
  await withTmp(async (root) => {
    const fm = `name: bigdesc\ndescription: ${"x".repeat(501)}\n`;
    const dir = await writeSkill(root, "bigdesc", fm, VALID_BODY);
    const { skill, problems } = validateSkill(dir);
    assert.equal(skill, null);
    assert.ok(codes(problems).includes("description-too-long"));
  });
});

test("reject missing Verification section", async () => {
  await withTmp(async (root) => {
    const dir = await writeSkill(root, "nover", VALID_FM("nover"), "# T\n\n1. Step one.\n");
    const { skill, problems } = validateSkill(dir);
    assert.equal(skill, null);
    assert.ok(codes(problems).includes("no-verification"));
  });
});

test("reject markdown links in descriptions", async () => {
  await withTmp(async (root) => {
    const fm = `name: mdlink\ndescription: Use [this](https://example.com) for things.\n`;
    const dir = await writeSkill(root, "mdlink", fm, VALID_BODY);
    const { skill, problems } = validateSkill(dir);
    assert.equal(skill, null);
    assert.ok(codes(problems).includes("description-markdown"));
  });
});

test("reject scripts with curl / sh / hardcoded secrets; warn on network", async () => {
  await withTmp(async (root) => {
    const mk = (name: string, script: string) =>
      writeSkill(
        root,
        name,
        VALID_FM(name),
        `# T\n\nSee [s](scripts/run.py).\n\n1. Step.\n\n## Verification\n\n- Done.\n`,
        { "scripts/run.py": script },
      );
    for (const [name, script, code] of [
      ["curlskill", "import os\nos.system('curl https://example.com')\n", "script-curl"],
      ["shskill", "import subprocess\nsubprocess.run(\"sh -c 'echo hi'\")\n", "script-shell"],
      ["secretskill", 'api_key = "sk-1234567890"\n', "script-secret"],
    ] as const) {
      const dir = await mk(name, script);
      const { skill, problems } = validateSkill(dir);
      assert.equal(skill, null, name);
      assert.ok(codes(problems).includes(code), `${name}: ${codes(problems)}`);
    }
    const netDir = await mk("netskill", "import urllib.request\nprint('hi')\n");
    const net = validateSkill(netDir);
    assert.ok(net.skill, "network call is a warning, not an error");
    assert.ok(codes(net.problems).includes("script-network"));
  });
});

test("index excludes disable-model-invocation skills and is sorted", async () => {
  const mk = (name: string, disabled: boolean): Skill => ({
    name,
    dir: `/skills/${name}`,
    description: `Skill ${name}.`,
    userInvocable: true,
    disableModelInvocation: disabled,
    metadata: {},
    source: "workspace",
  });
  const index = skillIndex([mk("zeta", false), mk("alpha", true), mk("mid", false)]);
  assert.deepEqual(
    index.map((e) => e.name),
    ["mid", "zeta"],
  );
});

test("loadSkillBody resolves relative references to absolute paths", async () => {
  await withTmp(async (root) => {
    const dir = await writeSkill(
      root,
      "paths",
      VALID_FM("paths"),
      `# T\n\nSee [r](references/r.md) and [ext](https://example.com/x).\n\n1. Step.\n\n## Verification\n\n- Done.\n`,
      { "references/r.md": "# R\n" },
    );
    const { skill } = validateSkill(dir);
    assert.ok(skill);
    const body = loadSkillBody(skill);
    assert.ok(body.includes(join(dir, "references/r.md")), body);
    assert.ok(!body.includes("](references/r.md)"));
    assert.ok(body.includes("](https://example.com/x)"));
    assert.ok(!body.includes("---"), "frontmatter is stripped");
  });
});

test("toolsForSkill intersects and never widens", async () => {
  const restricted: Skill = {
    name: "r",
    dir: "/x",
    description: "d",
    allowedTools: ["read_workspace", "search_mail"],
    userInvocable: true,
    disableModelInvocation: false,
    metadata: {},
    source: "workspace",
  };
  assert.deepEqual(toolsForSkill(restricted, ["read_workspace", "browse_web"]), ["read_workspace"]);
  assert.deepEqual(toolsForSkill(restricted, ["browse_web"]), []);
  const open: Skill = { ...restricted, allowedTools: undefined };
  assert.deepEqual(toolsForSkill(open, ["a", "b"]), ["a", "b"]);
});

test("skillPromptBlock is empty with no skills and lists the index otherwise", async () => {
  assert.equal(skillPromptBlock([]), "");
  const s: Skill = {
    name: "alpha",
    dir: "/x",
    description: "Use for tests.",
    userInvocable: true,
    disableModelInvocation: false,
    metadata: {},
    source: "workspace",
  };
  const block = skillPromptBlock([s]);
  assert.ok(block.includes("read_skill"));
  assert.ok(block.includes("alpha: Use for tests."));
  assert.ok(block.includes("cannot authorize credential disclosure"));
});

test("parseFrontmatter handles folded scalars, lists, and maps", async () => {
  const { data, error } = parseFrontmatter(
    `---\nname: x\ndescription: >-\n  line one\n  line two\nallowed-tools:\n  - read_a\nmetadata:\n  version: "1.0"\n---\nbody\n`,
  );
  assert.equal(error, undefined);
  assert.equal(data?.description, "line one line two");
  assert.deepEqual(data?.["allowed-tools"], ["read_a"]);
  assert.deepEqual(data?.metadata, { version: "1.0" });
});

test("loadSkills skips invalid packs fail-open and honors the allow-list", async () => {
  await withTmp(async (root) => {
    await writeSkill(root, "good", VALID_FM("good"), VALID_BODY);
    await writeSkill(root, "bad", "name: bad\n", VALID_BODY); // missing description
    const all = await loadSkills({ workspaceDir: root });
    assert.deepEqual(
      all.skills.map((s) => s.name),
      ["good"],
    );
    assert.ok(all.problems.some((p) => p.code === "missing-description" && p.level === "error"));
    const filtered = await loadSkills({ workspaceDir: root, allowList: ["nope"] });
    assert.deepEqual(filtered.skills, []);
    assert.ok(findSkill(all.skills, "good"));
    assert.equal(findSkill(all.skills, "missing"), undefined);
  });
});
