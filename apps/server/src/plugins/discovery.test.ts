import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverPlugins } from "./discovery.ts";

const FIXTURES = join(import.meta.dirname, "test/fixtures/plugins");

test("fixture dirs with manifests are discovered; others are ignored", async () => {
  const { plugins, errors } = await discoverPlugins([FIXTURES]);
  const ids = plugins.map((plugin) => plugin.manifest.id);
  assert.ok(ids.includes("fixture-good"), `expected fixture-good in ${ids.join(",")}`);
  assert.ok(ids.includes("fixture-no-export"), `expected fixture-no-export in ${ids.join(",")}`);
  assert.ok(!ids.includes("no-manifest"), "folders without a manifest must be ignored");
  // The invalid fixtures are reported, not thrown.
  assert.ok(errors.length > 0);
});

test("invalid manifests are reported, never thrown", async () => {
  const { plugins, errors } = await discoverPlugins([FIXTURES]);
  const byDir = new Map(errors.map((error) => [error.dir.split("/").pop(), error.message]));
  for (const dir of [
    "bad-id",
    "config-group-mismatch",
    "extra-key",
    "writeonly-no-password",
    "risky-tool-no-approval",
    "skills-traversal",
    "invalid-json",
  ]) {
    assert.ok(byDir.has(dir), `expected an error for fixture dir "${dir}"`);
  }
  assert.match(byDir.get("bad-id") ?? "", /manifest\.id/);
  assert.match(byDir.get("config-group-mismatch") ?? "", /configGroups/);
  assert.match(byDir.get("extra-key") ?? "", /unknown root key/);
  assert.match(byDir.get("writeonly-no-password") ?? "", /writeOnly/);
  assert.match(byDir.get("risky-tool-no-approval") ?? "", /requiresApproval/);
  assert.match(byDir.get("skills-traversal") ?? "", /traversal/);
  assert.match(byDir.get("invalid-json") ?? "", /not valid JSON/);
  // Invalid ones are not in the discovered set.
  const ids = plugins.map((plugin) => plugin.manifest.id);
  assert.ok(
    !ids.some(
      (id) => id.startsWith("fixture-") && id !== "fixture-good" && id !== "fixture-no-export",
    ),
  );
});

test("custom load paths are honored", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-plugins-"));
  try {
    const dir = join(root, "custom");
    await mkdir(dir, { recursive: true });
    await cp(join(FIXTURES, "good/openmuse.plugin.json"), join(dir, "openmuse.plugin.json"));
    const { plugins, errors } = await discoverPlugins([root]);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      plugins.map((plugin) => plugin.manifest.id),
      ["fixture-good"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("roots with a workspace/uploads segment outside the server subtree are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-plugins-"));
  try {
    // A workspace segment outside apps/server must never be a plugin root:
    // a dropped manifest + plugin.ts there would be import()ed.
    const evil = join(root, "workspace");
    await mkdir(join(evil, "evil"), { recursive: true });
    await cp(join(FIXTURES, "good/openmuse.plugin.json"), join(evil, "evil/openmuse.plugin.json"));
    const { plugins, errors } = await discoverPlugins([evil]);
    assert.deepEqual(plugins, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate plugin ids keep the first copy and report the second", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-plugins-"));
  try {
    for (const name of ["a", "b"]) {
      const dir = join(root, name);
      await mkdir(dir, { recursive: true });
      await cp(join(FIXTURES, "good/openmuse.plugin.json"), join(dir, "openmuse.plugin.json"));
    }
    const { plugins, errors } = await discoverPlugins([root]);
    assert.equal(plugins.length, 1);
    assert.ok(errors.some((error) => error.message.includes("duplicate plugin id")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
