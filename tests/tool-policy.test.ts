import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolDefinition } from "@copilotkit/runtime/v2";
import { z } from "zod";
import {
  approvals,
  approveToolCall,
  assertToolCallApproved,
  bindingOf,
  canonicalize,
  evaluateToolPolicy,
  finalOwnerApproval,
  hooksStage,
  loopAdmission,
  narrowVerdict,
  POLICY_STAGES,
  type PolicyStage,
  type PolicyVerdict,
  policyError,
  type ToolCallContext,
  type ToolCallHook,
  trustedPolicies,
  userSaidClearHistory,
  userSaidLogin,
  userSaidSend,
  withPolicy,
} from "../apps/server/src/engine/tool-policy.ts";
import { AppError } from "../apps/server/src/errors.ts";

function ctx(toolName: string, extra: Partial<ToolCallContext> = {}): ToolCallContext {
  return { owner: "owner-1", toolName, args: {}, scope: "test", ...extra };
}

function is409(error: unknown): boolean {
  return error instanceof AppError && error.status === 409;
}

// ---------------------------------------------------------------------------
// Stage ordering
// ---------------------------------------------------------------------------

test("ordering: the first deny wins even when a later stage allows", async () => {
  const deny: PolicyStage = () => ({ kind: "deny", reason: "blocked" });
  const allow: PolicyStage = () => ({ kind: "allow" });
  let ran = false;
  const spy: PolicyStage = () => {
    ran = true;
    return { kind: "allow" };
  };
  const verdict = await evaluateToolPolicy(ctx("anything"), [deny, allow, spy]);
  assert.equal(verdict.kind, "deny");
  assert.equal(ran, false, "stages after a deny must not run");
});

test("ordering: requireApproval is recorded before hooks run, and hooks cannot widen it", async () => {
  let seenPending: PolicyVerdict | undefined;
  const wideningHook: ToolCallHook = (_hookCtx, pending) => {
    seenPending = pending;
    return { kind: "allow" }; // tries to widen: must be refused
  };
  const verdict = await evaluateToolPolicy(
    ctx("run_computer_command", {
      args: { command: "ls", cwd: "/workspace" },
      hooks: [wideningHook],
    }),
  );
  assert.equal(seenPending?.kind, "requireApproval");
  assert.equal(verdict.kind, "requireApproval");
});

test("default stage order is loopAdmission, trustedPolicies, approvals, hooks, finalOwnerApproval", () => {
  assert.deepEqual(POLICY_STAGES, [
    loopAdmission,
    trustedPolicies,
    approvals,
    hooksStage,
    finalOwnerApproval,
  ]);
});

// ---------------------------------------------------------------------------
// trustedPolicies classification
// ---------------------------------------------------------------------------

test("unknown tool names are denied (exact match, no prefix smuggling)", async () => {
  for (const name of ["run_computer_command_evil", "browser-login", "Search_Mail", ""]) {
    const verdict = await evaluateToolPolicy(ctx(name));
    assert.equal(verdict.kind, "deny", name);
    assert.match(policyError(name, verdict as Exclude<PolicyVerdict, { kind: "allow" }>), /denied/);
  }
});

test("read-only tools are allowed", async () => {
  for (const name of ["search_mail", "read_mail_thread", "collect_subagents", "computer_status"]) {
    assert.equal((await evaluateToolPolicy(ctx(name))).kind, "allow", name);
  }
});

test("run_computer_command, schedule_job and 'email send' require approval", async () => {
  for (const name of ["run_computer_command", "schedule_job", "email send"]) {
    const verdict = await evaluateToolPolicy(ctx(name));
    assert.equal(verdict.kind, "requireApproval", name);
  }
});

test("path-confined writes under /workspace are allowed, elsewhere gated", async () => {
  const allowed = await evaluateToolPolicy(
    ctx("write_computer_file", { args: { path: "/workspace/notes.md", text: "hi" } }),
  );
  assert.equal(allowed.kind, "allow");
  const gated = await evaluateToolPolicy(
    ctx("write_computer_file", { args: { path: "/etc/passwd", text: "hi" } }),
  );
  assert.equal(gated.kind, "requireApproval");
  const missing = await evaluateToolPolicy(ctx("mkdir_computer", { args: {} }));
  assert.equal(missing.kind, "requireApproval");
});

