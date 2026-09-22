import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Store } from "../apps/server/src/db.ts";
import type { AgentNotification } from "../packages/domain/src/agent.ts";
import { browserFixture } from "./helpers/browser.ts";

const page = { url: "https://example.com/product", title: "Product page" };

async function priceFixture(t: TestContext) {
  let pageText = "";
  const fixture = await browserFixture(t, (path, body) => {
    if (path.endsWith("/read"))
      return { data: { url: page.url, title: page.title, text: pageText, truncated: false } };
    return {
      data: {
        id: body.id,
        title: page.title,
        url: page.url,
        status: "active",
        updatedAt: new Date().toISOString(),
      },
    };
  });
  const server = await createApp(fixture.db, fixture.config);
  t.after(() => server.agent.stop());
  return { ...fixture, ...server, setPrice: (text: string) => (pageText = text) };
}

async function requeue(db: Store, owner: string, taskId: string) {
  await db.compareAndSwap(
    owner,
    "tasks",
    taskId,
    { status: "scheduled" },
    { nextRunAt: "2020-01-01T00:00:00Z" },
  );
}

test("a price_above watch alerts when the tracked price rises past the threshold, then stays quiet", async (t) => {
  const owner = "monitor-price-above";
  const f = await priceFixture(t);
  f.setPrice("In stock today. Price: $72.50, was $61.00.");
  const monitor = await f.agent.createMonitor(owner, {
    title: "Resale price watch",
    url: page.url,
    condition: "price_above",
    value: "60",
  });
  await f.agent.worker.tick();
  const task = await f.agent.getTask(owner, monitor.taskId);
  assert.equal(task.status, "scheduled");
  assert.equal(task.state.matched, true);
  const alerts = () =>
    f.db
      .list<AgentNotification>(owner, "notifications")
      .then((all) => all.filter((n) => n.taskId === monitor.taskId));
  assert.equal((await alerts()).length, 1);
  assert.ok((await alerts())[0].body.includes("72.50"));
  // A repeat observation above the threshold must not raise a duplicate alert.
  await requeue(f.db, owner, monitor.taskId);
  await f.agent.worker.tick();
  assert.equal((await alerts()).length, 1);
  // Falling back below the threshold clears the matched state without alerting.
  f.setPrice("In stock today. Price: $52.00.");
  await requeue(f.db, owner, monitor.taskId);
  await f.agent.worker.tick();
  const settled = await f.agent.getTask(owner, monitor.taskId);
  assert.equal(settled.status, "scheduled");
  assert.equal(settled.state.matched, false);
  assert.equal((await alerts()).length, 1);
});

test("a price_below watch alerts under the threshold and ignores higher prices", async (t) => {
  const owner = "monitor-price-below";
  const f = await priceFixture(t);
  f.setPrice("Deal of the day: $41.25.");
  const monitor = await f.agent.createMonitor(owner, {
    title: "Deal watch",
    url: page.url,
    condition: "price_below",
    value: "60",
  });
  await f.agent.worker.tick();
  const alerts = () =>
    f.db
      .list<AgentNotification>(owner, "notifications")
      .then((all) => all.filter((n) => n.taskId === monitor.taskId));
  assert.equal((await alerts()).length, 1);
  assert.ok((await alerts())[0].body.includes("41.25"));
  f.setPrice("Sold out. Price: $89.00.");
  await requeue(f.db, owner, monitor.taskId);
  await f.agent.worker.tick();
  const settled = await f.agent.getTask(owner, monitor.taskId);
  assert.equal(settled.state.matched, false);
  assert.equal((await alerts()).length, 1);
});
