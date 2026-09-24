import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { TestContext } from "node:test";

type ModelCall = { name: string; arguments: object };

// Serve the provider protocol, leaving tool execution and AG-UI event emission to the real SDK.
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
      response.write(
        `data: ${JSON.stringify({
          type: "response.created",
          response: {
            id: `drop-${index}`,
            created_at: 1000,
            model: "fixture",
            status: "in_progress",
          },
        })}\n\n`,
      );
      setTimeout(() => response.socket?.destroy(), 120);
      return;
    }
    if (dropAfterText?.(index)) {
      // Deliver real assistant output, then fail the connection. A retry
      // must not replay output the client already received.
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          type: "response.created",
          response: {
            id: `drop-text-${index}`,
            created_at: 1000,
            model: "fixture",
            status: "in_progress",
          },
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: `msg-${index}`,
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          item_id: `msg-${index}`,
          output_index: 0,
          delta: "Hello partial ",
        })}\n\n`,
      );
      setTimeout(() => response.socket?.destroy(), 120);
      return;
    }
    if (errorPart?.(index)) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          type: "response.failed",
          sequence_number: 1,
          response: {
            error: { code: "server_error", message: "Provider reported response.failed" },
          },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    const call = await reply(index);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (type: string, value: object) =>
      response.write(`data: ${JSON.stringify({ type, ...value })}\n\n`);
    const base = { id: `response-${index}`, created_at: 1000, model: "fixture" };
    emit("response.created", { response: { ...base, status: "in_progress" } });
    const item = call && {
      id: `item-${index}`,
      type: "function_call",
      call_id: `call-${index}`,
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    };
    if (item) {
      emit("response.output_item.added", { output_index: 0, item: { ...item, arguments: "" } });
      emit("response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: 0,
        delta: item.arguments,
      });
      emit("response.output_item.done", {
        output_index: 0,
        item: { ...item, status: "completed" },
      });
    }
    emit("response.completed", {
      response: {
        ...base,
        status: "completed",
        output: item ? [{ ...item, status: "completed" }] : [],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });
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