test("browser_login: the user's own login words allow, anything else gates", async () => {
  const loginCtx = (words: boolean) =>
    ctx("browser_login", { args: { sessionId: "s1" }, userLoginWords: words });
  assert.equal((await evaluateToolPolicy(loginCtx(true))).kind, "allow");
  assert.equal((await evaluateToolPolicy(loginCtx(false))).kind, "requireApproval");
  assert.equal((await evaluateToolPolicy(loginCtx(undefined as never))).kind, "requireApproval");
});

test("userSaidLogin matches the user's own words, not lookalikes", () => {
  assert.equal(userSaidLogin("please log in to the portal"), true);
  assert.equal(userSaidLogin("can you sign-in for me?"), true);
  assert.equal(userSaidLogin("LOGIN"), true);
  assert.equal(userSaidLogin("the catalog is here"), false);
  assert.equal(userSaidLogin("blogging about signage"), false);
  assert.equal(userSaidLogin(undefined), false);
  assert.equal(userSaidLogin(42), false);
});

test("loopAdmission denies closed loops and aborted runs, never approves", async () => {
  const paused = await evaluateToolPolicy(ctx("search_mail", { loopClosed: true }));
  assert.equal(paused.kind, "deny");
  assert.equal((paused as { code?: string }).code, "paused");
  const controller = new AbortController();
  controller.abort();
  const aborted = await evaluateToolPolicy(ctx("search_mail", { signal: controller.signal }));
  assert.equal(aborted.kind, "deny");
  assert.equal((aborted as { code?: string }).code, undefined);
});

// ---------------------------------------------------------------------------
// Mutation safety: approveToolCall / assertToolCallApproved
// ---------------------------------------------------------------------------

test("mutation: approving {command, cwd} then swapping cwd throws 409", () => {
  const token = approveToolCall({
    toolName: "run_computer_command",
    args: { command: "ls", cwd: "/workspace" },
    owner: "owner-1",
    binding: "task:t1",
  });
  assert.throws(
    () =>
      assertToolCallApproved({
        token,
        toolName: "run_computer_command",
        args: { command: "ls", cwd: "/etc" },
        owner: "owner-1",
        binding: "task:t1",
      }),
    is409,
  );
});

test("mutation: shuffled key order still passes", () => {
  const token = approveToolCall({
    toolName: "run_computer_command",
    args: { cwd: "/workspace", command: "ls", operationId: "op1" },
    owner: "owner-1",
    binding: "task:t1",
  });
  assert.doesNotThrow(() =>
    assertToolCallApproved({
      token,
      toolName: "run_computer_command",
      args: { operationId: "op1", command: "ls", cwd: "/workspace" },
      owner: "owner-1",
      binding: "task:t1",
    }),
  );
});

test("mutation: undefined-valued property hashes like a missing property", () => {
  assert.equal(canonicalize({ a: 1, b: undefined }), canonicalize({ a: 1 }));
  const token = approveToolCall({
    toolName: "search_mail",
    args: { query: "x", extra: undefined },
    owner: "owner-1",
    binding: "b",
  });
  assert.doesNotThrow(() =>
    assertToolCallApproved({
      token,
      toolName: "search_mail",
      args: { query: "x" },
      owner: "owner-1",
      binding: "b",
    }),
  );
});

test("mutation: token is bound to tool, owner and binding; single use; expiry", () => {
  const good = { toolName: "run_computer_command", args: { a: 1 }, owner: "o", binding: "b" };
  const wrongTool = approveToolCall(good);
  assert.throws(
    () => assertToolCallApproved({ ...good, token: wrongTool, toolName: "other" }),
    is409,
  );
  const wrongOwner = approveToolCall(good);
  assert.throws(
    () => assertToolCallApproved({ ...good, token: wrongOwner, owner: "mallory" }),
    is409,
  );
  const wrongBinding = approveToolCall(good);
  assert.throws(
    () => assertToolCallApproved({ ...good, token: wrongBinding, binding: "task:other" }),
    is409,
  );
  const unknown = approveToolCall(good);
  assert.throws(() => assertToolCallApproved({ ...good, token: `${unknown}-nope` }), is409);
  const expired = approveToolCall({ ...good, ttlMs: -1 });
  assert.throws(() => assertToolCallApproved({ ...good, token: expired }), is409);
  const once = approveToolCall(good);
  assert.doesNotThrow(() => assertToolCallApproved({ ...good, token: once }));
  assert.throws(() => assertToolCallApproved({ ...good, token: once }), is409);
});

