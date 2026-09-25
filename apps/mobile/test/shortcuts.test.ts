import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { KeyValueStore } from "../src/session-store.ts";
import {
  addShortcut,
  deleteShortcut,
  getShortcutsSnapshot,
  loadShortcuts,
  setShortcutStore,
  subscribeShortcuts,
  updateShortcut,
} from "../src/shortcuts.ts";

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

afterEach(() => {
  setShortcutStore(null);
});

test("shortcuts round-trip through storage as JSON", async () => {
  const store = memoryStore();
  setShortcutStore(store);
  assert.deepEqual(await loadShortcuts(), []);
  const created = await addShortcut("Morning briefing", "Summarize my unread email");
  assert.equal(created.label, "Morning briefing");
  assert.equal(created.instruction, "Summarize my unread email");
  assert.match(created.id, /^sc-/);
  const list = await loadShortcuts();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], created);
  // Persisted under the expected key as JSON.
  const raw = store.data.get("openmuse.chat.shortcuts");
  assert.ok(typeof raw === "string");
  assert.deepEqual(JSON.parse(raw), [created]);
});

test("addShortcut trims input and rejects blanks", async () => {
  setShortcutStore(memoryStore());
  const created = await addShortcut("  Padded  ", "  do the thing  ");
  assert.equal(created.label, "Padded");
  assert.equal(created.instruction, "do the thing");
  await assert.rejects(() => addShortcut("   ", "instruction"), /label/i);
  await assert.rejects(() => addShortcut("Label", "   "), /instruction/i);
  assert.equal((await loadShortcuts()).length, 1);
});

test("updateShortcut edits label and instruction, keeps id", async () => {
  setShortcutStore(memoryStore());
  const created = await addShortcut("Old", "old instruction");
  const updated = await updateShortcut(created.id, {
    label: "New",
    instruction: "new instruction",
  });
  assert.ok(updated);
  assert.equal(updated.id, created.id);
  assert.equal(updated.label, "New");
  assert.equal(updated.instruction, "new instruction");
  assert.equal((await loadShortcuts())[0]?.label, "New");
});

test("updateShortcut ignores blank patch values and misses unknown ids", async () => {
  setShortcutStore(memoryStore());
  const created = await addShortcut("Keep", "keep instruction");
  const updated = await updateShortcut(created.id, { label: "   " });
  assert.ok(updated);
  assert.equal(updated.label, "Keep");
  assert.equal(await updateShortcut("sc-does-not-exist", { label: "x" }), null);
});

test("deleteShortcut removes only the matching shortcut", async () => {
  setShortcutStore(memoryStore());
  const a = await addShortcut("A", "instruction a");
  const b = await addShortcut("B", "instruction b");
  assert.equal(await deleteShortcut(a.id), true);
  const list = await loadShortcuts();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, b.id);
  assert.equal(await deleteShortcut(a.id), false);
});

test("corrupt stored JSON loads as an empty list", async () => {
  const store = memoryStore();
  store.data.set("openmuse.chat.shortcuts", "{not valid json");
  setShortcutStore(store);
  assert.deepEqual(await loadShortcuts(), []);
});

test("shortcuts survive a backend swap (reload simulation)", async () => {
  const data = new Map<string, string>();
  const backend = (): KeyValueStore => ({
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  });
  setShortcutStore(backend());
  await addShortcut("A", "instruction a");
  // Simulate an app restart: a fresh backend over the same underlying data.
  setShortcutStore(backend());
  const list = await loadShortcuts();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.label, "A");
});

test("subscribers are notified when shortcuts change", async () => {
  setShortcutStore(memoryStore());
  let calls = 0;
  const unsubscribe = subscribeShortcuts(() => {
    calls += 1;
  });
  await loadShortcuts(); // initial load emits once
  assert.equal(calls, 1);
  const created = await addShortcut("A", "instruction a");
  assert.equal(calls, 2);
  assert.equal(getShortcutsSnapshot().length, 1);
  await deleteShortcut(created.id);
  assert.equal(calls, 3);
  assert.deepEqual(getShortcutsSnapshot(), []);
  unsubscribe();
  await addShortcut("B", "instruction b");
  assert.equal(calls, 3);
});
