import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { AgentNotification } from "../packages/domain/src/agent.ts";
import { browserFixture } from "./helpers/browser.ts";

for (const [value, text, expected] of [
  ["In stock", "Status: In stock", true],
  ["In stock ", "Status: In stock", true],
  [" in stock", "Status: In stock", true],
  ["In  stock", "Status: In stock.", true],
  ["In\nstock", "Status: In\n  stock", true],
  ["In\u00a0stock", "Status: In stock now", true],
  ["Sold out ", "Status: In stock", false],
] as const) {
  test(`contains watch matches ${JSON.stringify(value)} in ${JSON.stringify(text)}`, async (t) => {
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
    const owner = "contains-spacing-user";
    const monitor = await server.agent.createMonitor(owner, {
      title: "Stock watch",
      url,
      condition: "contains",
      value,
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
