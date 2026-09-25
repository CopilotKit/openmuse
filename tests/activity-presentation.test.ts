import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveMascotState,
  describeFailureReceipt,
  type HiddenRecord,
  isFailureReceipt,
  type ProjectedActivityEntry,
  projectActivityEntries,
  projectActivityEntry,
  projectRunEvent,
  projectRunEvents,
  ROUTINE_PATTERNS,
  redactSecrets,
} from "../packages/domain/src/activity-presentation.ts";
import type { RunEvent } from "../packages/domain/src/agent.ts";
import type { ActivityEntry } from "../packages/domain/src/index.ts";

let seq = 0;
const minute = 60_000;
const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

function entry(over: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: `entry-${++seq}`,
    title: "Do a thing",
    detail: "done",
    date: iso(-minute),
    status: "succeeded",
    ...over,
  };
}

function runEvent(over: Partial<RunEvent> = {}): RunEvent {
  return {
    id: `event-${++seq}`,
    taskId: "task-1",
    date: iso(-minute),
    kind: "step",
    title: "Working",
    detail: "",
    ...over,
  };
}

function hiddenSpy() {
  const calls: HiddenRecord[] = [];
  return { calls, onHidden: (h: HiddenRecord) => calls.push(h) };
}

test("nonzero exit codes project to failed; zero stays succeeded", () => {
  for (const code of [1, 124, 137]) {
    const projected = projectActivityEntry(
      entry({ detail: JSON.stringify({ exitCode: code, stdout: "x".repeat(10) }) }),
    );
    assert.equal(projected.honestStatus, "failed", `exit code ${code}`);
    assert.equal(projected.label, "Failed");
  }
  const ok = projectActivityEntry(entry({ detail: JSON.stringify({ exitCode: 0 }) }));
  assert.equal(ok.honestStatus, "succeeded");
});

test("isFailureReceipt detects { error } shapes, exit codes and computer receipts", () => {
  assert.equal(isFailureReceipt({ error: "boom" }), true);
  assert.equal(isFailureReceipt({ error: { message: "boom" } }), true);
  assert.equal(isFailureReceipt({ exitCode: 1 }), true);
  assert.equal(isFailureReceipt({ exitCode: 124 }), true);
  assert.equal(isFailureReceipt({ exitCode: 137 }), true);
  assert.equal(isFailureReceipt({ status: "failed" }), true);
  assert.equal(isFailureReceipt({ status: "timed_out" }), true);
  assert.equal(isFailureReceipt({ status: "interrupted" }), true);
  assert.equal(isFailureReceipt({ exitCode: 0 }), false);
  assert.equal(isFailureReceipt({ error: "" }), false);
  assert.equal(isFailureReceipt({ error: null }), false);
  assert.equal(isFailureReceipt({ ok: true }), false);
  assert.equal(isFailureReceipt(null), false);
  assert.equal(isFailureReceipt("failed"), false);
  assert.equal(isFailureReceipt([1]), false);
});

test("{ error } shape in detail projects to failed", () => {
  const projected = projectActivityEntry(entry({ detail: JSON.stringify({ error: "nope" }) }));
  assert.equal(projected.honestStatus, "failed");
});

test("timed_out / interrupted project to failed", () => {
  assert.equal(projectActivityEntry(entry({ status: "timed_out" })).honestStatus, "failed");
  assert.equal(projectActivityEntry(entry({ status: "interrupted" })).honestStatus, "failed");
  assert.equal(
    projectActivityEntry(entry({ detail: JSON.stringify({ status: "timed_out" }) })).honestStatus,
    "failed",
  );
});

test("routine patterns are hidden from progress surfaces", () => {
  const spy = hiddenSpy();
  const visible = projectActivityEntries(
    [
      entry({ title: "computer_status" }),
      entry({ title: "agent_status" }),
      entry({ title: "browser_list_sessions" }),
      entry({ title: "collect_subagents progress ping" }),
      entry({ title: "Send the email" }),
    ],
    spy,
  );
  assert.equal(visible.length, 1);
  assert.equal(visible[0].title, "Send the email");
  const patterns = spy.calls.map((c) => c.pattern).sort();
  assert.deepEqual(patterns, [
    "browser-session-inspection",
    "status-poll",
    "status-poll",
    "subagent-progress-ping",
  ]);
});

