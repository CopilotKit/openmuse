import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { type BaseEvent, EventSchemas, EventType, type RunAgentInput } from "@ag-ui/core";
import {
  type BuiltInAgentLearnedSkillsOptions,
  CopilotKitIntelligence,
  type GetLearnedSkillsSnapshotRequest,
  IntelligenceAgentRunner,
  LearnedSkillsError,
} from "@copilotkit/runtime/v2";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import { ConversationAgent, createChatAgent } from "../apps/server/src/engine/conversation.ts";
import { browserFixture } from "./helpers/browser.ts";
import { modelFixture } from "./helpers/model.ts";

const skillArchiveBase64 =
  "UEsDBBQAAAAAAAAAIVB5aqleVQEAAFUBAAANAAAAbWFuaWZlc3QuanNvbnsic2NoZW1hVmVyc2lvbiI6MSwicmV2aXNpb24iOiJyMSIsInNraWxscyI6W3sibmFtZSI6InJlZnVuZC1wb2xpY3kiLCJkZXNjcmlwdGlvbiI6IlVzZSB3aGVuIGhhbmRsaW5nIHJlZnVuZHMuIiwiZmlsZXMiOlt7InBhdGgiOiJTS0lMTC5tZCIsInNpemUiOjQ5LCJzaGEyNTYiOiI2ZWQ0MjVhYjc5NzQ5N2MxNTM3YjRmOTg4MTE5OGU4NjU5Y2UyZjUzYjE3OTZhMDFiZmI3NmU0NGZhMDIyZTM5In0seyJwYXRoIjoicmVmZXJlbmNlLnR4dCIsInNpemUiOjM1LCJzaGEyNTYiOiI0ZWYxNGYwOTk4OTQ4YmQ1ZmRiZDliZWMyMzYyMmM5YjJiYmI3M2ZkZDQzNGFmYzg0ZjQxOWRiYjc1YzBiZDJjIn1dfV19UEsDBBQAAAAAAAAAIVAGIkDTMQAAADEAAAAWAAAAcmVmdW5kLXBvbGljeS9TS0lMTC5tZCMgUmVmdW5kIHBvbGljeQpVc2UgdGhlIHB1Ymxpc2hlZCByZWZ1bmQgcG9saWN5LgpQSwMEFAAAAAAAAAAhUNO6XG8jAAAAIwAAABsAAAByZWZ1bmQtcG9saWN5L3JlZmVyZW5jZS50eHRSZWZ1bmRzIGFyZSBhdmFpbGFibGUgZm9yIDMwIGRheXMuClBLAQIUAxQAAAAAAAAAIVB5aqleVQEAAFUBAAANAAAAAAAAAAAAAACAAQAAAABtYW5pZmVzdC5qc29uUEsBAhQDFAAAAAAAAAAhUAYiQNMxAAAAMQAAABYAAAAAAAAAAAAAAIABgAEAAHJlZnVuZC1wb2xpY3kvU0tJTEwubWRQSwECFAMUAAAAAAAAACFQ07pcbyMAAAAjAAAAGwAAAAAAAAAAAAAAgAHlAQAAcmVmdW5kLXBvbGljeS9yZWZlcmVuY2UudHh0UEsFBgAAAAADAAMAyAAAAEECAAAAAA==";
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

