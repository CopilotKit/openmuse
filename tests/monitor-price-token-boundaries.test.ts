import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { AgentNotification } from "../packages/domain/src/agent.ts";
import { browserFixture } from "./helpers/browser.ts";

for (const [text, expected] of [
  ["Price: $1,00", false],
  ["Price: $9.999", false],
  ["Price: USD 1,00", false],
  ["Price: $1,000,00", false],
  ["Price: $9.99/month", true],
  ["Price: $1,000.00", false],
  ["Price: $9", true],
] as const) {
  test(`price watch does not truncate malformed numeric tokens: ${JSON.stringify(text)}`, async (t) => {
    const url = "https://example.com/product";
    const fixture = await browserFixture(t, (path, body) => ({
      data: path.endsWith("/read")
        ? { url, title: "Product", text, truncated: false }
        : {
            id: body.id,
            title: "Product",
            url,
            status: "active",
            updatedAt: new Date().toISOString(),
          },
    }));
    const server = await createApp(fixture.db, fixture.config);
    t.after(() => server.agent.stop());
    const owner = "price-spacing-user";
    const monitor = await server.agent.createMonitor(owner, {
      title: "Price watch",
      url,
      condition: "price_below",
      value: "10",
    });
    await server.agent.worker.tick();
    const task = await server.agent.getTask(owner, monitor.taskId);
    assert.equal(task.status, "scheduled");
    assert.equal(task.state.matched, expected);
    const notifications = await fixture.db.list<AgentNotification>(owner, "notifications");
    assert.equal(
      notifications.filter((entry) => entry.taskId === task.id).length,
      expected ? 1 : 0,
    );
  });
}
