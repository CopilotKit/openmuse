import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { matchesPrice } from "../apps/server/src/engine/price.ts";
import type { AgentNotification } from "../packages/domain/src/agent.ts";
import { browserFixture } from "./helpers/browser.ts";

const THRESHOLD = 10;

for (const [text, expected, why] of [
  ["Price: $1,00", false, "truncated thousands group is not a price"],
  ["Price: $1,0", false, "truncated thousands group is not a price"],
  ["Price: $9.999", false, "a third decimal digit is not a price"],
  ["Price: USD 1,00", false, "truncated thousands group is not a price"],
  ["Price: $9M", false, "a magnitude suffix is not a bare price"],
  ["Price: $9k", false, "a magnitude suffix is not a bare price"],
  ["Price: $1,000,00", false, "a second thousands comma is not a price"],
  ["Price: $1,000", false, "1000 is not under the threshold"],
  ["Price: $1,000.00", false, "1000 is not under the threshold"],
  ["Only $5,", true, "a sentence comma still ends the price"],
  ["Price: $9, limited time", true, "a sentence comma still ends the price"],
  ["$5, $20", true, "a comma-separated list keeps both prices"],
  ["Now $9, was $20", true, "the lower price is still found"],
  ["Price: $9.99/month", true, "a slash still ends the price"],
  ["Price: $9", true, "a plain price under the threshold matches"],
] as const) {
  test(`matchesPrice ${expected ? "matches" : "rejects"} ${JSON.stringify(text)} (${why})`, () => {
    assert.equal(matchesPrice(text, THRESHOLD), expected);
  });
}

test("price watch reaches the worker outcome path through matchesPrice", async (t) => {
  const url = "https://example.com/product";
  const fixture = await browserFixture(t, (path, body) => ({
    data: path.endsWith("/read")
      ? { url, title: "Product", text: "Only $5, today only", truncated: false }
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
  const owner = "price-boundary-user";
  const monitor = await server.agent.createMonitor(owner, {
    title: "Price watch",
    url,
    condition: "price_below",
    value: "10",
  });
  await server.agent.worker.tick();
  const task = await server.agent.getTask(owner, monitor.taskId);
  assert.equal(task.status, "scheduled");
  assert.equal(task.state.matched, true);
  const notifications = await fixture.db.list<AgentNotification>(owner, "notifications");
  assert.equal(notifications.filter((entry) => entry.taskId === task.id).length, 1);
});
