import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStore, type Store } from "../apps/server/src/db.ts";

async function withStore(run: (store: Store) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "openmuse-deps-"));
  const store = await createStore({ dataDir: join(root, "postgres") });
  try {
    await run(store);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("a dependency edge is stored and read back in both directions", async () => {
  await withStore(async (store) => {
    assert.equal(await store.addDependency("owner", "c", "b"), true);
    assert.deepEqual(await store.dependencies("owner", "c"), ["b"]);
    assert.deepEqual(await store.dependents("owner", "b"), ["c"]);
    assert.deepEqual(await store.dependencies("owner", "b"), []);
    assert.deepEqual(await store.dependents("owner", "c"), []);
  });
});

test("dependencies are scoped to their owner", async () => {
  await withStore(async (store) => {
    await store.addDependency("alice", "c", "b");
    assert.deepEqual(await store.dependencies("bob", "c"), []);
    assert.deepEqual(await store.dependents("bob", "b"), []);
  });
});

test("a task cannot depend on itself, and a duplicate edge is not written twice", async () => {
  await withStore(async (store) => {
    assert.equal(await store.addDependency("owner", "a", "a"), false);
    assert.equal(await store.addDependency("owner", "c", "b"), true);
    assert.equal(await store.addDependency("owner", "c", "b"), false);
    assert.deepEqual(await store.dependencies("owner", "c"), ["b"]);
  });
});

test("a cycle is refused however it is spelled", async () => {
  await withStore(async (store) => {
    // a -> b -> c, then each way of closing the loop back to a.
    assert.equal(await store.addDependency("owner", "b", "a"), true);
    assert.equal(await store.addDependency("owner", "c", "b"), true);
    assert.equal(await store.addDependency("owner", "a", "c"), false, "transitive cycle");
    assert.equal(await store.addDependency("owner", "a", "b"), false, "already implied");
    assert.deepEqual(await store.dependencies("owner", "a"), []);
    assert.deepEqual(await store.dependencies("owner", "b"), ["a"]);
    assert.deepEqual(await store.dependencies("owner", "c"), ["b"]);
  });
});

test("a diamond is allowed: shared dependencies are not a cycle", async () => {
  await withStore(async (store) => {
    assert.equal(await store.addDependency("owner", "left", "root"), true);
    assert.equal(await store.addDependency("owner", "right", "root"), true);
    assert.equal(await store.addDependency("owner", "join", "left"), true);
    assert.equal(await store.addDependency("owner", "join", "right"), true);
    assert.deepEqual(await store.dependencies("owner", "join"), ["left", "right"]);
    assert.deepEqual(await store.dependents("owner", "root"), ["left", "right"]);
  });
});

test("removing one edge leaves the rest of the graph intact", async () => {
  await withStore(async (store) => {
    await store.addDependency("owner", "join", "left");
    await store.addDependency("owner", "join", "right");
    await store.removeDependency("owner", "join", "left");
    assert.deepEqual(await store.dependencies("owner", "join"), ["right"]);
    // The freed node can now be depended on again in the direction that used to cycle.
    assert.equal(await store.addDependency("owner", "left", "join"), true);
  });
});

test("deleting a task clears both its outgoing and incoming edges", async () => {
  await withStore(async (store) => {
    await store.addDependency("owner", "downstream", "middle");
    await store.addDependency("owner", "middle", "upstream");
    await store.removeDependenciesFor("owner", "middle");
    assert.deepEqual(await store.dependencies("owner", "downstream"), []);
    assert.deepEqual(await store.dependencies("owner", "middle"), []);
    assert.deepEqual(await store.dependents("owner", "upstream"), []);
  });
});

test("dependencies survive a database restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-deps-restart-"));
  const options = { dataDir: join(root, "postgres") };
  try {
    const first = await createStore(options);
    await first.addDependency("owner", "c", "b");
    await first.close();
    const second = await createStore(options);
    assert.deepEqual(await second.dependencies("owner", "c"), ["b"]);
    await second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});