// ---------------------------------------------------------------------------
// approvals stage: valid token upgrades requireApproval, never auto-approves
// ---------------------------------------------------------------------------

test("approvals: a valid owner token allows a blocklisted tool call", async () => {
  const args = { command: "ls", cwd: "/workspace", operationId: "op1" };
  const binding = bindingOf({ scope: "task:t1", taskId: "t1", threadId: "t1" });
  const token = approveToolCall({
    toolName: "run_computer_command",
    args,
    owner: "owner-1",
    binding,
  });
  const verdict = await evaluateToolPolicy(
    ctx("run_computer_command", { args, binding, approvalToken: token }),
  );
  assert.equal(verdict.kind, "allow");
});

test("approvals: blocklisted tools are never auto-approved without a token", async () => {
  const verdict = await evaluateToolPolicy(
    ctx("run_computer_command", { args: { command: "ls", cwd: "/workspace" } }),
  );
  assert.equal(verdict.kind, "requireApproval");
});

test("approvals: a token for different args throws 409 instead of allowing", async () => {
  const binding = "task:t1";
  const token = approveToolCall({
    toolName: "run_computer_command",
    args: { command: "ls", cwd: "/workspace" },
    owner: "owner-1",
    binding,
  });
  await assert.rejects(
    evaluateToolPolicy(
      ctx("run_computer_command", {
        args: { command: "rm -rf /", cwd: "/workspace" },
        binding,
        approvalToken: token,
      }),
    ),
    is409,
  );
});

// ---------------------------------------------------------------------------
// hooks narrowing rules
// ---------------------------------------------------------------------------

test("hooks can only narrow: allow->deny ok, deny->allow refused", () => {
  const allow: PolicyVerdict = { kind: "allow" };
  const deny: PolicyVerdict = { kind: "deny", reason: "x" };
  const gated: PolicyVerdict = { kind: "requireApproval", reason: "x" };
  assert.equal(narrowVerdict(allow, deny)?.kind, "deny");
  assert.equal(narrowVerdict(allow, gated)?.kind, "requireApproval");
  assert.equal(narrowVerdict(deny, allow)?.kind, "deny");
  assert.equal(narrowVerdict(gated, allow)?.kind, "requireApproval");
  assert.equal(narrowVerdict(deny, gated)?.kind, "deny");
  assert.equal(narrowVerdict(undefined, allow), undefined);
  assert.equal(narrowVerdict(undefined, deny)?.kind, "deny");
  assert.equal(narrowVerdict(allow, undefined)?.kind, "allow");
});

test("hooks stage applies connector hooks in order, narrowing only", async () => {
  const order: string[] = [];
  const hookA: ToolCallHook = (_c, _pending) => {
    order.push("a");
    return { kind: "requireApproval", reason: "connector wants review" };
  };
  const hookB: ToolCallHook = (_c, _pending) => {
    order.push("b");
    return { kind: "allow" }; // widening attempt: refused
  };
  const verdict = await evaluateToolPolicy(ctx("search_mail", { hooks: [hookA, hookB] }));
  assert.deepEqual(order, ["a", "b"]);
  assert.equal(verdict.kind, "requireApproval");
});

// ---------------------------------------------------------------------------
// withPolicy wrapper
// ---------------------------------------------------------------------------

function stubTool(name: string, schema: z.ZodType, calls: { count: number }): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    parameters: schema,
    execute: async (raw: unknown) => {
      calls.count += 1;
      try {
        schema.parse(raw);
      } catch (error) {
        return { error: error instanceof Error ? error.message : "bad args" };
      }
      return { ok: true };
    },
  };
}

test("withPolicy: deny/unapproved returns { error } and never runs the handler", async () => {
  const calls = { count: 0 };
  const wrapped = withPolicy(
    stubTool("run_computer_command", z.object({ command: z.string() }), calls),
    { owner: "o", scope: "s" },
  );
  const execute = wrapped.execute as (args: unknown) => Promise<unknown>;
  const result = (await execute({ command: "ls" })) as { error?: string };
  assert.match(result.error ?? "", /requires owner approval/);
  assert.equal(calls.count, 0);
});

