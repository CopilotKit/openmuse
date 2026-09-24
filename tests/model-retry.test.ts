import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { type BuiltInAgent, defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { MODEL_MAX_RETRIES } from "../apps/server/src/config.ts";
import { tanstackAgent } from "../apps/server/src/engine/tanstack-agent.ts";
import { modelFixture } from "./helpers/model.ts";

const run = (agent: BuiltInAgent) => {
  const input: RunAgentInput = {
    threadId: "retry-fixture",
    runId: "retry-fixture-run",
    messages: [{ id: "m1", role: "user", content: "Reply briefly." }],
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
        // An erroring observable never completes, so resolve here.
        if (error === undefined) error = String(cause);
        resolve({ error, finished: false, text });
      },
      complete: () => resolve({ error, finished, text }),
    });
  });
};

const agent = () =>
  tanstackAgent({
    model: "openai/fixture",
    maxSteps: 2,
    tools: [],
    prompt: "Reply briefly.",
  });

test("a transient provider failure is retried and the run completes", async (t) => {
  const { requests } = await modelFixture(t, () => undefined, {
    errorStatus: (index) => (index === 0 ? 500 : undefined),
  });
  const outcome = await run(agent());
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.finished, true);
  assert.equal(requests.length, 2, "exactly one retry follows the transient failure");
  assert.equal(requests[1].body, requests[0].body, "the retry replays the same model request");
});

test("a non-retryable provider failure fails fast without a retry", async (t) => {
  const { requests } = await modelFixture(t, () => undefined, { errorStatus: () => 400 });
  const outcome = await run(agent());
  assert.equal(outcome.finished, false);
  assert.match(outcome.error ?? "", /Fixture provider failure/);
  assert.equal(requests.length, 1, "a 400 must never be retried");
});

test("retries give up after the configured attempts", async (t) => {
  const { requests } = await modelFixture(t, () => undefined, { errorStatus: () => 500 });
  const outcome = await run(agent());
  assert.equal(outcome.finished, false);
  assert.equal(requests.length, MODEL_MAX_RETRIES + 1, "retries are bounded");
});

// Provider SDKs retry only until the response starts. A failure after the stream
// has started ends the run, even when a second attempt would succeed.
test("a connection drop after the stream starts is not retried", async (t) => {
  const { requests } = await modelFixture(t, () => undefined, {
    dropAfterStart: (index) => index === 0,
  });
  const outcome = await run(agent());
  assert.equal(outcome.finished, false);
  assert.ok(outcome.error, "the run reports the dropped stream");
  assert.equal(requests.length, 1, "a started stream is not retried");
});

test("a provider error part after the stream starts is not retried", async (t) => {
  const { requests } = await modelFixture(t, () => undefined, {
    errorPart: (index) => index === 0,
  });
  const outcome = await run(agent());
  assert.equal(outcome.finished, false);
  assert.match(outcome.error ?? "", /Provider reported response.failed/);
  assert.equal(requests.length, 1, "an error part in a started stream is not retried");
});

test("a committed tool result is not re-executed when the next model call fails", async (t) => {
  let toolRuns = 0;
  const { requests } = await modelFixture(
    t,
    (index) =>
      index === 0 ? { name: "note_step", arguments: { note: "step one done" } } : undefined,
    { errorStatus: (index) => (index === 1 ? 500 : undefined) },
  );
  const stepAgent = tanstackAgent({
    model: "openai/fixture",
    maxSteps: 4,
    tools: [
      defineTool({
        name: "note_step",
        description: "Record a step note",
        parameters: z.object({ note: z.string() }),
        execute: async ({ note }) => {
          toolRuns++;
          return { recorded: note };
        },
      }),
    ],
    prompt: "Use the tool once, then finish.",
  });
  const outcome = await run(stepAgent);
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.finished, true);
  assert.equal(requests.length, 3, "the retry replays the failed model call only");
  assert.equal(
    requests[2].body,
    requests[1].body,
    "the retry resent the failed step, not a restarted run",
  );
  assert.equal(toolRuns, 1, "committed tool work is never re-run by a retry");
});

test("assistant output already delivered is never replayed by a retry", async (t) => {
  const { requests } = await modelFixture(t, () => undefined, {
    dropAfterText: (index) => index === 0,
  });
  const outcome = await run(agent());
  assert.equal(outcome.finished, false);
  assert.ok(outcome.error, "the run reports the dropped stream");
  assert.equal(requests.length, 1, "a stream with visible output is not retried");
  assert.equal(outcome.text, "Hello partial ", "the client saw the delivered delta exactly once");
});
