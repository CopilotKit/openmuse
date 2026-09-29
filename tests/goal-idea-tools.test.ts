import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import type { Goal, Idea } from "../packages/domain/src/agent.ts";
import { modelFixture } from "./helpers/model.ts";

type Call = { name: string; arguments: object };

async function fixture(t: TestContext, agentBackend: "model" | "sample" = "model") {
  // Each run's first model request gets the scripted call; the follow-up request ends the turn.
  let next: Call | undefined;
  const { requests } = await modelFixture(t, () => {
    const call = next;
    next = undefined;
    return call;
  });
  const directory = await mkdtemp(join(tmpdir(), "openmuse-goal-tools-"));
  const db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend,
    model: "openai/fixture",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
  const server = await createApp(db, config);
  // Sign-in seeds the fictional mailbox the sample ideas come from.
  await server.workspace.ensureSample("local-user", server.actions);
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const input = (content: string, messageId = `message-${Math.random()}`): RunAgentInput => ({
    threadId: "goal-thread",
    runId: `run-${Math.random()}`,
    messages: [{ id: messageId, role: "user", content }],
    tools: [],
    context: [],
    state: {},
  });
  // Returns the parsed result of the one tool the turn called, as the chat card receives it.
  async function turn(
    call: Call | undefined,
    content: string,
    options: { owner?: string; messageId?: string } = {},
  ) {
    next = call;
    const events: BaseEvent[] = await lastValueFrom(
      new ConversationAgent(config, server.agent, options.owner ?? "local-user")
        .run(input(content, options.messageId))
        .pipe(toArray()),
    );
    const start = events.find((event) => event.type === EventType.TOOL_CALL_START);
    const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
    assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
    if (!start || !result) return { name: undefined, result: undefined };
    return {
      name: (start as BaseEvent & { toolCallName: string }).toolCallName,
      result: JSON.parse((result as BaseEvent & { content: string }).content),
    };
  }
  const goal = async (id: string, owner = "local-user") => db.get<Goal>(owner, "goals", id);
  return { db, turn, goal, requests };
}

test("chat creates a goal, then records reported progress through the Goals tab update path", async (t) => {
  const { turn, goal, requests } = await fixture(t);
  const created = await turn(
    {
      name: "create_goal",
      arguments: { title: "Run a 10K", milestones: ["Run a 5K", "Run 8K without stopping"] },
    },
    "I want to run a 10K this fall",
  );
  assert.equal(created.name, "create_goal");
  const saved = await goal(created.result.id);
  assert.equal(saved?.status, "active");
  assert.deepEqual(
    saved?.milestones.map((item) => [item.title, item.done]),
    [
      ["Run a 5K", false],
      ["Run 8K without stopping", false],
    ],
  );
  assert.match(requests[0].body, /"name":"update_goal"/);
  assert.match(requests[0].body, /reports progress on a goal.*call update_goal/);

  const progress = {
    name: "update_goal",
    arguments: {
      goalId: created.result.id,
      milestones: [{ id: saved?.milestones[0].id, done: true }],
      addMilestones: ["Sign up for a race"],
    },
  };
  const updated = await turn(progress, "I ran my first 5K!", { messageId: "ran-5k" });
  assert.equal(updated.name, "update_goal");
  assert.equal(updated.result.id, created.result.id);
  assert.deepEqual(
    (await goal(created.result.id))?.milestones.map((item) => [item.title, item.done]),
    [
      ["Run a 5K", true],
      ["Run 8K without stopping", false],
      ["Sign up for a race", false],
    ],
  );
  // A replayed tool call for the same message must not add the milestone twice.
  await turn(progress, "I ran my first 5K!", { messageId: "ran-5k" });
  assert.equal((await goal(created.result.id))?.milestones.length, 3);

  const paused = await turn(
    { name: "update_goal", arguments: { goalId: created.result.id, status: "paused" } },
    "Pause my 10K goal",
  );
  assert.equal(paused.result.status, "paused");
  assert.equal((await goal(created.result.id))?.status, "paused");
  assert.equal((await goal(created.result.id))?.milestones[0].done, true);
});

test("update_goal reports another owner's goal and unknown milestones without changing them", async (t) => {
  const { turn, goal } = await fixture(t);
  const created = await turn(
    { name: "create_goal", arguments: { title: "Save for a bike", milestones: ["Save $200"] } },
    "Help me save for a bike",
  );
  const before = await goal(created.result.id);
  const foreign = await turn(
    { name: "update_goal", arguments: { goalId: created.result.id, status: "completed" } },
    "Mark it complete",
    { owner: "someone-else" },
  );
  assert.deepEqual(foreign.result, { error: "Goal not found" });
  const unknown = await turn(
    {
      name: "update_goal",
      arguments: { goalId: created.result.id, milestones: [{ id: "invented", done: true }] },
    },
    "I finished it",
  );
  assert.match(unknown.result.error, /Milestone invented is not part of this goal/);
  const empty = await turn(
    { name: "update_goal", arguments: { goalId: created.result.id } },
    "Update my bike goal",
  );
  assert.match(empty.result.error, /Say which milestones or status to change/);
  assert.deepEqual(await goal(created.result.id), before);
  assert.equal(await goal(created.result.id, "someone-else"), null);
});

test("find_ideas returns open suggestions and leaves starting them to the person", async (t) => {
  const { db, turn } = await fixture(t);
  const found = await turn({ name: "find_ideas", arguments: {} }, "Any ideas for me?");
  assert.equal(found.name, "find_ideas");
  assert.ok(found.result.ideas.length > 0);
  assert.ok(found.result.ideas.length <= 5);
  const ideas = await db.list<Idea>("local-user", "ideas");
  for (const summary of found.result.ideas) {
    assert.deepEqual(Object.keys(summary).sort(), ["id", "kind", "reason", "title"]);
    assert.equal(ideas.find((idea) => idea.id === summary.id)?.status, "new");
  }
  assert.ok(found.result.ideas.some((idea: Idea) => idea.kind === "document"));
  assert.equal((await db.list("local-user", "tasks")).length, 0);
  assert.equal(
    found.result.more,
    ideas.filter((idea) => idea.status === "new").length - found.result.ideas.length,
  );
});

test("sample conversations without a model show ideas through the same find_ideas result", async (t) => {
  const { db, turn } = await fixture(t, "sample");
  const found = await turn(undefined, "What ideas do you have for me?");
  assert.equal(found.name, "find_ideas");
  assert.ok(found.result.ideas.length > 0);
  assert.equal((await db.list("local-user", "tasks")).length, 0);
});
