import assert from "node:assert/strict";
import { test } from "node:test";
import { AbstractAgent } from "@ag-ui/client";
import { EventType } from "@ag-ui/core";
import { AgentThreadLockedError, CopilotKitCore } from "@copilotkit/core";
import { of, throwError } from "rxjs";
import { ConversationQueue } from "../apps/mobile/src/conversation-queue.ts";
import {
  ConversationTurnError,
  replayedRunError,
  runConversationTurn,
  showsRunError,
  threadLocked,
} from "../apps/mobile/src/conversation-run.ts";

test("an emitted CopilotKit run error stops the queue even when runAgent resolves", async () => {
  let attempts = 0;
  class FailingAgent extends AbstractAgent {
    run() {
      attempts++;
      return throwError(() => new Error("Connection interrupted"));
    }
  }
  const agent = new FailingAgent({ agentId: "default" });
  const core = new CopilotKitCore({ agents__unsafe_dev_only: { default: agent } });
  const queue = new ConversationQueue();
  queue.enqueue({ id: "first", text: "First task" });
  queue.enqueue({ id: "second", text: "Second task" });
  await assert.rejects(
    queue.flush(() =>
      runConversationTurn(
        "default",
        () => core.runAgent({ agent }),
        (onError) => core.subscribe({ onError }),
      ),
    ),
    /Connection interrupted/,
  );
  assert.equal(attempts, 1);
  assert.equal(queue.getSnapshot().paused, true);
  assert.deepEqual(
    queue.getSnapshot().pending.map((message) => message.id),
    ["second"],
  );
});

test("a failed turn saved in thread history does not block loading the conversation", async () => {
  class ReplayingAgent extends AbstractAgent {
    run() {
      return throwError(() => new Error("not used"));
    }
    connect() {
      return of(
        { type: EventType.RUN_STARTED, threadId: "thread", runId: "old-run" },
        { type: EventType.RUN_ERROR, message: "Missing Authentication header" },
      );
    }
  }
  const agent = new ReplayingAgent({ agentId: "default", threadId: "thread" });
  const core = new CopilotKitCore({ agents__unsafe_dev_only: { default: agent } });
  const connect = (ignore?: string[]) =>
    runConversationTurn(
      "default",
      () => core.connectAgent({ agent }),
      (onError) => core.subscribe({ onError }),
      ignore,
    );
  await assert.rejects(connect(), /Missing Authentication header/);
  await connect([replayedRunError]);
});

test("a connection failure still blocks loading the conversation", async () => {
  class UnreachableAgent extends AbstractAgent {
    run() {
      return throwError(() => new Error("not used"));
    }
    connect() {
      return throwError(() => new Error("Thread service unavailable"));
    }
  }
  const agent = new UnreachableAgent({ agentId: "default", threadId: "thread" });
  const core = new CopilotKitCore({ agents__unsafe_dev_only: { default: agent } });
  await assert.rejects(
    runConversationTurn(
      "default",
      () => core.connectAgent({ agent }),
      (onError) => core.subscribe({ onError }),
      [replayedRunError],
    ),
    /Thread service unavailable/,
  );
});

test("a turn refused because the thread is locked reports the lock code", async () => {
  class LockedAgent extends AbstractAgent {
    run() {
      return throwError(() => new AgentThreadLockedError("thread"));
    }
  }
  const agent = new LockedAgent({ agentId: "default", threadId: "thread" });
  const core = new CopilotKitCore({ agents__unsafe_dev_only: { default: agent } });
  await assert.rejects(
    runConversationTurn(
      "default",
      () => core.runAgent({ agent }),
      (onError) => core.subscribe({ onError }),
    ),
    (error: unknown) =>
      error instanceof ConversationTurnError &&
      error.code === threadLocked &&
      error.message === "Thread thread is locked",
  );
});

test("with replayed errors ignored, a lock refusal is still the reported failure", async () => {
  const locked = new Error("Thread thread is locked");
  locked.name = "AgentThreadLockedError";
  await assert.rejects(
    runConversationTurn(
      "default",
      async () => {},
      (onError) => {
        onError({ error: new Error("Saved failure"), code: replayedRunError });
        onError({ error: locked, code: threadLocked });
        onError({ error: new Error("Run failed"), code: "agent_run_failed" });
        return { unsubscribe() {} };
      },
      [replayedRunError],
    ),
    (error: unknown) => error instanceof ConversationTurnError && error.code === threadLocked,
  );
});

test("the error banner hides replayed errors and held lock refusals, but not Retry's lock", () => {
  const replayed = { error: new Error("Saved failure"), code: replayedRunError };
  const locked = { error: new Error("Thread thread is locked"), code: threadLocked };
  const idle = { replaying: false, queuedTurn: false };
  assert.equal(showsRunError(replayed, { ...idle, replaying: true }), false);
  assert.equal(showsRunError(replayed, idle), true);
  assert.equal(showsRunError(locked, { ...idle, queuedTurn: true }), false);
  assert.equal(showsRunError(locked, idle), true, "Retry is not a queued turn, so its lock shows");
  assert.equal(
    showsRunError({ error: new Error("Network down") }, { ...idle, queuedTurn: true }),
    true,
  );
});
