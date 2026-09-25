import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type TestContext, test } from "node:test";
import { EventSchemas, EventType } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { SearchService, searchInstructions } from "../apps/server/src/search.ts";
import { browserFixture } from "./helpers/browser.ts";
import { modelFixture } from "./helpers/model.ts";
import { searchFixture, searchSource } from "./helpers/search.ts";

const input = { objective: "Find useful public research", search_queries: ["public research"] };
async function serviceFixture(t: TestContext) {
  const db = await createStore();
  t.after(() => db.close());
  return { db, search: new SearchService(db) };
}

test("search preserves citations, deduplicates payloads and sends project identity without auth", async (t) => {
  const { requests } = await searchFixture(t);
  const { db, search } = await serviceFixture(t);
  const result = await search.search("owner", "chat:one", input);
  assert.deepEqual(result, {
    provider: "parallel",
    results: [searchSource],
    warnings: [],
    truncated: false,
  });
  await new SearchService(db).search("owner", "chat:one", input);
  await search.search("owner", "task:two", input);
  const calls = requests.filter(({ rpc }) => rpc.method === "tools/call");
  const args = calls.map(
    ({ rpc }) => rpc.params?.arguments as typeof input & { session_id: string },
  );
  assert.deepEqual(args[0].search_queries, input.search_queries);
  assert.equal(args[0].objective, input.objective);
  assert.match(args[0].session_id, /^[a-f0-9-]{36}$/);
  assert.equal(args[0].session_id, args[1].session_id);
  assert.notEqual(args[0].session_id, args[2].session_id);
  assert.ok(requests.some(({ rpc }) => rpc.method === "tools/list"));
  for (const { headers } of requests) {
    assert.equal(headers["user-agent"], "openmuse/0.1.0");
    assert.equal(headers.authorization, undefined);
    assert.equal(headers["x-api-key"], undefined);
  }
});

test("valid empty search succeeds and JSON text is supported without structuredContent", async (t) => {
  await searchFixture(t, (rpc) =>
    rpc.method === "tools/call"
      ? {
          result: {
            content: [
              {
                type: "text",
                text: '{"results":[],"warnings":[{"type":"empty","message":"No matching sources","detail":null}]}',
              },
            ],
          },
        }
      : {},
  );
  const { search } = await serviceFixture(t);
  assert.deepEqual(await search.search("owner", "chat:one", input), {
    provider: "parallel",
    results: [],
    warnings: ["empty: No matching sources"],
    truncated: false,
  });
});

for (const [name, supplied, message] of [
  ["HTTP rate limit", { status: 429 }, /Parallel search failed/],
  ["RPC failure", { error: { code: -32000, message: "Quota exceeded" } }, /Quota exceeded/],
  [
    "tool failure",
    { result: { isError: true, content: [{ type: "text", text: "Search unavailable" }] } },
    /Search unavailable/,
  ],
  [
    "malformed payload",
    { result: { content: [], structuredContent: { results: "not an array" } } },
    /invalid search result/,
  ],
] as const) {
  test(`search reports ${name} rather than empty success`, async (t) => {
    await searchFixture(t, (rpc) => (rpc.method === "tools/call" ? supplied : {}));
    const { search } = await serviceFixture(t);
    await assert.rejects(search.search("owner", "chat:one", input), message);
  });
}

test("search bounds model excerpts and network bytes while retaining citations", async (t) => {
  let huge = false;
  await searchFixture(t, (rpc) =>
    rpc.method === "tools/call"
      ? {
          result: {
            content: [],
            structuredContent: {
              results: [{ ...searchSource, excerpts: ["x".repeat(huge ? 1100000 : 31000)] }],
            },
          },
        }
      : {},
  );
  const { search } = await serviceFixture(t);
  const result = await search.search("owner", "chat:one", input);
  assert.equal(result.results[0].url, searchSource.url);
  assert.equal(result.results[0].excerpts[0].length, 30000);
  assert.equal(result.truncated, true);
  huge = true;
  await assert.rejects(search.search("owner", "chat:one", input), /exceeded 1 MiB/);
});

test("search rejects invalid input before contacting Parallel", async (t) => {
  const { requests } = await searchFixture(t);
  const { search } = await serviceFixture(t);
  await assert.rejects(search.search("owner", "chat:one", { ...input, search_queries: [" "] }));
  await assert.rejects(search.search("owner", "chat:one", input, AbortSignal.abort()));
  assert.equal(requests.length, 0);
});

test("search refuses redirects before sending queries to another destination", async (t) => {
  let destination = "";
  const fixture = await searchFixture(t, (rpc) =>
    rpc.method === "tools/call" ? { status: 307, headers: { location: destination } } : {},
  );
  destination = `${fixture.url}/redirect-target`;
  const { search } = await serviceFixture(t);
  await assert.rejects(search.search("owner", "chat:one", input), /Parallel search failed/);
  assert.ok(!fixture.paths.includes("/redirect-target"));
});

test("search follows tool discovery pagination before executing", async (t) => {
  const { requests } = await searchFixture(t, (rpc) =>
    rpc.method === "tools/list"
      ? {
          result: rpc.params?.cursor
            ? { tools: [{ name: "web_search", inputSchema: { type: "object" } }] }
            : { tools: [], nextCursor: "second-page" },
        }
      : {},
  );
  const { search } = await serviceFixture(t);
  assert.equal((await search.search("owner", "chat:one", input)).results[0].url, searchSource.url);
  assert.deepEqual(
    requests.filter(({ rpc }) => rpc.method === "tools/list").map(({ rpc }) => rpc.params?.cursor),
    [undefined, "second-page"],
  );
});

