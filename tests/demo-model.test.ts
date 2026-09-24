import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { AbstractAgent } from "@ag-ui/client";
import type { RunAgentInput } from "@ag-ui/core";
import type { ChatCompletionRequest, ChatMessage } from "@copilotkit/aimock";
import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { createDemoModel, demoModel, demoResponse } from "../apps/server/src/demo/model.ts";
import { tanstackAgent } from "../apps/server/src/engine/tanstack-agent.ts";

const browseTool = {
  type: "function" as const,
  function: { name: "browse_web", parameters: {} },
};
const request = (messages: ChatMessage[]): ChatCompletionRequest => ({
  model: "openmuse-browser-demo",
  messages,
  tools: [browseTool],
});

const mailRequest = (messages: ChatMessage[]): ChatCompletionRequest => ({
  ...request(messages),
  tools: ["search_mail", "read_mail_thread", "browse_web"].map((name) => ({
    type: "function",
    function: { name, parameters: {} },
  })),
});

test("aquarium research distinguishes exhibit entries from navigation and only quotes observed descriptions", () => {
  const response = demoResponse(
    request([
      { role: "user", content: "Research Monterey Bay Aquarium" },
      {
        role: "tool",
        tool_call_id: "call_openmuse_demo_browse_aquarium",
        content: JSON.stringify({
          sessionId: "aquarium",
          url: "https://www.montereybayaquarium.org/visit/exhibits",
          title: "Exhibits",
          text: "Kelp forest recovery\nPlayful sea otters.\nEXHIBIT\nKelp Forest\nA view of sunlit kelp.\nExplore exhibit\nEXHIBIT\nOpen Sea\nWatch tuna and turtles.\nExplore exhibit",
          truncated: false,
        }),
      },
    ]),
  );
  assert.ok("content" in response);
  assert.match(response.content ?? "", /Kelp Forest: A view of sunlit kelp/);
  assert.match(response.content ?? "", /Open Sea: Watch tuna and turtles/);
  assert.doesNotMatch(response.content ?? "", /recovery|Playful|Three|Sea Otters:/);
});

test("the email demo reads the thread returned by search and quotes its actual details", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "Check my emails for the school trip" },
  ];
  const search = demoResponse(mailRequest(messages));
  assert.ok("toolCalls" in search && search.toolCalls);
  assert.equal(search.toolCalls[0].name, "search_mail");
  messages.push({
    role: "tool",
    tool_call_id: search.toolCalls[0].id,
    content: JSON.stringify({
      matches: [{ threadId: "dynamic-thread", subject: "New trip details" }],
    }),
  });
  const read = demoResponse(mailRequest(messages));
  assert.ok("toolCalls" in read && read.toolCalls);
  assert.equal(read.toolCalls[0].name, "read_mail_thread");
  assert.deepEqual(JSON.parse(read.toolCalls[0].arguments), { threadId: "dynamic-thread" });
  messages.push({
    role: "tool",
    tool_call_id: read.toolCalls[0].id,
    content: JSON.stringify({
      messages: [
        {
          sender: "School Office",
          subject: "New trip details",
          body: "The bus now leaves at 9:45 AM. Bring the signed form and your lunch.",
        },
      ],
    }),
  });
  const reply = demoResponse(mailRequest(messages));
  assert.ok("content" in reply);
  assert.match(reply.content ?? "", /9:45 AM/);
  assert.doesNotMatch(reply.content ?? "", /8:15 AM/);
  messages.push({ role: "user", content: "Check my emails for the school trip again" });
  const next = demoResponse(mailRequest(messages));
  assert.ok("toolCalls" in next && next.toolCalls);
  assert.equal(next.toolCalls[0].name, "search_mail");
});

test("the email demo handles no matches and disconnected mail without inventing details", () => {
  for (const result of [{ matches: [] }, { error: "Google is disconnected" }]) {
    const response = demoResponse(
      mailRequest([
        { role: "user", content: "Check my emails for the school trip" },
        {
          role: "tool",
          tool_call_id: "call_openmuse_demo_mail_search_failure",
          content: JSON.stringify(result),
        },
      ]),
    );
    assert.ok("content" in response);
    assert.match(response.content ?? "", /didn’t find|couldn’t check/);
    assert.ok(!("toolCalls" in response));
  }
});

