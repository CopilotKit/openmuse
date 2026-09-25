import assert from "node:assert/strict";
import { test } from "node:test";
import { AbstractAgent } from "@ag-ui/client";
import { AgentThreadLockedError, CopilotKitCore } from "@copilotkit/core";
import { throwError } from "rxjs";
import { ConversationQueue } from "../apps/mobile/src/conversation-queue.ts";
import {
  ConversationTurnError,
  runConversationTurn,
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