test("withPolicy: allowed tools run the handler with the raw args", async () => {
  const calls = { count: 0 };
  const wrapped = withPolicy(stubTool("search_mail", z.object({ query: z.string() }), calls), {
    owner: "o",
    scope: "s",
  });
  const execute = wrapped.execute as (args: unknown) => Promise<unknown>;
  assert.deepEqual(await execute({ query: "hello" }), { ok: true });
  assert.equal(calls.count, 1);
});

test("withPolicy: unknown tool denied; invalid args keep the tool's own error", async () => {
  const calls = { count: 0 };
  const wrapped = withPolicy(stubTool("mystery_tool", z.object({}), calls), {
    owner: "o",
    scope: "s",
  });
  const execute = wrapped.execute as (args: unknown) => Promise<unknown>;
  const denied = (await execute({})) as { error?: string };
  assert.match(denied.error ?? "", /denied/);
  assert.equal(calls.count, 0);

  const strictCalls = { count: 0 };
  const strict = withPolicy(stubTool("search_mail", z.object({ query: z.string() }), strictCalls), {
    owner: "o",
    scope: "s",
  });
  const strictExecute = strict.execute as (args: unknown) => Promise<unknown>;
  // zod validation still fails inside the tool (not at the policy layer).
  const bad = (await strictExecute({ query: 42 })) as { error?: string };
  assert.ok(typeof bad.error === "string" && bad.error.length > 0);
  assert.equal(strictCalls.count, 1);
});

test("withPolicy: a tampered approval token surfaces as { error }, not a throw", async () => {
  const calls = { count: 0 };
  const token = approveToolCall({
    toolName: "run_computer_command",
    args: { command: "ls" },
    owner: "o",
    binding: "s",
  });
  const wrapped = withPolicy(
    stubTool("run_computer_command", z.object({ command: z.string() }), calls),
    {
      owner: "o",
      scope: "s",
      approvalToken: token,
    },
  );
  const execute = wrapped.execute as (args: unknown) => Promise<unknown>;
  // Same token, different args -> mutation check fails -> { error }.
  const result = (await execute({ command: "rm -rf /" })) as { error?: string };
  assert.match(result.error ?? "", /changed after approval/);
  assert.equal(calls.count, 0);
});

test("withPolicy: tools without an execute handler are returned unchanged", () => {
  const tool = { name: "x", description: "d", parameters: z.object({}) } as ToolDefinition;
  assert.equal(withPolicy(tool, { owner: "o", scope: "s" }), tool);
});

test("withPolicy: approved blocklisted call runs (browser_login login-auto flow)", async () => {
  const calls = { count: 0 };
  const login = withPolicy(stubTool("browser_login", z.object({ sessionId: z.string() }), calls), {
    owner: "o",
    scope: "chat:req1",
    threadId: "t1",
    userLoginWords: true,
  });
  const execute = login.execute as (args: unknown) => Promise<unknown>;
  assert.deepEqual(await execute({ sessionId: "sess-1" }), { ok: true });
  assert.equal(calls.count, 1);

  const gatedCalls = { count: 0 };
  const gated = withPolicy(
    stubTool("browser_login", z.object({ sessionId: z.string() }), gatedCalls),
    { owner: "o", scope: "chat:req1", threadId: "t1", userLoginWords: false },
  );
  const gatedExecute = gated.execute as (args: unknown) => Promise<unknown>;
  const result = (await gatedExecute({ sessionId: "sess-1" })) as { error?: string };
  assert.match(result.error ?? "", /requires owner approval/);
  assert.equal(gatedCalls.count, 0);
});

test("bindingOf binds owner scope, task/thread and browser session id", () => {
  assert.equal(
    bindingOf({ scope: "task:t1", taskId: "t1", threadId: "t1", sessionId: "s1" }),
    "task:t1:t1:s1",
  );
  assert.equal(bindingOf({ scope: "chat:r1" }), "chat:r1");
});

test("policyError never includes args", () => {
  const message = policyError("run_computer_command", {
    kind: "requireApproval",
    reason: "owner-approval-gated",
  });
  assert.ok(!message.includes("rm -rf"));
  assert.ok(message.includes("run_computer_command"));
});

test("browser tools: snapshot is read-only", async () => {
  assert.equal((await evaluateToolPolicy(ctx("browser_snapshot"))).kind, "allow");
});

