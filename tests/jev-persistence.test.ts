import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import type { JevAdapter } from "../apps/server/src/jev/adapter.ts";
import { JevService } from "../apps/server/src/jev/service.ts";

const options = [
  {
    id: "a",
    label: "Kelp Forest",
    details: ["Forest"],
    sources: [{ title: "Kelp", url: "https://example.org/kelp" }],
  },
  {
    id: "b",
    label: "Rocky Shore",
    details: ["Touch pool"],
    sources: [{ title: "Rocky", url: "https://example.org/rocky" }],
  },
];
const adapter: JevAdapter = {
  decide: async ({ options }) => ({
    control: "comparison",
    scores: Object.fromEntries(options.map((o, i) => [o.id, i])),
  }),
};
const args = {
  message: "Compare",
  context: "Observed pages",
  title: "Exhibits",
  control: "comparison" as const,
  options,
};

test("panels survive restart and reject owner, thread, option, version and replay conflicts", async (t) => {
  const dataDir = join(await mkdtemp(join(tmpdir(), "jev-persist-")), "db");
  let store = await createStore({ dataDir });
  const service = new JevService({ store, adapter, mode: "sample" });
  const result = await service.createPanel(
    "owner",
    "thread",
    "turn",
    args,
    new AbortController().signal,
  );
  assert.ok(result.panel);
  const panel = result.panel;
  await store.close();
  store = await createStore({ dataDir });
  t.after(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const restored = new JevService({ store, adapter, mode: "sample" });
  const action = {
    panelId: panel.id,
    threadId: "thread",
    candidateSetVersion: panel.candidateSetVersion,
    optionId: "b",
  };
  await assert.rejects(restored.select("other", "thread", action));
  await assert.rejects(restored.select("owner", "other-thread", action));
  await assert.rejects(restored.select("owner", "thread", { ...action, optionId: "missing" }));
  await assert.rejects(restored.select("owner", "thread", { ...action, candidateSetVersion: 99 }));
  assert.match((await restored.select("owner", "thread", action)).continuation, /Rocky Shore/);
  assert.match((await restored.select("owner", "thread", action)).continuation, /Rocky Shore/);
  await assert.rejects(restored.select("owner", "thread", { ...action, optionId: "a" }));
});

test("new generation supersedes an old panel and prevents late inference publication", async (t) => {
  const dataDir = join(await mkdtemp(join(tmpdir(), "jev-race-")), "db");
  const store = await createStore({ dataDir });
  t.after(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const racing: JevAdapter = {
    decide: async (input) => {
      if (input.message === "old") await gate;
      return {
        control: "comparison",
        scores: Object.fromEntries(input.options.map((o, i) => [o.id, i])),
      };
    },
  };
  const service = new JevService({ store, adapter: racing, mode: "sample" });
  const first = service.createPanel(
    "owner",
    "thread",
    "old-turn",
    { ...args, message: "old" },
    new AbortController().signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const newer = await service.createPanel(
    "owner",
    "thread",
    "new-turn",
    { ...args, message: "new" },
    new AbortController().signal,
  );
  assert.ok(newer.panel);
  release();
  const old = await first;
  assert.equal(old.panel, null);
  assert.match(old.error ?? "", /superseded/i);
  const head = await service.currentPanel("owner", "thread");
  assert.equal(head?.id, newer.panel.id);
  await assert.rejects(
    service.select("owner", "thread", {
      panelId: "missing",
      threadId: "thread",
      candidateSetVersion: 1,
      optionId: "a",
    }),
  );
});

test("refinement reuses all candidates and carries a selected option forward", async (t) => {
  const dataDir = join(await mkdtemp(join(tmpdir(), "jev-refine-")), "db");
  const store = await createStore({ dataDir });
  t.after(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const more = [
    ...options,
    {
      id: "c",
      label: "Open Sea",
      details: ["Far views"],
      sources: [{ title: "Sea", url: "https://example.org/sea" }],
    },
    {
      id: "d",
      label: "Birds",
      details: ["Birds"],
      sources: [{ title: "Birds", url: "https://example.org/birds" }],
    },
  ];
  const service = new JevService({ store, adapter, mode: "sample" });
  const first = await service.createPanel(
    "owner",
    "thread",
    "turn",
    { ...args, options: more },
    new AbortController().signal,
  );
  assert.ok(first.panel);
  await service.select("owner", "thread", {
    panelId: first.panel.id,
    threadId: "thread",
    candidateSetVersion: first.panel.candidateSetVersion,
    optionId: "b",
  });
  const refined = await service.createPanel(
    "owner",
    "thread",
    "next",
    { ...args, options: [], refinementPanelId: first.panel.id },
    new AbortController().signal,
  );
  assert.ok(refined.panel);
  assert.equal(refined.panel.selectedId, "b");
  assert.equal(refined.panel.options.length, 3);
  assert.ok(refined.panel.options.some((option) => option.id === "b"));
  await assert.rejects(
    service.select("owner", "thread", {
      panelId: first.panel.id,
      threadId: "thread",
      candidateSetVersion: first.panel.candidateSetVersion,
      optionId: "b",
    }),
  );
});

test("aborted decision never publishes a panel", async (t) => {
  const dataDir = join(await mkdtemp(join(tmpdir(), "jev-abort-")), "db");
  const store = await createStore({ dataDir });
  t.after(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const controller = new AbortController();
  const cancelling: JevAdapter = {
    decide: async ({ options }) => {
      controller.abort();
      return { control: "comparison", scores: Object.fromEntries(options.map((o) => [o.id, 1])) };
    },
  };
  const service = new JevService({ store, adapter: cancelling, mode: "sample" });
  await assert.rejects(service.createPanel("owner", "thread", "turn", args, controller.signal));
  assert.deepEqual(await store.list("owner", "jev_panels"), []);
});