test("demo only summarizes browser evidence belonging to the current user turn", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "Find cool stuff on Hacker News" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "first", type: "function", function: { name: "browse_web", arguments: "{}" } },
      ],
    },
    {
      role: "tool",
      tool_call_id: "first",
      content: JSON.stringify({
        sessionId: "old",
        url: "https://news.ycombinator.com",
        title: "Hacker News",
        text: "1. Old page headline",
        truncated: false,
      }),
    },
    { role: "user", content: "Now summarize https://copilotkit.ai" },
  ];
  const reply = demoResponse(request(history));
  assert.ok("toolCalls" in reply && reply.toolCalls);
  assert.equal(reply.toolCalls[0].name, "browse_web");
  assert.deepEqual(JSON.parse(reply.toolCalls[0].arguments), { url: "https://copilotkit.ai" });
});

test("demo reports missing or failed browser evidence without inventing a summary", () => {
  const reply = demoResponse(
    request([
      { role: "user", content: "Summarize copilotkit.ai" },
      {
        role: "tool",
        tool_call_id: "call_openmuse_demo_browse_failure",
        content: '{"error":"Worker unavailable"}',
      },
    ]),
  );
  assert.ok("content" in reply);
  assert.match(reply.content ?? "", /could not read/);
  assert.ok(!("toolCalls" in reply));
});

test("AI Mock drives the real TanStack BuiltInAgent through two browser tool rounds", async () => {
  const previousBase = process.env.OPENAI_BASE_URL;
  const previousKey = process.env.OPENAI_API_KEY;
  const mock = createDemoModel({ latency: 0 });
  await mock.start();
  process.env.OPENAI_BASE_URL = `${mock.url}/v1`;
  process.env.OPENAI_API_KEY = "local-demo-test";
  const visited: string[] = [];
  const options = {
    model: demoModel,
    maxSteps: 3,
    prompt: "",
    tools: [
      defineTool({
        name: "browse_web",
        description: "Read a page (unit-test tool implementation).",
        parameters: z.object({ url: z.url() }),
        execute: async ({ url }) => {
          visited.push(url);
          return {
            sessionId: randomUUID(),
            url,
            title: url.includes("ycombinator") ? "Hacker News" : "CopilotKit",
            text: url.includes("ycombinator")
              ? "Hacker News\n1.\t\n\tTest headline returned only by this tool\n2. Another observed headline\n3.\nA third observed headline"
              : "CopilotKit connects your application to agents using the observed test tool response.",
            truncated: false,
          };
        },
      }),
    ],
  };
  // ConversationAgent also creates a TanStack BuiltInAgent per turn and returns its raw run observable.
  class DemoAgent extends AbstractAgent {
    run(input: RunAgentInput) {
      return tanstackAgent(options).run(input);
    }
  }
  const agent = new DemoAgent();
  const errors: string[] = [];
  agent.subscribe({
    onRunErrorEvent: ({ event }) => {
      errors.push(event.message);
    },
  });
  try {
    agent.addMessage({ id: randomUUID(), role: "user", content: "Find cool stuff on Hacker News" });
    const first = await agent.runAgent();
    assert.deepEqual(errors, []);
    assert.match(
      first.newMessages.map((message) => ("content" in message ? message.content : "")).join(" "),
      /Test headline returned only by this tool/,
    );
    const firstSummary = first.newMessages.findLast(
      (message) => message.role === "assistant" && message.content,
    );
    assert.ok(
      firstSummary && "content" in firstSummary && typeof firstSummary.content === "string",
    );
    // Text before and after the tool call stays in separate messages, as in the classic AI SDK mode.
    assert.deepEqual(
      first.newMessages
        .filter((message) => message.role === "assistant" && message.content)
        .map((message) => message.id === firstSummary.id || message.content),
      ["I’ll open Hacker News and read the front page.", true],
    );
    assert.equal(firstSummary.content.match(/• /g)?.length, 3);
    assert.ok(!firstSummary.content.includes("Source: ["));
    agent.addMessage({
      id: randomUUID(),
      role: "user",
      content: "Summarize https://copilotkit.ai",
    });
    const second = await agent.runAgent();
    assert.deepEqual(errors, []);
    assert.match(
      second.newMessages.map((message) => ("content" in message ? message.content : "")).join(" "),
      /observed test tool response/,
    );
    assert.deepEqual(visited, ["https://news.ycombinator.com", "https://copilotkit.ai"]);
    assert.equal(mock.getRequests().length, 4);
  } finally {
    if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    await mock.stop();
  }
});
