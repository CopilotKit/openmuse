import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { AgentNotification } from "../packages/domain/src/agent.ts";
import { browserFixture } from "./helpers/browser.ts";

for (const [text, expected] of [
  ["Price: $9.99", true],
  ["Price: $ 9.99", true],
  ["Price: $\t9.99", true],
  ["Price: $\u00a09.99", true],
  ["Price: $\n9.99", true],
  ["Price: USD 9.99", true],
  ["Price: $ 12.00", false],
  ["Price: $ 10.00", false],
] as const) {
  test(`price watch handles ${JSON.stringify(text)}`, async (t) => {
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
