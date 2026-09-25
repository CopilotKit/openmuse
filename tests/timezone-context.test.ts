import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildChatPrompt,
  TIMEZONE_FALLBACK,
  timezoneResource,
} from "../apps/server/src/engine/context/index.ts";

test("timezoneResource anchors the prompt to the owner's timezone", () => {
  const r = timezoneResource("America/Chicago");
  assert.equal(r.id, "timezone");
  const body = r.materialize() as string;
  assert.ok(body.includes("America/Chicago"), "mentions the timezone");
  assert.ok(body.includes("2pm"), "guides relative-time interpretation");
  assert.ok(!/\$\{/.test(TIMEZONE_FALLBACK), "fallback is a static string");
  assert.ok(TIMEZONE_FALLBACK.includes("America/Chicago"));
});

test("buildChatPrompt includes the timezone section", async () => {
  const { prompt, plan } = await buildChatPrompt({
    soul: "s",
    skillsBlock: "",
    memoryBlock: "recall-stub",
    mailAvailable: false,
  });
  assert.ok(prompt.includes("## timezone\n"), "timezone section present");
  assert.ok(prompt.includes("America/Chicago"), "owner timezone in prompt");
  assert.ok(plan.included.includes("timezone"), "timezone in plan");
  // Section order: identity (100) > timezone (90) > memories (80)
  const order = ["identity", "timezone", "memories"].map((id) => prompt.indexOf(`## ${id}\n`));
  assert.ok(
    order.every((i) => i >= 0),
    "all sections present",
  );
  assert.ok(order[0] < order[1] && order[1] < order[2], "priority order kept");
});
