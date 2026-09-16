import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { EventSchemas, EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { browserFixture } from "./helpers/browser.ts";
import { modelFixture } from "./helpers/model.ts";

const requestedUrl = "https://example.org/article";
const observed = {
  url: "https://example.org/article/final",
  title: "An observed article",
  text: "Actual article contents from the browser.",
  truncated: false,
};
function runInput(): RunAgentInput {
  return {
    threadId: "browser-chat",
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content: `Summarize ${requestedUrl}` }],
    tools: [],
    context: [],
    state: {},
  };
}

async function chatFixture(t: TestContext, failure?: string) {
  const browserCalls: string[] = [];
  const fixture = await browserFixture(t, (path, body) => {
    browserCalls.push(path);
    if (failure) return { status: 502, data: { error: { message: failure } } };
    return {
      data: path.endsWith("/read")
        ? observed
        : {
            id: body.id,
            title: "Opened page",
            url: body.url,
            status: "active",
            updatedAt: new Date().toISOString(),
          },
    };
  });
  const config = { ...fixture.config, agentBackend: "model", model: "openai/fixture" } as const;
  const server = await createApp(fixture.db, config);
  t.after(() => server.agent.stop());
  return {
    ...fixture,
    ...server,
    browserCalls,
    conversation: new ConversationAgent(config, server.agent, "local-user"),
  };
}

