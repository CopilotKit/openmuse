import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import type { Note } from "../packages/domain/src/agent.ts";
import { browserFixture } from "./helpers/browser.ts";
import { modelFixture } from "./helpers/model.ts";

function runInput(content: string): RunAgentInput {
  return {
    threadId: "notes-chat",
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content }],
    tools: [],
    context: [],
    state: {},
  };
}

async function chatFixture(t: TestContext, body: string) {
  // Two fixtures, for two different jobs: `modelFixture` stands in for the model
  // provider (so we can script which tool it calls), `browserFixture` supplies
  // the config and store. Neither alone has what this test needs.
  const model = await modelFixture(t, (index) =>
    index % 2 === 0 ? { name: "capture_note", arguments: { body } } : undefined,
  );
  const fixture = await browserFixture(t, () => ({ data: {} }));
  const config = { ...fixture.config, agentBackend: "model", model: "openai/fixture" } as const;
  const server = await createApp(fixture.db, config);
  t.after(() => server.agent.stop());
  return {
    ...fixture,
    ...model,
    ...server,
    conversation: new ConversationAgent(config, server.agent, "local-user"),
  };
}

async function runChat(t: TestContext, model: string) {
  const fixture = await chatFixture(t, model);
  await lastValueFrom(
    fixture.conversation.run(runInput("Jot this down for later.")).pipe(toArray()),
  );
  return fixture;
}

test("chat can capture a note, and capturing starts no work", async (t) => {
  const fixture = await runChat(t, "Ask Bea about the lease window.");

  const notes = await fixture.db.list<Note>("local-user", "notes");
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.body, "Ask Bea about the lease window.");
  assert.equal(notes[0]?.status, "open");
  assert.equal(notes[0]?.taskId, undefined);

  // The whole point of the tool: a captured thought is not work. If this ever
  // creates a task, the agent is queueing work the user never confirmed.
  assert.deepEqual(await fixture.db.list("local-user", "tasks"), []);
});

test("a note captured in chat is promotable from the device afterwards", async (t) => {
  // Requirement 1 is "from any device": what chat writes must be ordinary
  // note-plane data, promotable through the same endpoint the phone uses.
  const fixture = await runChat(t, "Something worth doing later.");

  const { token } = await fixture.auth.session();
  const listed = await fixture.app.request("/api/agent/notes", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(listed.status, 200);
  const rows = (await listed.json()) as (Note & { promotable: boolean })[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.promotable, true);

  const promoted = await fixture.app.request(`/api/agent/notes/${rows[0]?.id}/promote`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(promoted.status, 200, await promoted.clone().text());
  const result = (await promoted.json()) as { taskId: string; alreadyPromoted: boolean };
  assert.equal(result.alreadyPromoted, false);
  const tasks = await fixture.db.list<{ id: string; prompt: string }>("local-user", "tasks");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.id, result.taskId);
  assert.equal(tasks[0]?.prompt, "Something worth doing later.");
});

test("chat is offered capture_note but never a promotion tool", async (t) => {
  // The agent may suggest and capture; only the user may confirm. If a
  // promotion tool ever appears in the chat tool set, the agent could start work
  // on its own initiative, which is exactly what SYNC.md rules out.
  const fixture = await chatFixture(t, "Anything.");
  await lastValueFrom(fixture.conversation.run(runInput("Jot this down.")).pipe(toArray()));

  const first = fixture.requests[0]?.body ?? "";
  assert.ok(first.includes('"capture_note"'), "capture_note should be offered to the model");
  assert.doesNotMatch(first, /"promote_note"/);
  assert.doesNotMatch(first, /"notes\/:id\/promote"/);
  // `delegate_task` is the tool that DOES start work, and it is still offered:
  // the distinction is which one the model picks, not that one is hidden.
  assert.ok(first.includes('"delegate_task"'));
});

test("a replayed capture_note call saves one note, not two", async (t) => {
  // Tool calls get retried when a provider stream drops. `createNote` mints a
  // random id without an idempotency key, so the tool passes one derived from
  // the request — otherwise a retry silently duplicates the user's thought.
  const fixture = await chatFixture(t, "Only save this once.");
  const input = runInput("Jot this down.");
  // Run the SAME request twice, as a provider retry would.
  await lastValueFrom(fixture.conversation.run(input).pipe(toArray()));
  await lastValueFrom(fixture.conversation.run(input).pipe(toArray()));

  const notes = await fixture.db.list<Note>("local-user", "notes");
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.body, "Only save this once.");
});

test("a note captured without a title is still readable on the device", async (t) => {
  // The agent has no reason to invent a title, and an empty one must not leave a
  // blank card: `promotionTitle` falls back to the body's first line.
  const fixture = await runChat(t, "Call the dentist about Thursday.");
  const notes = await fixture.db.list<Note>("local-user", "notes");
  assert.equal(notes[0]?.title, "");
  assert.match(notes[0]?.body ?? "", /dentist/);
});