test("search aborts in-flight execution and distinguishes its deadline", async (t) => {
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  let waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await searchFixture(t, async (rpc) => {
    if (rpc.method === "tools/call") {
      started();
      await waiting;
    }
    return {};
  });
  const { search } = await serviceFixture(t);
  const controller = new AbortController();
  const pending = search.search("owner", "chat:one", input, controller.signal);
  await startedPromise;
  controller.abort(new Error("User stopped search"));
  await assert.rejects(pending, /User stopped search/);
  release();
  waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", () => originalTimeout(50));
  const expired = search.search("owner", "chat:one", input);
  await assert.rejects(expired, /timed out after 45 seconds/);
  release();
});

test("enabled native chat and delegated tasks use Parallel and deduplicate source evidence", async (t) => {
  let includeDuplicates = false;
  const secondSource = { ...searchSource, url: "https://example.org/related" };
  const { requests: searchRequests } = await searchFixture(t, (rpc) =>
    includeDuplicates && rpc.method === "tools/call"
      ? {
          result: {
            content: [],
            structuredContent: { results: [searchSource, secondSource, secondSource] },
          },
        }
      : {},
  );
  const calls: ({ name: string; arguments: object } | undefined)[] = [
    { name: "search_web", arguments: input },
    undefined,
  ];
  const { requests } = await modelFixture(t, (index) => calls[index]);
  const fixture = await browserFixture(t, () => {
    throw new Error("Search must not require the browser worker");
  });
  const config = {
    ...fixture.config,
    agentBackend: "model",
    model: "openai/fixture",
    webSearchEnabled: true,
  } as const;
  const app = await createApp(fixture.db, config);
  t.after(() => app.agent.stop());
  const events = await lastValueFrom(
    new ConversationAgent(config, app.agent, "local-user")
      .run({
        threadId: "search-chat",
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "Find useful public research" }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  const event = events
    .map((event) => EventSchemas.parse(event))
    .find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(event && event.type === EventType.TOOL_CALL_RESULT);
  assert.deepEqual(JSON.parse(event.content).results, [searchSource]);
  assert.ok(requests[0].body.includes('"name":"search_web"'));
  assert.ok(requests[1].body.includes(searchSource.url));
  includeDuplicates = true;
  requests.length = 0;
  calls.splice(0, calls.length, { name: "search_web", arguments: input });
  calls.push({
    name: "search_web",
    arguments: { ...input, search_queries: ["related public research"] },
  });
  calls.push({
    name: "finish_task",
    arguments: { summary: "Research found" },
  });
  const task = await app.agent.createTask("local-user", {
    prompt: "Find useful public research",
    kind: "agent",
  });
  const existingSource = {
    id: "existing-evidence",
    kind: "web" as const,
    title: searchSource.title,
    url: searchSource.url,
    excerpt: searchSource.excerpts[0],
  };
  await fixture.db.put("local-user", "tasks", { ...task, evidence: [existingSource] });
  await app.agent.worker.tick();
  const saved = await app.agent.getTask("local-user", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
  assert.ok(
    saved.evidence.some(
      (source) =>
        source.kind === "web" &&
        source.url === searchSource.url &&
        source.excerpt === searchSource.excerpts[0],
    ),
  );
  const webEvidence = saved.evidence.filter((source) => source.kind === "web");
  assert.equal(webEvidence.length, 2);
  assert.equal(new Set(webEvidence.map((source) => source.url)).size, 2);
  assert.deepEqual(
    webEvidence.find((source) => source.url === searchSource.url),
    existingSource,
  );
  assert.ok(webEvidence.some((source) => source.url === secondSource.url));
  assert.equal(searchRequests.filter(({ rpc }) => rpc.method === "tools/call").length, 3);
  assert.ok(requests[0].body.includes('"name":"search_web"'));
});

for (const enabled of [undefined, false]) {
  test(`disabled search is unavailable in native chat and delegated tasks (${enabled})`, async (t) => {
    const { requests: searchRequests } = await searchFixture(t);
    const { requests } = await modelFixture(t, (index) =>
      index === 0 || index === 2 ? { name: "search_web", arguments: input } : undefined,
    );
    const fixture = await browserFixture(t, () => {
      throw new Error("Unexpected browser request");
    });
    const config = {
      ...fixture.config,
      agentBackend: "model",
      model: "openai/fixture",
      webSearchEnabled: enabled,
    } as const;
    const app = await createApp(fixture.db, config);
    t.after(() => app.agent.stop());
    await lastValueFrom(
      new ConversationAgent(config, app.agent, "local-user")
        .run({
          threadId: "disabled-search-chat",
          runId: randomUUID(),
          messages: [{ id: randomUUID(), role: "user", content: "Find public research" }],
          tools: [],
          context: [],
          state: {},
        })
        .pipe(toArray()),
    );
    const chatRequestCount = requests.length;
    assert.ok(chatRequestCount > 0);
    const task = await app.agent.createTask("local-user", {
      prompt: "Find public research",
      kind: "agent",
    });
    await app.agent.worker.tick();
    assert.ok(requests.length > chatRequestCount);
    for (const { body } of requests) {
      const request = JSON.parse(body);
      assert.ok(!request.tools.some((tool: { name: string }) => tool.name === "search_web"));
      assert.ok(!body.includes(searchInstructions.trim()));
    }
    assert.equal(searchRequests.length, 0);
    const saved = await app.agent.getTask("local-user", task.id);
    assert.equal(saved.evidence.filter((source) => source.kind === "web").length, 0);
    assert.deepEqual(await fixture.db.list("local-user", "search-sessions"), []);
  });
}