test("chat browse_web emits real SDK tool events and returns observed source content immediately", async (t) => {
  const { requests } = await modelFixture(t, (index) =>
    index % 2 === 0 ? { name: "browse_web", arguments: { url: requestedUrl } } : undefined,
  );
  const fixture = await chatFixture(t);
  const events = (await lastValueFrom(fixture.conversation.run(runInput()).pipe(toArray()))).map(
    (event) => EventSchemas.parse(event),
  );
  const toolEvents = events.filter((event) =>
    [
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
    ].some((type) => type === event.type),
  );
  assert.deepEqual(
    toolEvents.map((event) => event.type),
    [
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
    ],
  );
  const start = toolEvents[0];
  assert.equal(start.type, EventType.TOOL_CALL_START);
  if (start.type !== EventType.TOOL_CALL_START) throw new Error("Missing tool start");
  assert.equal(start.toolCallName, "browse_web");
  const args = toolEvents[1];
  if (args.type !== EventType.TOOL_CALL_ARGS) throw new Error("Missing tool arguments");
  assert.deepEqual(JSON.parse(args.delta), { url: requestedUrl });
  const result = toolEvents[3];
  if (result.type !== EventType.TOOL_CALL_RESULT) throw new Error("Missing tool result");
  assert.equal(result.toolCallId, start.toolCallId);
  const page = JSON.parse(result.content);
  assert.deepEqual(page, { sessionId: page.sessionId, ...observed });
  assert.match(page.sessionId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(fixture.browserCalls, ["/sessions", `/sessions/${page.sessionId}/read`]);
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal((await fixture.db.list("local-user", "tasks")).length, 0);
  assert.equal(requests.length, 2);
  assert.ok(requests[0].body.includes('"name":"browse_web"'));
  assert.match(requests[0].body, /For public-page summaries.*browse_web/);
  assert.match(requests[0].body, /untrusted/);
  assert.ok(requests[1].body.includes(observed.text));

  const { token } = await fixture.auth.session();
  const response = await fixture.app.request(`/api/browsers/${page.sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.equal(session.url, observed.url);
  assert.match(session.previewUrl, new RegExp(`/api/browsers/${page.sessionId}/preview\\?`));
  await lastValueFrom(fixture.conversation.clone().run(runInput()).pipe(toArray()));
  assert.equal((await fixture.db.list("local-user", "browsers")).length, 1);
});

test("chat browse_web emits an honest completed error result when navigation fails", async (t) => {
  const { requests } = await modelFixture(t, (index) =>
    index === 0 ? { name: "browse_web", arguments: { url: requestedUrl } } : undefined,
  );
  const fixture = await chatFixture(t, "Public page could not be opened");
  const events = (await lastValueFrom(fixture.conversation.run(runInput()).pipe(toArray()))).map(
    (event) => EventSchemas.parse(event),
  );
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  assert.deepEqual(JSON.parse(result.content), { error: "Public page could not be opened" });
  assert.ok(requests[1].body.includes("Public page could not be opened"));
  assert.deepEqual(fixture.browserCalls, ["/sessions"]);
  assert.equal((await fixture.db.list("local-user", "tasks")).length, 0);
});

test("unsubscribing from chat stops queued browser navigation and further model steps", async (t) => {
  let releaseModel!: () => void;
  const pendingModel = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  let modelRequested!: () => void;
  const modelStarted = new Promise<void>((resolve) => {
    modelRequested = resolve;
  });
  const { requests } = await modelFixture(t, async () => {
    modelRequested();
    await pendingModel;
    return { name: "browse_web", arguments: { url: requestedUrl } };
  });
  const fixture = await chatFixture(t);
  const subscription = fixture.conversation.run(runInput()).subscribe();
  await modelStarted;
  subscription.unsubscribe();
  releaseModel();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(fixture.browserCalls, []);
  assert.equal(requests.length, 1);
});

test("chat searches and reads actual owner mail without creating a task or sending", async (t) => {
  const { requests } = await modelFixture(t, (index) =>
    index === 0
      ? { name: "search_mail", arguments: { query: "aquarium" } }
      : index === 1
        ? { name: "read_mail_thread", arguments: { threadId: "trip-thread" } }
        : undefined,
  );
  const fixture = await chatFixture(t);
  await fixture.workspace.ensureSample("local-user", fixture.actions);
  await fixture.workspace.ensureSample("another-owner", fixture.actions);
  const foreign = (await fixture.workspace.thread("another-owner", "trip-thread"))[0];
  const actionsBefore = await fixture.db.list("local-user", "actions");
  await fixture.db.put("another-owner", "mail", {
    ...foreign,
    body: "PRIVATE FOREIGN AQUARIUM DETAILS",
  });
  const input = runInput();
  input.messages = [
    { id: randomUUID(), role: "user", content: "Check my emails for the school trip" },
  ];
  const events = (await lastValueFrom(fixture.conversation.run(input).pipe(toArray()))).map(
    (event) => EventSchemas.parse(event),
  );
  const results = events.filter((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.equal(results.length, 2);
  const search = JSON.parse(results[0].content);
  const read = JSON.parse(results[1].content);
  assert.equal(search.matches.length, 1);
  assert.equal(search.matches[0].threadId, "trip-thread");
  assert.equal("body" in search.matches[0], false);
  assert.match(read.messages[0].body, /8:15 AM/);
  assert.equal(read.truncated, false);
  assert.ok(requests[2].body.includes("8:15 AM"));
  assert.ok(!JSON.stringify(results).includes("PRIVATE FOREIGN"));
  assert.equal((await fixture.db.list("local-user", "tasks")).length, 0);
  assert.deepEqual(await fixture.db.list("local-user", "actions"), actionsBefore);
});

test("chat mail tools report disconnected mail and refuse another owner's thread", async (t) => {
  let call = { name: "search_mail", arguments: { query: "aquarium" } as object };
  await modelFixture(t, (index) => (index % 2 === 0 ? call : undefined));
  const fixture = await chatFixture(t);
  await fixture.workspace.ensureSample("another-owner", fixture.actions);
  await fixture.db.put("local-user", "settings", { id: "google", enabled: false });
  async function toolError() {
    const events = (await lastValueFrom(fixture.conversation.run(runInput()).pipe(toArray()))).map(
      (event) => EventSchemas.parse(event),
    );
    const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
    assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
    return JSON.parse(result.content).error;
  }
  assert.match(await toolError(), /disconnected/);
  await fixture.db.put("local-user", "settings", { id: "google", enabled: true });
  call = { name: "read_mail_thread", arguments: { threadId: "trip-thread" } };
  assert.match(await toolError(), /not found/);
});
