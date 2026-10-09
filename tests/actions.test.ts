import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ActionService } from "../apps/server/src/actions.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { type ActionProposal, eventDraftSchema } from "../packages/domain/src/index.ts";

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Promise was not initialized");
  };
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

let db: Store;
before(async () => {
  db = await createStore();
});
after(async () => {
  await db.close();
});
const email = {
  kind: "email.send" as const,
  data: {
    to: ["sam@example.com"],
    subject: "Visit",
    body: "See attached.",
    cc: [],
    bcc: [],
    attachmentIds: [],
  },
};
test("denying a persisted proposal never calls its adapter", async () => {
  let calls = 0;
  const service = new ActionService(db, {
    execute: async () => {
      calls++;
      return "sent";
    },
    connected: async () => true,
  });
  const proposal = await service.propose("deny-user", email);
  assert.equal(proposal.status, "awaiting_review");
  const result = await service.decide("deny-user", proposal.id, proposal.hash, "deny");
  assert.equal(result.status, "denied");
  assert.equal(calls, 0);
});
test("concurrent approval consumes the proposal only once", async () => {
  let calls = 0;
  const service = new ActionService(db, {
    execute: async () => {
      calls++;
      return "provider-receipt";
    },
    connected: async () => true,
  });
  const proposal = await service.propose("once-user", email);
  await Promise.allSettled([
    service.decide("once-user", proposal.id, proposal.hash, "approve"),
    service.decide("once-user", proposal.id, proposal.hash, "approve"),
  ]);
  assert.equal(calls, 1);
  const saved = await db.get("once-user", "actions", proposal.id);
  assert.equal(saved?.status, "succeeded");
  assert.equal(saved?.result, "provider-receipt");
});
test("wrong owner and stale hash cannot approve", async () => {
  const service = new ActionService(db, {
    execute: async () => "sent",
    connected: async () => true,
  });
  const proposal = await service.propose("private-user", email);
  await assert.rejects(
    service.decide("attacker", proposal.id, proposal.hash, "approve"),
    /not found/i,
  );
  await assert.rejects(service.decide("private-user", proposal.id, "stale", "approve"), /changed/i);
});
test("expired and disconnected proposals never reach the provider", async () => {
  let now = Date.now();
  let connected = true;
  let calls = 0;
  const service = new ActionService(db, {
    execute: async () => {
      calls++;
      return "sent";
    },
    connected: async () => connected,
    now: () => now,
  });
  const expired = await service.propose("expired-user", email);
  now += 31 * 60 * 1000;
  await assert.rejects(
    service.decide("expired-user", expired.id, expired.hash, "approve"),
    /expired/i,
  );
  const revoked = await service.propose("revoked-user", email);
  connected = false;
  await assert.rejects(
    service.decide("revoked-user", revoked.id, revoked.hash, "approve"),
    /disconnected/i,
  );
  assert.equal(calls, 0);
});
test("uncertain writes retain uncertainty and cannot be retried", async () => {
  let calls = 0;
  const service = new ActionService(db, {
    execute: async () => {
      calls++;
      throw Object.assign(new Error("Provider response lost"), { outcomeUnknown: true });
    },
    connected: async () => true,
  });
  const proposal = await service.propose("uncertain-user", email);
  const result = await service.decide("uncertain-user", proposal.id, proposal.hash, "approve");
  assert.equal(result.status, "outcome_unknown");
  await service.decide("uncertain-user", proposal.id, proposal.hash, "approve");
  assert.equal(calls, 1);
});
async function sendDraft(
  owner: string,
  decision: "approve" | "deny",
  execute: () => Promise<string>,
) {
  const service = new ActionService(db, { execute, connected: async () => true });
  const draft = await db.put(owner, "drafts", { ...email.data, id: randomUUID() });
  const proposal = await service.propose(owner, { ...email, draftId: draft.id });
  const result = await service.decide(owner, proposal.id, proposal.hash, decision);
  return { status: result.status, draft: await db.get(owner, "drafts", draft.id) };
}
test("sending a saved draft removes it from drafts", async () => {
  const sent = await sendDraft("draft-sent-user", "approve", async () => "sent");
  assert.equal(sent.status, "succeeded");
  assert.equal(sent.draft, null);
});
test("a draft stays when its email is declined, fails or has an unknown outcome", async () => {
  const denied = await sendDraft("draft-denied-user", "deny", async () => "sent");
  assert.equal(denied.status, "denied");
  assert.ok(denied.draft);
  const failed = await sendDraft("draft-failed-user", "approve", async () => {
    throw new Error("Provider rejected the message");
  });
  assert.equal(failed.status, "failed");
  assert.ok(failed.draft);
  const uncertain = await sendDraft("draft-uncertain-user", "approve", async () => {
    throw Object.assign(new Error("Provider response lost"), { outcomeUnknown: true });
  });
  assert.equal(uncertain.status, "outcome_unknown");
  assert.ok(uncertain.draft);
});
test("an expired review keeps its draft", async () => {
  let now = Date.now();
  const service = new ActionService(db, {
    execute: async () => "sent",
    connected: async () => true,
    now: () => now,
  });
  const draft = await db.put("draft-expired-user", "drafts", { ...email.data, id: randomUUID() });
  const proposal = await service.propose("draft-expired-user", { ...email, draftId: draft.id });
  now += 31 * 60 * 1000;
  await assert.rejects(
    service.decide("draft-expired-user", proposal.id, proposal.hash, "approve"),
    /expired/i,
  );
  assert.ok(await db.get("draft-expired-user", "drafts", draft.id));
});
test("a draft rewritten after its review started is kept when that review is approved", async () => {
  const service = new ActionService(db, {
    execute: async () => "sent",
    connected: async () => true,
  });
  const id = randomUUID();
  await db.put("draft-rewrite-user", "drafts", { ...email.data, id });
  const proposal = await service.propose("draft-rewrite-user", { ...email, draftId: id });
  await db.put("draft-rewrite-user", "drafts", { ...email.data, id, body: "Rewritten" });
  await service.decide("draft-rewrite-user", proposal.id, proposal.hash, "approve");
  const kept = await db.get<{ body: string }>("draft-rewrite-user", "drafts", id);
  assert.equal(kept?.body, "Rewritten");
});
test("a newer review of a draft replaces the older one, so the email is sent once", async () => {
  let sends = 0;
  const service = new ActionService(db, {
    execute: async () => {
      sends++;
      return "sent";
    },
    connected: async () => true,
  });
  const draft = await db.put("draft-twice-user", "drafts", { ...email.data, id: randomUUID() });
  const first = await service.propose("draft-twice-user", { ...email, draftId: draft.id });
  const second = await service.propose("draft-twice-user", { ...email, draftId: draft.id });
  const stale = await service.decide("draft-twice-user", first.id, first.hash, "approve");
  assert.equal(stale.status, "cancelled");
  const sent = await service.decide("draft-twice-user", second.id, second.hash, "approve");
  assert.equal(sent.status, "succeeded");
  assert.equal(sends, 1);
  assert.equal(await db.get("draft-twice-user", "drafts", draft.id), null);
});
test("a failed draft cleanup still reports the email as sent", async (t) => {
  const store = await createStore();
  t.after(() => store.close());
  const service = new ActionService(store, {
    execute: async () => "sent",
    connected: async () => true,
  });
  const draft = await store.put("cleanup-user", "drafts", { ...email.data, id: randomUUID() });
  const proposal = await service.propose("cleanup-user", { ...email, draftId: draft.id });
  const unavailable = async () => {
    throw new Error("Database briefly unavailable");
  };
  Object.assign(store, { remove: unavailable, removeIf: unavailable });
  const logged = t.mock.method(console, "error", () => {});
  const result = await service.decide("cleanup-user", proposal.id, proposal.hash, "approve");
  assert.equal(result.status, "succeeded");
  assert.equal(logged.mock.callCount(), 1);
});
test("a review only links a draft that exists for the same owner", async () => {
  const service = new ActionService(db, {
    execute: async () => "sent",
    connected: async () => true,
  });
  const draft = await db.put("draft-owner", "drafts", { ...email.data, id: randomUUID() });
  await assert.rejects(
    service.propose("draft-other-owner", { ...email, draftId: draft.id }),
    /Draft not found/,
  );
  await assert.rejects(
    service.propose("draft-owner", { ...email, draftId: randomUUID() }),
    /Draft not found/,
  );
});
test("another service instance sees persisted proposals", async () => {
  const options = { execute: async () => "created", connected: async () => true };
  const first = new ActionService(db, options);
  const proposal = await first.propose("resume-user", email);
  const second = new ActionService(db, options);
  assert.equal(
    (await second.decide("resume-user", proposal.id, proposal.hash, "approve")).status,
    "succeeded",
  );
});
test("event validation preserves all-day semantics and rejects missing offsets", () => {
  const base = { title: "Visit", start: "2026-10-23", end: "2026-10-24", allDay: true };
  assert.equal(eventDraftSchema.parse(base).start, "2026-10-23");
  assert.equal(eventDraftSchema.safeParse({ ...base, allDay: false }).success, false);
  assert.equal(eventDraftSchema.safeParse({ ...base, end: "2026-10-22" }).success, false);
  assert.equal(eventDraftSchema.safeParse({ ...base, timeZone: "Not/AZone" }).success, false);
});
test("account switching and reconnecting invalidate a prepared action", async () => {
  let connection = { id: "connection-a", account: "a@example.com" };
  let calls = 0;
  const service = new ActionService(db, {
    execute: async () => {
      calls++;
      return "sent";
    },
    connected: async () => true,
    connection: async () => connection,
  });
  const proposal = await service.propose("account-user", email);
  assert.equal(proposal.account, "a@example.com");
  connection = { id: "connection-b", account: "b@example.com" };
  await assert.rejects(
    service.decide("account-user", proposal.id, proposal.hash, "approve"),
    /connection changed/i,
  );
  connection = { id: "connection-new-a", account: "a@example.com" };
  await assert.rejects(
    service.decide("account-user", proposal.id, proposal.hash, "approve"),
    /connection changed/i,
  );
  assert.equal(calls, 0);
});

