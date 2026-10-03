import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { TestContext } from "node:test";

type ModelCall = { name: string; arguments: object };

// Serve the OpenAI Chat Completions protocol — the wire format the engine's
// adapter (openaiChatCompletions) speaks — leaving tool execution and AG-UI
// event emission to the real SDK.
export async function modelFixture(
  t: TestContext,
  reply: (index: number) => ModelCall | undefined | Promise<ModelCall | undefined>,
  options: {
    errorStatus?: (index: number) => number | undefined;
    dropAfterStart?: (index: number) => boolean;
    dropAfterText?: (index: number) => boolean;
    errorPart?: (index: number) => boolean;
  } = {},
) {
  const { errorStatus, dropAfterStart, dropAfterText, errorPart } = options;
  const requests: { path: string; body: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const index = requests.length;
    requests.push({ path: request.url ?? "", body });
    const status = errorStatus?.(index);
    if (status !== undefined) {
      // A pre-stream HTTP error. The OpenAI SDK throws APIError; it retries
      // only 5xx/429. 400 has status !== undefined, so it must never retry.
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "Fixture provider failure", type: "server_error" },
        }),
      );
      return;
    }
    if (dropAfterStart?.(index)) {
      // Deliver a valid stream start, then fail the connection before any
      // assistant output reaches the client.
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: `drop-${index}`, object: "chat.completion.chunk", created: 1000, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: null }] })}\n\n`);
      setTimeout(() => response.socket?.destroy(), 120);
      return;
    }
    if (dropAfterText?.(index)) {
      // Deliver real assistant output, then fail the connection. A retry
      // must not replay output the client already received.
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: `drop-text-${index}`, object: "chat.completion.chunk", created: 1000, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: `drop-text-${index}`, object: "chat.completion.chunk", created: 1000, model: "fixture", choices: [{ index: 0, delta: { content: "Hello partial " }, finish_reason: null }] })}\n\n`);
      setTimeout(() => response.socket?.destroy(), 120);
      return;
    }
    if (errorPart?.(index)) {
      // An error after the stream starts: chat completions has no dedicated
      // in-stream error event, but the OpenAI SDK throws APIError when a
      // data chunk carries { error }. Status stays undefined, so the error is
      // not retried — same observable behavior the Responses fixture had.
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ error: { message: "Provider reported response.failed", type: "server_error" } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    const call = await reply(index);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({
          id: `chatcmpl-${index}`,
          object: "chat.completion.chunk",
          created: 1000,
          model: "fixture",
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    chunk({});
    if (call) {
      chunk({
        tool_calls: [
          {
            index: 0,
            id: `call-${index}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          },
        ],
      });
      chunk({}, "tool_calls");
    } else {
      chunk({ role: "assistant", content: "Fixture reply." }, "stop");
    }
    chunk({});
    response.write(
      `data: ${JSON.stringify({
        id: `chatcmpl-${index}`,
        object: "chat.completion.chunk",
        created: 1000,
        model: "fixture",
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previousBase = process.env.OPENAI_BASE_URL;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.OPENAI_API_KEY = "local-test-fixture";
  t.after(async () => {
    if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { requests };
}
