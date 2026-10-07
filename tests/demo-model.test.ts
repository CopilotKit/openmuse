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

function calls(response: ReturnType<typeof demoResponse>) {
  return "toolCalls" in response ? response.toolCalls : undefined;
}

function replyText(response: ReturnType<typeof demoResponse>) {
  return "content" in response ? response.content : undefined;
}

const jevRequest = (messages: ChatMessage[]): ChatCompletionRequest => ({
  ...request(messages),
  tools: ["search_mail", "read_mail_thread", "browse_web", "present_choices", "delegate_task"].map(
    (name) => ({
      type: "function",
      function: { name, parameters: {} },
    }),
  ),
});

test("school-trip demo reads mail before presenting clarification choices", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "Help me get ready for the aquarium trip" },
  ];
  const search = demoResponse(jevRequest(messages));
  assert.equal(calls(search)?.[0]?.name, "search_mail");
  messages.push({
    role: "tool",
    tool_call_id: calls(search)?.[0]?.id,
    content: JSON.stringify({
      matches: [
        { threadId: "trip-thread", sender: "Lincoln Middle School", subject: "Trip reminder" },
      ],
    }),
  });
  const read = demoResponse(jevRequest(messages));
  assert.equal(calls(read)?.[0]?.name, "read_mail_thread");
  messages.push({
    role: "tool",
    tool_call_id: calls(read)?.[0]?.id,
    content: JSON.stringify({
      messages: [
        {
          id: "mail-fieldtrip",
          sender: "Lincoln Middle School",
          subject: "Trip reminder",
          body: "The class is heading to the aquarium. Please complete the permission slip. Bring lunch and a water bottle.",
        },
      ],
    }),
  });
  const panel = demoResponse(jevRequest(messages));
  assert.equal(calls(panel)?.[0]?.name, "present_choices");
  const args = JSON.parse(calls(panel)?.[0]?.arguments ?? "{}");
  assert.deepEqual(
    args.options.map((option: { label: string }) => option.label),
    ["Complete permission slip", "Review trip details", "Explore exhibits"],
  );
});

test("school-trip search ignores newer unrelated aquarium mail and rejects wrong read", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "Help me get ready for the aquarium trip" },
  ];
  const search = demoResponse(jevRequest(messages));
  messages.push({
    role: "tool",
    tool_call_id: calls(search)?.[0]?.id,
    content: JSON.stringify({
      matches: [
        { threadId: "other", sender: "Local aquarium", subject: "Your aquarium visit" },
        {
          threadId: "trip-thread",
          sender: "Lincoln Middle School",
          subject: "Permission slips due Friday",
        },
      ],
    }),
  });
  const read = demoResponse(jevRequest(messages));
  assert.deepEqual(JSON.parse(calls(read)?.[0]?.arguments ?? "{}"), { threadId: "trip-thread" });
  messages.push({
    role: "tool",
    tool_call_id: calls(read)?.[0]?.id,
    content: JSON.stringify({
      messages: [
        {
          sender: "Local aquarium",
          subject: "Tickets",
          body: "Your aquarium visit is confirmed. Bring lunch.",
        },
      ],
    }),
  });
  const answer = demoResponse(jevRequest(messages));
  assert.ok(!calls(answer)?.length);
  assert.match(replyText(answer) ?? "", /school.trip email|school reminder/i);
});

test("both non-exhibit clarification choices continue from trusted school mail", () => {
  const prior: ChatMessage[] = [
    { role: "user", content: "Help me get ready for the aquarium trip" },
    {
      role: "tool",
      tool_call_id: "call_openmuse_demo_mail_read_prior",
      content: JSON.stringify({
        messages: [
          {
            id: "mail-fieldtrip",
            sender: "Lincoln Middle School",
            subject: "Permission slips due Friday",
            body: "Our class is heading to the aquarium this Friday. Please complete the permission slip. We leave school at 8:15 AM and return at 4:30 PM. Pack lunch and a water bottle.",
          },
        ],
      }),
    },
  ];
  const review = demoResponse(
    jevRequest([
      ...prior,
      {
        role: "user",
        content:
          "I choose “Review trip details” from clarification choices. Continue with that preference.",
      },
    ]),
  );
  assert.match(replyText(review) ?? "", /8:15 AM.*4:30 PM/s);
  assert.ok(!calls(review)?.length);
  const complete = demoResponse(
    jevRequest([
      ...prior,
      {
        role: "user",
        content:
          "I choose “Complete permission slip” from clarification choices. Continue with that preference.",
      },
    ]),
  );
  assert.equal(calls(complete)?.[0]?.name, "delegate_task");
  const args = JSON.parse(calls(complete)?.[0]?.arguments ?? "{}");
  assert.equal(args.kind, "document");
  assert.equal(args.input.messageId, "mail-fieldtrip");
});

test("school-trip demo stops after failed mail or choice result", () => {
  const failedMail = demoResponse(
    jevRequest([
      { role: "user", content: "Help me get ready for the aquarium trip" },
      {
        role: "tool",
        tool_call_id: "call_openmuse_demo_mail_read_failure",
        content: JSON.stringify({ error: "No mail" }),
      },
    ]),
  );
  assert.ok(!calls(failedMail)?.length);
  assert.match(replyText(failedMail) ?? "", /couldn.t verify/i);
  const failedChoice = demoResponse(
    jevRequest([
      { role: "user", content: "Help me get ready for the aquarium trip" },
      {
        role: "tool",
        tool_call_id: "call_openmuse_demo_jev_failure",
        content: JSON.stringify({ panel: null, error: "Jev unavailable" }),
      },
    ]),
  );
  assert.ok(!calls(failedChoice)?.length);
  assert.match(replyText(failedChoice) ?? "", /couldn.t prepare|unavailable/i);
});