test("review stores authoritative calendar details and binds execution to their version", async () => {
  const target = {
    id: "event-1",
    ...eventDraftSchema.parse({
      title: "Provider title",
      start: "2026-10-23",
      end: "2026-10-24",
      allDay: true,
    }),
  };
  let version = '"revision-1"';
  const service = new ActionService(db, {
    connected: async () => true,
    connection: async () => ({ id: "calendar-connection", account: "me@example.com" }),
    prepare: async (_owner, input, connectionId) => {
      assert.equal(connectionId, "calendar-connection");
      assert.equal(input.kind, "calendar.delete");
      return {
        input: {
          kind: "calendar.delete",
          data: { eventId: target.id, calendarId: "primary", title: target.title },
        },
        target,
        targetVersion: version,
      };
    },
    execute: async (_owner, input, connectionId, targetVersion) => {
      assert.ok(input.kind === "calendar.delete");
      assert.equal(input.data.title, "Provider title");
      assert.equal(connectionId, "calendar-connection");
      assert.equal(targetVersion, '"revision-1"');
      return "Deleted";
    },
  });
  const input = {
    kind: "calendar.delete",
    data: { eventId: target.id, calendarId: "primary", title: "Untrusted title" },
  };
  const proposal = await service.propose("review-owner", input);
  assert.equal(proposal.title, "Delete Provider title");
  assert.deepEqual(proposal.target, target);
  assert.equal(proposal.targetVersion, version);
  version = '"revision-2"';
  const newer = await service.propose("review-owner", input);
  assert.notEqual(newer.hash, proposal.hash);
  assert.equal(
    (await service.decide("review-owner", proposal.id, proposal.hash, "approve")).status,
    "succeeded",
  );
});

