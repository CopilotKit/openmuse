import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import { MODEL_MAX_RETRIES } from "../apps/server/src/config.ts";
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
  return new Promise<{ error?: string; finished: boolean }>((resolve) => {
    let error: string | undefined;
    let finished = false;
    agent.run(input).subscribe({
      next: (event) => {
        if (event.type === EventType.RUN_ERROR && "message" in event) error = String(event.message);
        if (event.type === EventType.RUN_FINISHED) finished = true;
      },
      error: (cause) => {
        // An erroring observable never completes, so resolve here.
        if (error === undefined) error = String(cause);
        resolve({ error, finished: false });
      },
      complete: () => resolve({ error, finished }),
    });
  });
};

const agent = () =>
  new BuiltInAgent({
    model: "openai/fixture",
    maxSteps: 2,
    maxRetries: MODEL_MAX_RETRIES,
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

test("a connection drop after the stream starts is retried and the run recovers", async (t) => {
  const { requests } = await modelFixture(t, () => undefined, {
    dropAfterStart: (index) => index === 0,
  });
  const outcome = await run(agent());
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.finished, true);
  assert.equal(requests.length, 2, "the dropped stream is retried once and recovers");
});

test("a provider error part is retried within the same bound before the run errors", async (t) => {
  const { requests } = await modelFixture(t, () => undefined, { errorPart: () => true });
  const outcome = await run(agent());
  assert.equal(outcome.finished, false);
  assert.match(outcome.error ?? "", /response.failed/);
  assert.equal(requests.length, MODEL_MAX_RETRIES + 1, "error parts obey the same bound");
});
