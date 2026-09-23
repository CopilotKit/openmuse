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

test("refinement reuses all candidates and permits a new selection", async (t) => {
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
  assert.equal(refined.panel.selectedId, undefined);
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

test("failed, aborted, and agent decisions keep the prior panel selectable", async (t) => {
  const dataDir = join(await mkdtemp(join(tmpdir(), "jev-preserve-")), "db");
  const store = await createStore({ dataDir });
  t.after(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const initial = new JevService({ store, adapter, mode: "sample" });
  const first = await initial.createPanel(
    "owner",
    "thread",
    "turn",
    args,
    new AbortController().signal,
  );
  assert.ok(first.panel);
  const failing = new JevService({
    store,
    adapter: {
      decide: async () => {
        throw new Error("unavailable");
      },
    },
    mode: "sample",
  });
  await assert.rejects(
    failing.createPanel("owner", "thread", "failed", args, new AbortController().signal),
  );
  assert.equal((await initial.currentPanel("owner", "thread"))?.id, first.panel.id);
  const cancelled = new AbortController();
  const aborting = new JevService({
    store,
    adapter: {
      decide: async () => {
        cancelled.abort();
        return { control: "comparison", scores: { a: 1, b: 2 } };
      },
    },
    mode: "sample",
  });
  await assert.rejects(aborting.createPanel("owner", "thread", "aborted", args, cancelled.signal));
  assert.equal((await initial.currentPanel("owner", "thread"))?.id, first.panel.id);
  const ordinary = new JevService({
    store,
    adapter: { decide: async () => ({ control: "agent", scores: { a: 1, b: 2 } }) },
    mode: "sample",
  });
  assert.deepEqual(
    await ordinary.createPanel("owner", "thread", "ordinary", args, new AbortController().signal),
    { panel: null },
  );
  assert.equal((await initial.currentPanel("owner", "thread"))?.id, first.panel.id);
  const selection = await initial.select("owner", "thread", {
    panelId: first.panel.id,
    threadId: "thread",
    candidateSetVersion: first.panel.candidateSetVersion,
    optionId: "a",
  });
  assert.match(selection.continuation, /Kelp Forest/);
});

test("stale refinement cannot reserve over a newer published panel", async (t) => {
  const dataDir = join(await mkdtemp(join(tmpdir(), "jev-stale-refine-")), "db");
  const store = await createStore({ dataDir });
  t.after(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const service = new JevService({ store, adapter, mode: "sample" });
  const first = await service.createPanel(
    "owner",
    "thread",
    "initial",
    args,
    new AbortController().signal,
  );
  assert.ok(first.panel);
  const originalInsert = store.insertIfAbsent.bind(store);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused!: () => void;
  const pausedAtReserve = new Promise<void>((resolve) => {
    paused = resolve;
  });
  let hold = true;
  store.insertIfAbsent = async (owner, kind, value) => {
    if (kind === "jev_threads" && hold) {
      hold = false;
      paused();
      await gate;
    }
    return originalInsert(owner, kind, value);
  };
  const stale = service.createPanel(
    "owner",
    "thread",
    "stale",
    { ...args, refinementPanelId: first.panel.id },
    new AbortController().signal,
  );
  await pausedAtReserve;
  const newer = await service.createPanel(
    "owner",
    "thread",
    "new",
    args,
    new AbortController().signal,
  );
  assert.ok(newer.panel);
  release();
  await assert.rejects(stale, /superseded/);
  assert.equal((await service.currentPanel("owner", "thread"))?.id, newer.panel.id);
});

test("refinement after a selection remains selectable as a new panel", async (t) => {
  const dataDir = join(await mkdtemp(join(tmpdir(), "jev-select-refine-")), "db");
  const store = await createStore({ dataDir });
  t.after(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const service = new JevService({ store, adapter, mode: "sample" });
  const first = await service.createPanel(
    "owner",
    "thread",
    "initial",
    args,
    new AbortController().signal,
  );
  assert.ok(first.panel);
  await service.select("owner", "thread", {
    panelId: first.panel.id,
    threadId: "thread",
    candidateSetVersion: first.panel.candidateSetVersion,
    optionId: "a",
  });
  const refined = await service.createPanel(
    "owner",
    "thread",
    "refined",
    { ...args, refinementPanelId: first.panel.id },
    new AbortController().signal,
  );
  assert.ok(refined.panel);
  assert.equal(refined.panel.selectedId, undefined);
  const action = {
    panelId: refined.panel.id,
    threadId: "thread",
    candidateSetVersion: refined.panel.candidateSetVersion,
    optionId: "b",
  };
  assert.match((await service.select("owner", "thread", action)).continuation, /Rocky Shore/);
});

test("candidate source lookup uses the full current set and rejects sample proof in live mode", async (t) => {
  const dataDir = join(await mkdtemp(join(tmpdir(), "jev-sources-")), "db");
  const store = await createStore({ dataDir });
  t.after(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const four = [
    ...options,
    {
      id: "c",
      label: "Open Sea",
      details: [],
      sources: [{ title: "Sea", url: "https://example.org/sea" }],
    },
    {
      id: "d",
      label: "Birds",
      details: [],
      sources: [{ title: "Birds", url: "https://example.org/birds" }],
    },
  ];
  const sample = new JevService({ store, adapter, mode: "sample" });
  const result = await sample.createPanel(
    "owner",
    "thread",
    "turn",
    { ...args, options: four },
    new AbortController().signal,
  );
  assert.ok(result.panel);
  assert.equal(result.panel.options.length, 3);
  assert.deepEqual(await sample.candidateSources("owner", "thread", result.panel.id), [
    "https://example.org/kelp",
    "https://example.org/rocky",
    "https://example.org/sea",
    "https://example.org/birds",
  ]);
  await assert.rejects(sample.candidateSources("other", "thread", result.panel.id));
  const live = new JevService({ store, adapter, mode: "live" });
  await assert.rejects(live.candidateSources("owner", "thread", result.panel.id));
  const next = await sample.createPanel(
    "owner",
    "thread",
    "next",
    args,
    new AbortController().signal,
  );
  assert.ok(next.panel);
  await assert.rejects(sample.candidateSources("owner", "thread", result.panel.id));
});

test("evidence records are scoped to owner, thread, and run", async (t) => {
  const dataDir = join(await mkdtemp(join(tmpdir(), "jev-evidence-")), "db");
  const store = await createStore({ dataDir });
  t.after(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const service = new JevService({ store, adapter, mode: "live" });
  await service.noteEvidence("owner", "thread", "run-1", "mail", "trip-thread");
  await service.noteEvidence("owner", "thread", "run-1", "web", "https://example.org/kelp");
  assert.equal(await service.hasAnyMailEvidence("owner", "thread", "run-1"), true);
  assert.equal(await service.hasAnyMailEvidence("owner", "thread", "run-2"), false);
  assert.equal(
    await service.hasEvidence("owner", "thread", "run-1", "web", "https://example.org/kelp"),
    true,
  );
  assert.equal(
    await service.hasEvidence("owner", "thread", "run-2", "web", "https://example.org/kelp"),
    false,
  );
  assert.equal(
    await service.hasEvidence("other", "thread", "run-1", "web", "https://example.org/kelp"),
    false,
  );
});

test("a selection made during inference prevents the new panel from replacing it", async (t) => {
  const dataDir = join(await mkdtemp(join(tmpdir(), "jev-select-race-")), "db");
  const store = await createStore({ dataDir });
  t.after(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const initial = new JevService({ store, adapter, mode: "sample" });
  const first = await initial.createPanel(
    "owner",
    "thread",
    "first",
    args,
    new AbortController().signal,
  );
  assert.ok(first.panel);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const inferenceStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const slow: JevAdapter = {
    decide: async ({ options }) => {
      started();
      await gate;
      return {
        control: "comparison",
        scores: Object.fromEntries(options.map((option) => [option.id, 1])),
      };
    },
  };
  const service = new JevService({ store, adapter: slow, mode: "sample" });
  const pending = service.createPanel(
    "owner",
    "thread",
    "second",
    args,
    new AbortController().signal,
  );
  await inferenceStarted;
  await initial.select("owner", "thread", {
    panelId: first.panel.id,
    threadId: "thread",
    candidateSetVersion: first.panel.candidateSetVersion,
    optionId: "a",
  });
  release();
  const result = await pending;
  assert.equal(result.panel, null);
  assert.match(result.error ?? "", /superseded/i);
  assert.equal((await initial.currentPanel("owner", "thread"))?.id, first.panel.id);
  assert.equal(
    (await store.get<{ selectedId: string }>("owner", "jev_threads", "thread"))?.selectedId,
    "a",
  );
});