test("browser_input is tiered: ordinary interactions allowed, sensitive ones gated", async () => {
  const page = (url: string | undefined, args: Record<string, unknown> = {}) => ({
    args: { sessionId: "s1", type: "click", x: 10, y: 10, ...args },
    resolveBrowserPageUrl: async () => url,
  });
  // Ordinary click on an ordinary page: allowed, no approval dance.
  assert.equal(
    (await evaluateToolPolicy(ctx("browser_input", page("https://example.com/article")))).kind,
    "allow",
  );
  // Ordinary typing and scrolling on an ordinary page: allowed.
  for (const args of [
    { type: "type", text: "hello world" },
    { type: "scroll", deltaY: 400 },
    { type: "key", key: "Tab" },
    { type: "select", option: "Large" },
  ]) {
    assert.equal(
      (await evaluateToolPolicy(ctx("browser_input", page("https://example.com/search", args))))
        .kind,
      "allow",
      JSON.stringify(args),
    );
  }
  // Fail closed when the page URL cannot be resolved.
  assert.equal(
    (await evaluateToolPolicy(ctx("browser_input", page(undefined)))).kind,
    "requireApproval",
  );
  // Sensitive pages: checkout, login, messaging.
  for (const url of [
    "https://shop.example.com/checkout",
    "https://example.com/cart",
    "https://example.com/login",
    "https://example.com/account/settings",
    "https://web.whatsapp.com/",
  ]) {
    assert.equal(
      (await evaluateToolPolicy(ctx("browser_input", page(url)))).kind,
      "requireApproval",
      url,
    );
  }
  // Enter submits the focused form: always gated, even on ordinary pages.
  assert.equal(
    (
      await evaluateToolPolicy(
        ctx("browser_input", page("https://example.com/", { type: "key", key: "Enter" })),
      )
    ).kind,
    "requireApproval",
  );
  // Verification-code-shaped typing: gated.
  assert.equal(
    (
      await evaluateToolPolicy(
        ctx("browser_input", page("https://example.com/", { type: "type", text: "482 913" })),
      )
    ).kind,
    "requireApproval",
  );
});

test("email_send: the user's own explicit send instruction authorizes it", async () => {
  const send = {
    args: { emailAccountId: "google", to: ["a@x.com"], subject: "s", body: "b" },
  };
  assert.equal(
    (await evaluateToolPolicy(ctx("email_send", { ...send, userExplicitSend: true }))).kind,
    "allow",
  );
  assert.equal((await evaluateToolPolicy(ctx("email_send", send))).kind, "requireApproval");
});

test("userSaidSend matches explicit send instructions, not lookalikes", () => {
  assert.ok(userSaidSend("Send an email to alexis@cr-apts.com about the account"));
  assert.ok(userSaidSend("can you send an email to Joe?"));
  assert.ok(userSaidSend("please email this to Joe"));
  assert.ok(userSaidSend("send it to the team"));
  assert.ok(!userSaidSend("send me the report"));
  assert.ok(!userSaidSend("don't send that email"));
  assert.ok(!userSaidSend("did you send the email?"));
  assert.ok(!userSaidSend("have you sent it yet?"));
  assert.ok(!userSaidSend(undefined));
});

test("chat_clear_history: the user's own explicit clear instruction authorizes it", async () => {
  assert.equal(
    (await evaluateToolPolicy(ctx("chat_clear_history", { userClearHistoryWords: true }))).kind,
    "allow",
  );
  assert.equal((await evaluateToolPolicy(ctx("chat_clear_history"))).kind, "requireApproval");
});

test("userSaidClearHistory matches explicit clear instructions, not lookalikes", () => {
  assert.ok(userSaidClearHistory("clear history"));
  assert.ok(userSaidClearHistory("please clear the chat history"));
  assert.ok(userSaidClearHistory("delete our chat"));
  assert.ok(userSaidClearHistory("forget this conversation"));
  assert.ok(userSaidClearHistory("start fresh"));
  assert.ok(!userSaidClearHistory("don't clear the chat"));
  assert.ok(!userSaidClearHistory("never delete our messages"));
  assert.ok(!userSaidClearHistory("did you clear the history?"));
  assert.ok(!userSaidClearHistory("have you cleared it yet?"));
  assert.ok(!userSaidClearHistory(undefined));
});