test("idempotent proposal replay returns a completed action before another provider preparation", async () => {
  let preparations = 0;
  const service = new ActionService(db, {
    connected: async () => true,
    prepare: async (_owner, input) => {
      preparations++;
      return { input };
    },
    execute: async () => "sent",
  });
  const proposal = await service.propose("replay-owner", email, "run/tool-1");
  await service.decide("replay-owner", proposal.id, proposal.hash, "approve");
  const replay = await service.propose("replay-owner", email, "run/tool-1");
  assert.equal(replay.id, proposal.id);
  assert.equal(replay.status, "succeeded");
  assert.equal(preparations, 1);
  const otherOwner = await service.propose("different-owner", email, "run/tool-1");
  assert.equal(otherOwner.status, "awaiting_review");
});

test("concurrent idempotent proposals retain a single persisted review and activity entry", async () => {
  const service = new ActionService(db, {
    connected: async () => true,
    execute: async () => "sent",
  });
  const results = await Promise.all([
    service.propose("concurrent-replay", email, "run/tool-1"),
    service.propose("concurrent-replay", email, "run/tool-1"),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal((await db.list("concurrent-replay", "actions")).length, 1);
  assert.equal((await db.list("concurrent-replay", "activity")).length, 1);
});

test("an expired stale review cannot overwrite a concurrently executing action", async (t) => {
  let now = Date.now();
  const read = deferred<void>();
  const resumeRead = deferred<void>();
  const executing = deferred<void>();
  const finishExecution = deferred<string>();
  const service = new ActionService(db, {
    connected: async () => true,
    now: () => now,
    execute: async () => {
      executing.resolve();
      return finishExecution.promise;
    },
  });
  const proposal = await service.propose("expiry-race", email);
  const originalGet = db.get.bind(db);
  let intercept = true;
  t.mock.method(db, "get", async (...args: Parameters<Store["get"]>) => {
    const result = await originalGet(...args);
    if (intercept && args[0] === "expiry-race" && args[1] === "actions") {
      intercept = false;
      read.resolve();
      await resumeRead.promise;
    }
    return result;
  });
  const stale = service.decide("expiry-race", proposal.id, proposal.hash, "approve");
  await read.promise;
  const approval = service.decide("expiry-race", proposal.id, proposal.hash, "approve");
  await executing.promise;
  now += 31 * 60 * 1000;
  resumeRead.resolve();
  await stale.catch((error) => assert.match(error.message, /expired/i));
  const saved = await db.get<ActionProposal>("expiry-race", "actions", proposal.id);
  finishExecution.resolve("sent");
  await approval;
  assert.equal(saved?.status, "executing");
});

test("a task cancelled between claim and execution never reaches the provider", async (t) => {
  let calls = 0;
  const service = new ActionService(db, {
    execute: async () => {
      calls++;
      return "sent";
    },
    connected: async () => true,
  });
  const proposal = await service.propose("cancel-race", email, undefined, "task-1");
  await db.put("cancel-race", "tasks", { id: "task-1", status: "running" });
  const originalClaim = db.claim.bind(db);
  let intercept = true;
  t.mock.method(db, "claim", async (...args: Parameters<Store["claim"]>) => {
    const result = await originalClaim(...args);
    if (intercept && args[0] === "cancel-race") {
      intercept = false;
      // Inject the race: the task is cancelled after the claim commits, before execute runs.
      await db.compareAndSwap(
        "cancel-race",
        "tasks",
        "task-1",
        { status: "running" },
        { status: "cancelled" },
      );
    }
    return result;
  });
  await assert.rejects(
    service.decide("cancel-race", proposal.id, proposal.hash, "approve"),
    /resume the task/i,
  );
  assert.equal(calls, 0);
  const saved = await db.get<ActionProposal>("cancel-race", "actions", proposal.id);
  assert.equal(saved?.status, "awaiting_review");
});
