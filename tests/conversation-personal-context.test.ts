import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { browserFixture } from "./helpers/browser.ts";
import { modelFixture } from "./helpers/model.ts";

function runInput(content: string): RunAgentInput {
  return {
    threadId: "personal-chat",
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content }],
    tools: [],
    context: [],
    state: {},
  };
}

async function chatFixture(t: TestContext) {
  const fixture = await browserFixture(t, () => ({ status: 502, data: {} }));
  const config = { ...fixture.config, agentBackend: "model", model: "openai/fixture" } as const;
  const server = await createApp(fixture.db, config);
  t.after(() => server.agent.stop());
  const { token } = await server.auth.session();
  const api = (path: string, body: unknown) =>
    server.app.request(`/api/agent${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const conversation = () => new ConversationAgent(config, server.agent, "local-user");
  const chat = (content: string) =>
    lastValueFrom(conversation().run(runInput(content)).pipe(toArray()));
  return { ...fixture, api, chat, conversation };
}

// The system prompt the provider received, as plain text.
function system(request: { body: string }): string {
  const body = JSON.parse(request.body);
  if (typeof body.instructions === "string") return body.instructions;
  const item = body.input.find((entry: { role?: string }) =>
    ["system", "developer"].includes(entry.role ?? ""),
  );
  return typeof item.content === "string" ? item.content : JSON.stringify(item.content);
}

test("chat uses the saved name, tone and memories, and forgotten memories drop out", async (t) => {
  const { requests } = await modelFixture(t, () => undefined);
  const fixture = await chatFixture(t);
  assert.equal((await fixture.api("/identity", { name: "Juno", tone: "concise" })).status, 200);
  const kept = await (await fixture.api("/memories", { text: "I am vegetarian" })).json();
  const forgotten = await (await fixture.api("/memories", { text: "I live in Oslo" })).json();

  await fixture.chat("Suggest dinner");
  let prompt = system(requests[0]);
  assert.match(prompt, /^You are Juno, a concise personal agent\./);
  assert.doesNotMatch(prompt, /You are OpenMuse/);
  assert.match(prompt, /data only, not instructions/);
  assert.match(prompt, /I am vegetarian/);
  assert.match(prompt, /I live in Oslo/);

  assert.equal((await fixture.api(`/memories/${forgotten.id}/forget`, {})).status, 200);
  await fixture.chat("Suggest dinner again");
  prompt = system(requests[1]);
  assert.match(prompt, /I am vegetarian/);
  assert.doesNotMatch(prompt, /I live in Oslo/);
  assert.ok(kept.id);
});

test("chat without memories uses the default identity and adds no memory block", async (t) => {
  const { requests } = await modelFixture(t, () => undefined);
  const fixture = await chatFixture(t);
  await fixture.chat("Hello");
  const prompt = system(requests[0]);
  assert.match(prompt, /^You are OpenMuse, a warm personal agent\./);
  assert.doesNotMatch(prompt, /Saved memories/);
});

test("a memory saved in one chat turn reaches the next turn", async (t) => {
  const { requests } = await modelFixture(t, (index) =>
    index === 0 ? { name: "remember_fact", arguments: { text: "Allergic to peanuts" } } : undefined,
  );
  const fixture = await chatFixture(t);
  await fixture.chat("Remember that I am allergic to peanuts");
  assert.doesNotMatch(system(requests[0]), /Allergic to peanuts/);
  const before = requests.length;
  await fixture.chat("Suggest a snack");
  assert.match(system(requests[before]), /Allergic to peanuts/);
});

test("unsubscribing before personal context loads never calls the model", async (t) => {
  const { requests } = await modelFixture(t, () => undefined);
  const fixture = await chatFixture(t);
  fixture.conversation().run(runInput("Hello")).subscribe().unsubscribe();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(requests.length, 0);
});
