import assert from "node:assert/strict";
import { test } from "node:test";
import { type BaseEvent, EventType } from "@ag-ui/core";
import { from, lastValueFrom, toArray } from "rxjs";
import { reportStepLimit } from "../apps/server/src/engine/tanstack-agent.ts";

const note = "I reached my step limit.";
const start = { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as BaseEvent;
const finish = { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent;
const call = (id: string) => ({ type: EventType.TOOL_CALL_START, toolCallId: id }) as BaseEvent;
const result = (id: string) =>
  ({ type: EventType.TOOL_CALL_RESULT, toolCallId: id, messageId: `m-${id}` }) as BaseEvent;
const text = (delta: string) =>
  ({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: "a", delta }) as BaseEvent;
const run = (events: BaseEvent[], maxSteps: number) =>
  lastValueFrom(reportStepLimit(from(events), maxSteps, note).pipe(toArray()));
const notes = (events: BaseEvent[]) =>
  events.filter(
    (event) =>
      event.type === EventType.TEXT_MESSAGE_CHUNK && (event as { delta?: string }).delta === note,
  );

test("a run cut off by the step limit ends with a note before RUN_FINISHED", async () => {
  // Two steps: two parallel calls, then one more call. The limit ends it without a reply.
  const events = await run(
    [start, call("a"), call("b"), result("a"), result("b"), call("c"), result("c"), finish],
    2,
  );
  assert.equal(notes(events).length, 1);
  assert.equal(events.at(-2)?.type, EventType.TEXT_MESSAGE_CHUNK);
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
});

test("runs the model finished itself get no note", async () => {
  const replied = await run([start, call("a"), result("a"), text("Done."), finish], 1);
  assert.equal(notes(replied).length, 0);
  const underLimit = await run([start, call("a"), result("a"), finish], 2);
  assert.equal(notes(underLimit).length, 0, "fewer steps than the limit is not a cutoff");
  const noTools = await run([start, text("Hi"), finish], 1);
  assert.equal(notes(noTools).length, 0);
});
