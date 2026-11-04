import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import type { BuiltInAgent } from "@copilotkit/runtime/v2";
import { agentConfigured } from "../apps/server/src/agent.ts";
import type { Config } from "../apps/server/src/config.ts";
import { tanstackAgent } from "../apps/server/src/engine/tanstack-agent.ts";

const run = (agent: BuiltInAgent) => {
  const input: RunAgentInput = {
    threadId: "llmtr-fixture",
    runId: "llmtr-fixture-run",
    messages: [{ id: "m1", role: "user", content: "Reply with pong." }],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
  return new Promise<{ error?: string; finished: boolean; text: string }>((resolve) => {
    let error: string | undefined;
    let finished = false;
    let text = "";
    agent.run(input).subscribe({
      next: (event) => {
        if (
          (event.type === EventType.TEXT_MESSAGE_CHUNK ||
            event.type === EventType.TEXT_MESSAGE_CONTENT) &&
          "delta" in event &&
          typeof event.delta === "string"
        )
          text += event.delta;
        if (event.type === EventType.RUN_ERROR && "message" in event) error = String(event.message);
        if (event.type === EventType.RUN_FINISHED) finished = true;
      },
      error: (cause) => {
        if (error === undefined) error = String(cause);
        resolve({ error, finished: false, text });
      },
      complete: () => resolve({ error, finished, text }),
    });
  });
};

test("LLMTR_API_KEY marks the model agent configured", () => {
  const previous = {
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    google: process.env.GOOGLE_API_KEY,
    llmtr: process.env.LLMTR_API_KEY,
  };
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.LLMTR_API_KEY;
  try {
    const config = {
      agentBackend: "model",
      model: "llmtr/qwen/qwen3.8-27b-free",
    } as Config;
    assert.equal(agentConfigured(config), false);
    process.env.LLMTR_API_KEY = "llmtr-test";
    assert.equal(agentConfigured(config), true);
  } finally {
    for (const [name, value] of [
      ["OPENAI_API_KEY", previous.openai],
      ["ANTHROPIC_API_KEY", previous.anthropic],
      ["GOOGLE_API_KEY", previous.google],
      ["LLMTR_API_KEY", previous.llmtr],
    ] as const)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
});

test("the llmtr provider posts chat completions and keeps hosted model ids", async (t) => {
  const requests: { path: string; authorization: string; body: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization ?? "",
      body,
    });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, finish: string | null) =>
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-llmtr",
          object: "chat.completion.chunk",
          created: 1000,
          model: "fixture",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`,
      );
    chunk({ role: "assistant" }, null);
    chunk({ content: "pong" }, null);
    chunk({}, "stop");
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previousBase = process.env.LLMTR_BASE_URL;
  const previousKey = process.env.LLMTR_API_KEY;
  process.env.LLMTR_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.LLMTR_API_KEY = "llmtr-test-key";
  t.after(async () => {
    if (previousBase === undefined) delete process.env.LLMTR_BASE_URL;
    else process.env.LLMTR_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.LLMTR_API_KEY;
    else process.env.LLMTR_API_KEY = previousKey;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  for (const spec of ["llmtr/qwen3-8-27b", "llmtr/qwen/qwen3.8-27b-free"] as const) {
    const outcome = await run(
      tanstackAgent({ model: spec, maxSteps: 2, tools: [], prompt: "Reply with pong." }),
    );
    assert.equal(outcome.error, undefined, outcome.error);
    assert.equal(outcome.finished, true);
    assert.match(outcome.text, /pong/);
  }

  assert.equal(requests.length, 2);
  for (const [index, model] of ["llmtr/qwen3-8-27b", "qwen/qwen3.8-27b-free"].entries()) {
    const request = requests[index];
    assert.ok(request);
    assert.equal(request.path, "/v1/chat/completions");
    assert.equal(request.authorization, "Bearer llmtr-test-key");
    const body = JSON.parse(request.body) as { model?: string; reasoning?: unknown };
    assert.equal(body.model, model);
    assert.equal("reasoning" in body, false);
  }
});

test("the llmtr provider fails before a request when the key is missing", async () => {
  const previous = process.env.LLMTR_API_KEY;
  delete process.env.LLMTR_API_KEY;
  try {
    const outcome = await run(
      tanstackAgent({
        model: "llmtr/qwen/qwen3.8-27b-free",
        maxSteps: 1,
        tools: [],
        prompt: "Reply with pong.",
      }),
    );
    assert.match(outcome.error ?? "", /LLMTR_API_KEY/);
    assert.equal(outcome.finished, false);
  } finally {
    if (previous === undefined) delete process.env.LLMTR_API_KEY;
    else process.env.LLMTR_API_KEY = previous;
  }
});