test("ROUTINE_PATTERNS is an explicit auditable list", () => {
  const ids = ROUTINE_PATTERNS.map((p) => p.id).sort();
  assert.deepEqual(ids, [
    "browser-session-inspection",
    "duplicate-step",
    "status-poll",
    "subagent-progress-ping",
    "superseded-started-working",
  ]);
  for (const pattern of ROUTINE_PATTERNS) {
    assert.ok(pattern.description.length > 0, pattern.id);
  }
});

test("actionId collapse keeps only the latest record (later wins)", () => {
  const spy = hiddenSpy();
  const visible = projectActivityEntries(
    [
      entry({
        actionId: "a1",
        status: "awaiting_review",
        date: iso(-3 * minute),
        title: "Send email",
      }),
      entry({ actionId: "a1", status: "executing", date: iso(-2 * minute), title: "Send email" }),
      entry({
        actionId: "a1",
        status: "succeeded",
        date: iso(-minute),
        title: "Send email",
        detail: "sent",
      }),
      entry({ actionId: "a2", status: "failed", date: iso(-minute), title: "Other" }),
    ],
    spy,
  );
  assert.equal(visible.length, 2);
  const collapsed = visible.find((v) => v.actionId === "a1");
  assert.ok(collapsed);
  assert.equal(collapsed.honestStatus, "succeeded");
  assert.equal(collapsed.detail, "sent");
  assert.equal(collapsed.label, "Done");
  // The two superseded lifecycle rows are logged, not silently dropped.
  assert.equal(spy.calls.filter((c) => c.pattern === "action-collapse").length, 2);
});

test("awaiting_review normalizes to 'Needs review'", () => {
  const projected = projectActivityEntry(entry({ status: "awaiting_review" }));
  assert.equal(projected.honestStatus, "awaiting_review");
  assert.equal(projected.label, "Needs review");
});

test("unknown statuses pass through fail-open without crashing", () => {
  const projected = projectActivityEntry(entry({ status: "mystery_state" }));
  assert.equal(projected.honestStatus, "unknown");
  assert.equal(projected.label, "Mystery state");
  const run = projectRunEvent(runEvent({ kind: "step", title: "x", detail: "y" }));
  assert.equal(run.honestStatus, "executing");
});

test("run event kinds map honestly; error kind is failed", () => {
  assert.equal(projectRunEvent(runEvent({ kind: "error" })).honestStatus, "failed");
  assert.equal(projectRunEvent(runEvent({ kind: "result" })).honestStatus, "succeeded");
  assert.equal(projectRunEvent(runEvent({ kind: "approval" })).honestStatus, "awaiting_review");
  assert.equal(projectRunEvent(runEvent({ kind: "step" })).honestStatus, "executing");
  assert.equal(projectRunEvent(runEvent({ kind: "plan" })).honestStatus, "executing");
});

test("duplicate steps are hidden; the latest copy survives", () => {
  const spy = hiddenSpy();
  const visible = projectRunEvents(
    [
      runEvent({ title: "Read the inbox", detail: "3 messages", date: iso(-3 * minute) }),
      runEvent({ title: "Read the inbox", detail: "3 messages", date: iso(-2 * minute) }),
      runEvent({ title: "Draft the reply", detail: "", date: iso(-minute) }),
    ],
    spy,
  );
  assert.equal(visible.length, 2);
  assert.equal(visible[0].title, "Read the inbox");
  assert.equal(visible[0].date, iso(-2 * minute)); // the latest copy survives
  assert.equal(visible[1].title, "Draft the reply");
  assert.ok(spy.calls.some((c) => c.pattern === "duplicate-step"));
});

test("superseded 'Started working' events are hidden", () => {
  const spy = hiddenSpy();
  const visible = projectRunEvents(
    [
      runEvent({ kind: "step", title: "Started working", date: iso(-3 * minute) }),
      runEvent({ kind: "step", title: "Read the inbox", date: iso(-2 * minute) }),
      runEvent({ kind: "result", title: "Finished", date: iso(-minute) }),
    ],
    spy,
  );
  assert.ok(!visible.some((v) => v.title === "Started working"));
  assert.ok(spy.calls.some((c) => c.pattern === "superseded-started-working"));
  // Non-started-working steps are the timeline's content and are kept.
  assert.ok(visible.some((v) => v.title === "Read the inbox"));
});