async function chatFixture(
  t: TestContext,
  failure?: string,
  learnedSkills?: BuiltInAgentLearnedSkillsOptions,
) {
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
    conversation: new ConversationAgent(
      config,
      server.agent,
      "local-user",
      createChatAgent(learnedSkills),
    ),
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

test("chat loads a published Intelligence skill before model work", async (t) => {
  const snapshotCalls: GetLearnedSkillsSnapshotRequest[] = [];
  const intelligence = new CopilotKitIntelligence({ apiKey: "test-project-key-never-sent" });
  intelligence.getLearnedSkillsSnapshot = async (request) => {
    snapshotCalls.push(request);
    return {
      status: "snapshot",
      bytes: Uint8Array.from(Buffer.from(skillArchiveBase64, "base64")),
      revision: "r1",
      etag: '"139773b71315c562db80ead7ec4318982cab1ddc6671d53c776a2eab55d9a775"',
      contentType: "application/zip",
    };
  };
  const { requests } = await modelFixture(t, (index) =>
    index % 2 === 0
      ? { name: "copilotkit_load_skill", arguments: { skill_name: "refund-policy" } }
      : undefined,
  );
  const learnedSkills = {
    client: intelligence,
    containerId: "openmuse-assistant",
    freshnessWindowMs: 0,
  };
  const fixture = await chatFixture(t, undefined, learnedSkills);
  const input = runInput();
  input.messages = [
    { id: randomUUID(), role: "user", content: "Can I get a refund for my ticket?" },
  ];

  const events = (await lastValueFrom(fixture.conversation.run(input).pipe(toArray()))).map(
    (event) => EventSchemas.parse(event),
  );

  assert.equal(snapshotCalls.length, 1);
  assert.equal(snapshotCalls[0].containerId, "openmuse-assistant");
  assert.ok(requests[0].body.includes("refund-policy"));
  assert.ok(requests[0].body.includes("copilotkit_load_skill"));
  assert.ok(requests[1].body.includes("Use the published refund policy"));
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  assert.match(result.content, /Use the published refund policy/);

  await lastValueFrom(fixture.conversation.clone().run(input).pipe(toArray()));
  assert.equal(snapshotCalls.length, 2);
});

test("chat runtime route wires published Intelligence skills into the model agent", async (t) => {
  const snapshotCalls: GetLearnedSkillsSnapshotRequest[] = [];
  t.mock.method(
    CopilotKitIntelligence.prototype,
    "getLearnedSkillsSnapshot",
    async (request: GetLearnedSkillsSnapshotRequest) => {
      snapshotCalls.push(request);
      return {
        status: "snapshot",
        bytes: Uint8Array.from(Buffer.from(skillArchiveBase64, "base64")),
        revision: "r1",
        etag: '"139773b71315c562db80ead7ec4318982cab1ddc6671d53c776a2eab55d9a775"',
        contentType: "application/zip",
      };
    },
  );
  t.mock.method(
    CopilotKitIntelligence.prototype,
    "getOrCreateThread",
    async (input: Parameters<CopilotKitIntelligence["getOrCreateThread"]>[0]) => ({
      thread: { id: input.threadId, name: null },
      created: false,
    }),
  );
  t.mock.method(
    CopilotKitIntelligence.prototype,
    "ɵacquireThreadLock",
    async (input: Parameters<CopilotKitIntelligence["ɵacquireThreadLock"]>[0]) => ({
      threadId: input.threadId,
      runId: input.runId,
      joinToken: "test-join-token",
    }),
  );
  t.mock.method(CopilotKitIntelligence.prototype, "getThreadMessages", async () => ({
    messages: [],
  }));
  t.mock.method(CopilotKitIntelligence.prototype, "ɵrenewThreadLock", async () => ({
    ttlSeconds: 60,
  }));
  t.mock.method(CopilotKitIntelligence.prototype, "ɵcleanupThreadLock", async () => {});
  t.mock.method(
    IntelligenceAgentRunner.prototype,
    "runWithStartupBoundary",
    (request: Parameters<IntelligenceAgentRunner["runWithStartupBoundary"]>[0]) => ({
      events: request.agent.run(request.input),
      startup: Promise.resolve(),
    }),
  );
  const { requests } = await modelFixture(t, (index) =>
    index % 2 === 0
      ? { name: "copilotkit_load_skill", arguments: { skill_name: "refund-policy" } }
      : undefined,
  );
  const fixture = await browserFixture(t, (_path, body) => ({
    data: {
      id: body.id,
      title: "Opened page",
      url: body.url,
      status: "active",
      updatedAt: new Date().toISOString(),
    },
  }));
  const config = {
    ...fixture.config,
    mode: "live",
    agentBackend: "model",
    model: "openai/fixture",
    accessKey: "test-access-key",
    intelligenceApiKey: "test-project-key-never-sent",
    intelligenceLearningContainerId: "openmuse-assistant",
  } as const;
  const server = await createApp(fixture.db, config);
  t.after(() => server.agent.stop());
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey: "test-access-key" }),
  });
  assert.equal(session.status, 200, await session.clone().text());
  const { token } = await session.json();
  const routeRunId = randomUUID();

  const response = await server.app.request("/api/copilotkit/agent/default/run", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: "runtime-skill-chat",
      runId: routeRunId,
      messages: [{ id: randomUUID(), role: "user", content: "Can I get a refund for my ticket?" }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });

  assert.equal(response.status, 200, await response.clone().text());
  const run = await response.json();
  assert.equal(run.threadId, "runtime-skill-chat");
  assert.equal(run.runId, routeRunId);
  assert.equal(run.joinToken, "test-join-token");
  for (let i = 0; requests.length < 2 && i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(requests.length, 2);
  assert.equal(snapshotCalls.length, 1);
  assert.equal(snapshotCalls[0].containerId, "openmuse-assistant");
  assert.ok(requests[0].body.includes("refund-policy"));
  assert.ok(requests[0].body.includes("copilotkit_load_skill"));
  assert.ok(requests[1].body.includes("Use the published refund policy"));
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

function skillSnapshot() {
  return {
    status: "snapshot" as const,
    bytes: Uint8Array.from(Buffer.from(skillArchiveBase64, "base64")),
    revision: "r1",
    etag: '"139773b71315c562db80ead7ec4318982cab1ddc6671d53c776a2eab55d9a775"',
    contentType: "application/zip",
  };
}

async function sharedChatTurns(
  t: TestContext,
  freshnessWindowMs: number,
  snapshot: (call: number) => Promise<ReturnType<typeof skillSnapshot>>,
) {
  let snapshotCalls = 0;
  const intelligence = new CopilotKitIntelligence({ apiKey: "test-project-key-never-sent" });
  intelligence.getLearnedSkillsSnapshot = async () => snapshot(snapshotCalls++);
  const model = await modelFixture(t, (index) =>
    index % 2 === 0
      ? { name: "copilotkit_load_skill", arguments: { skill_name: "refund-policy" } }
      : undefined,
  );
  const fixture = await chatFixture(t);
  // makeRuntime builds one chat agent and a fresh ConversationAgent per request.
  const chat = createChatAgent({
    client: intelligence,
    containerId: "openmuse-assistant",
    freshnessWindowMs,
  });
  const turn = async () => {
    const input = runInput();
    input.messages = [{ id: randomUUID(), role: "user", content: "Can I get a refund?" }];
    const conversation = new ConversationAgent(
      { ...fixture.config, agentBackend: "model", model: "openai/fixture" },
      fixture.agent,
      "local-user",
      chat,
    );
    return lastValueFrom(conversation.run(input).pipe(toArray()));
  };
  return { turn, requests: model.requests, snapshotCalls: () => snapshotCalls };
}

const loadedSkill = (events: BaseEvent[]) =>
  events
    .map((event) => EventSchemas.parse(event))
    .some(
      (event) =>
        event.type === EventType.TOOL_CALL_RESULT &&
        /Use the published refund policy/.test(event.content),
    );

test("chat reuses the learned-skill snapshot across turns within the refresh window", async (t) => {
  const chat = await sharedChatTurns(t, 60_000, async () => skillSnapshot());

  assert.ok(loadedSkill(await chat.turn()));
  assert.ok(loadedSkill(await chat.turn()));
  assert.equal(chat.snapshotCalls(), 1);
  assert.equal(chat.requests.length, 4);
});

test("chat keeps using the cached skill when a refresh fails transiently", async (t) => {
  const chat = await sharedChatTurns(t, 0, async (call) => {
    if (call > 0) throw new LearnedSkillsError("NETWORK_ERROR", true);
    return skillSnapshot();
  });

  assert.ok(loadedSkill(await chat.turn()));
  assert.ok(loadedSkill(await chat.turn()));
  assert.equal(chat.snapshotCalls(), 2);
});

test("an explicit learned-skill delivery denial still blocks the chat turn", async (t) => {
  const chat = await sharedChatTurns(t, 0, async (call) => {
    if (call > 0) throw new LearnedSkillsError("DELIVERY_DISABLED", false);
    return skillSnapshot();
  });

  assert.ok(loadedSkill(await chat.turn()));
  const requestsBefore = chat.requests.length;
  await assert.rejects(chat.turn(), { code: "DELIVERY_DISABLED" });
  assert.equal(chat.requests.length, requestsBefore);
});