test("Explore exhibits browses every cited aquarium page before showing comparison", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "Explore exhibits" }];
  const urls: string[] = [];
  for (let index = 0; index < 3; index++) {
    const next = demoResponse(jevRequest(messages));
    assert.equal(calls(next)?.[0]?.name, "browse_web");
    const { url } = JSON.parse(calls(next)?.[0]?.arguments ?? "{}");
    urls.push(url);
    messages.push({
      role: "tool",
      tool_call_id: calls(next)?.[0]?.id,
      content: JSON.stringify({
        sessionId: `page-${index}`,
        url,
        title: "Aquarium exhibit",
        text: [
          "Kelp Forest at 28 feet features sardines and leopard sharks.",
          "Open Sea has a 90-foot window with turtles, sardines, and tuna.",
          "Rocky Shore has a touch pool for bat rays.",
        ][index],
        truncated: false,
      }),
    });
  }
  assert.deepEqual(urls, [
    "https://www.montereybayaquarium.org/visit/exhibits/kelp-forest/",
    "https://www.montereybayaquarium.org/visit/exhibits/open-sea/",
    "https://www.montereybayaquarium.org/visit/exhibits/rocky-shore",
  ]);
  const comparison = demoResponse(jevRequest(messages));
  assert.equal(calls(comparison)?.[0]?.name, "present_choices");
  const args = JSON.parse(calls(comparison)?.[0]?.arguments ?? "{}");
  assert.equal(args.control, "comparison");
  assert.equal(args.options.length, 3);
  assert.ok(args.options.every((option: { sources: unknown[] }) => option.sources.length));
});

test("live Jev demo candidates quote each page instead of reusing sample copy", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "Explore exhibits" }];
  const texts = [
    "Kelp Forest at 28 feet features sardines and leopard sharks.",
    "Open Sea has a 90-foot window with turtles, sardines, and tuna.",
    "Rocky Shore has a touch pool for bat rays. Tickets are available separately.",
  ];
  for (const [index, text] of texts.entries()) {
    const next = demoResponse(jevRequest(messages));
    const { url } = JSON.parse(calls(next)?.[0]?.arguments ?? "{}");
    messages.push({
      role: "tool",
      tool_call_id: calls(next)?.[0]?.id,
      content: JSON.stringify({
        sessionId: `page-${index}`,
        url,
        title: "Aquarium",
        text,
        truncated: false,
      }),
    });
  }
  const previous = process.env.DEMO_JEV_MODE;
  try {
    process.env.DEMO_JEV_MODE = "live";
    const response = demoResponse(jevRequest(messages));
    const options = JSON.parse(calls(response)?.[0]?.arguments ?? "{}").options;
    assert.equal(options.length, 3);
    for (const [index, option] of options.entries()) {
      assert.equal(option.sources[0].title, option.label);
      assert.equal(option.details.length, 1);
      assert.ok(texts[index].includes(option.details[0]));
    }
    assert.equal(options[2].details[0], "Rocky Shore has a touch pool for bat rays.");
  } finally {
    if (previous === undefined) delete process.env.DEMO_JEV_MODE;
    else process.env.DEMO_JEV_MODE = previous;
  }
});

test("Explore exhibits does not make a card when a browser read fails", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "Explore exhibits" }];
  const first = demoResponse(jevRequest(messages));
  messages.push({
    role: "tool",
    tool_call_id: calls(first)?.[0]?.id,
    content: JSON.stringify({ error: "Worker unavailable" }),
  });
  const answer = demoResponse(jevRequest(messages));
  assert.ok(!calls(answer)?.length);
  assert.match(replyText(answer) ?? "", /couldn.t read/i);
});

test("Explore exhibits rejects a successful page whose text does not support its fixture claim", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "Explore exhibits" }];
  const first = demoResponse(jevRequest(messages));
  const { url } = JSON.parse(calls(first)?.[0]?.arguments ?? "{}");
  messages.push({
    role: "tool",
    tool_call_id: calls(first)?.[0]?.id,
    content: JSON.stringify({
      sessionId: "page",
      url,
      title: "Kelp Forest",
      text: "Tickets and hours only.",
      truncated: false,
    }),
  });
  const answer = demoResponse(jevRequest(messages));
  assert.ok(!calls(answer)?.length);
  assert.match(replyText(answer) ?? "", /couldn.t verify|does not support/i);
});

test("hands-on preference refines the same candidate set and selection is acknowledged", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "Explore exhibits" },
    {
      role: "tool",
      tool_call_id: "call_openmuse_demo_jev_previous",
      content: JSON.stringify({ panel: { id: "comparison-1", type: "comparison" } }),
    },
    { role: "user", content: "Something hands-on" },
  ];
  const refinement = demoResponse(jevRequest(history));
  assert.equal(calls(refinement)?.[0]?.name, "present_choices");
  const args = JSON.parse(calls(refinement)?.[0]?.arguments ?? "{}");
  assert.equal(args.control, "comparison");
  assert.deepEqual(
    args.options.map((option: { id: string }) => option.id),
    ["kelp-forest", "open-sea", "rocky-shore"],
  );
  assert.match(args.message, /hands.on/i);
  assert.equal(args.refinementPanelId, "comparison-1");
  const selection = demoResponse(jevRequest([{ role: "user", content: "Rocky Shore" }]));
  assert.match(replyText(selection) ?? "", /Rocky Shore/);
  assert.ok(!calls(selection)?.length);
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