test("secret-shaped values are redacted from detail before projecting", () => {
  const projected = projectActivityEntry(
    entry({ detail: "login failed: password=hunter2 for the account" }),
  );
  assert.ok(!projected.detail.includes("hunter2"));
  assert.ok(projected.detail.includes("[redacted]"));
  assert.equal(
    redactSecrets('tried {"api_key": "abc123"} twice'),
    'tried {"api_key":[redacted]} twice',
  );
  assert.equal(
    redactSecrets("Authorization: Bearer xyz.abc.def"),
    "Authorization: Bearer [redacted]",
  );
  // Ordinary prose is untouched.
  assert.equal(
    redactSecrets("Signed in to example.com in a browser session"),
    "Signed in to example.com in a browser session",
  );
});

test("projection never mutates the raw record", () => {
  const raw = entry({ detail: "password=hunter2" });
  const before = raw.detail;
  projectActivityEntry(raw);
  projectActivityEntries([raw]);
  assert.equal(raw.detail, before);
});

test("describeFailureReceipt is short, generic and redacted", () => {
  assert.equal(
    describeFailureReceipt("computer_exec", { exitCode: 1 }),
    "computer_exec exited with code 1",
  );
  const long = describeFailureReceipt("read_web", {
    error: `nope password=secret ${"x".repeat(500)}`,
  });
  assert.ok(long.length <= 300);
  assert.ok(!long.includes("secret"));
  assert.equal(describeFailureReceipt("fill_pdf", { ok: false }), "fill_pdf reported a failure");
});

function projectedEntries(...overrides: Partial<ActivityEntry>[]): ProjectedActivityEntry[] {
  return overrides.map((over, i) =>
    projectActivityEntry(entry({ date: iso(-(i + 1) * minute), ...over })),
  );
}

test("deriveMascotState: error outranks working outranks idle", () => {
  assert.equal(deriveMascotState([], now), "idle");
  const working = projectedEntries({ status: "executing", title: "Read the inbox" });
  assert.equal(deriveMascotState(working, now), "reading");
  const failed = projectedEntries({ status: "failed", title: "Send email" });
  assert.equal(deriveMascotState(failed, now), "error");
  assert.equal(deriveMascotState([...failed, ...working], now), "error");
  assert.equal(deriveMascotState(projectedEntries({ status: "succeeded" }), now), "success");
});

test("deriveMascotState maps in-flight work from tool names", () => {
  assert.equal(
    deriveMascotState(projectedEntries({ status: "executing", title: "import_pdf" }), now),
    "uploading",
  );
  assert.equal(
    deriveMascotState(projectedEntries({ status: "executing", title: "fill_pdf" }), now),
    "writing",
  );
  assert.equal(
    deriveMascotState(projectedEntries({ status: "executing", title: "computer_exec" }), now),
    "coding",
  );
  assert.equal(
    deriveMascotState(projectedEntries({ status: "executing", title: "web_search" }), now),
    "searching",
  );
  assert.equal(
    deriveMascotState(projectedEntries({ status: "executing", title: "do something vague" }), now),
    "thinking",
  );
  // "Important" must not match the import hint.
  assert.equal(
    deriveMascotState(
      projectedEntries({ status: "executing", title: "Important meeting notes" }),
      now,
    ),
    "thinking",
  );
  assert.equal(
    deriveMascotState(projectedEntries({ status: "awaiting_review" }), now),
    "awaiting_approval",
  );
});

test("deriveMascotState ignores stale records", () => {
  const stale = projectedEntries({
    status: "executing",
    title: "Read the inbox",
    date: iso(-60 * minute),
  });
  assert.equal(deriveMascotState(stale, now), "idle");
  const staleFailure = projectedEntries({
    status: "failed",
    title: "Old failure",
    date: iso(-60 * minute),
  });
  assert.equal(deriveMascotState(staleFailure, now), "idle");
});

test("deriveMascotState: a step superseded by a result is finished, not in-flight", () => {
  const projected = projectRunEvents([
    runEvent({ kind: "step", title: "Read the inbox", date: iso(-2 * minute) }),
    runEvent({ kind: "result", title: "Finished", date: iso(-minute) }),
  ]);
  assert.equal(projected.length, 2); // timeline keeps both
  assert.equal(deriveMascotState(projected, now), "success");
});

test("deriveMascotState: unacknowledged error in a task scope surfaces as error", () => {
  const projected = projectRunEvents([
    runEvent({ kind: "step", title: "Read the inbox", date: iso(-2 * minute) }),
    runEvent({ kind: "error", title: "read_web failed", date: iso(-minute) }),
  ]);
  assert.equal(deriveMascotState(projected, now), "error");
});
