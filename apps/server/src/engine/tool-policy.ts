/**
 * Before-tool-call policy chain.
 *
 * Every agent tool call passes through evaluateToolPolicy() AFTER its
 * arguments are parsed and BEFORE its execute handler runs. Stages run in a
 * FIXED order and the first verdict wins by category: the first `deny` wins
 * outright (later stages never run), otherwise the first `requireApproval`
 * wins unless a valid owner approval upgrades it, otherwise the call is
 * allowed.
 *
 * Ordering is behavior: loopAdmission (run interlocks) always runs before
 * trustedPolicies (deterministic classification), which runs before approvals
 * (recognizing an owner grant), which runs before hooks (connectors may only
 * narrow), with finalOwnerApproval as the paranoid default. Reordering stages
 * changes what the agent is allowed to do; do not reorder.
 *
 * Zero model calls anywhere in this module: classification is deterministic.
 * Tool names are matched EXACTLY — no prefixes, no regex — so a tool named
 * `run_computer_command_evil` can never inherit the rules for
 * `run_computer_command`. It is unknown, and unknown tools are denied.
 *
 * Mutation safety: approveToolCall() pins sha256(canonicalize({ toolName,
 * args, owner, binding })) at owner-approval time; assertToolCallApproved()
 * re-hashes the exact call at the execution call site and throws 409 on any
 * mismatch (the TOCTOU param-swap vector, e.g. approving { command: "ls",
 * cwd: "/workspace" } then executing with cwd: "/etc"). Tokens live in
 * server memory only — never in tool results, chat text, or persisted
 * records. Logs carry tool names and verdicts only, never args.
 */

import { createHash, randomUUID } from "node:crypto";
import type { ToolDefinition } from "@copilotkit/runtime/v2";
import { AppError } from "../errors.ts";

export interface ToolCallContext {
  owner: string;
  toolName: string;
  args: unknown;
  scope: string;
  taskId?: string;
  threadId?: string;
  sessionId?: string;
  /** Owner + task/thread + browser session binding, e.g. "task:abc:session-1". */
  binding?: string;
  /**
   * Chat turn identity (the per-message request key). Recorded on pending
   * approvals so a presented call stays bound to the turn that presented it.
   * Callers with no turn concept (the delegated worker) leave it undefined.
   */
  turnKey?: string;
  /** Set when the run loop already finished or was aborted; stage 1 denies. */
  loopClosed?: boolean;
  signal?: AbortSignal;
  /**
   * True only when the user's OWN message (never page/email content) said
   * log in / sign in / login. Checked in code — prompt text is forgeable.
   */
  userLoginWords?: boolean;
  /**
   * True only when the user's OWN message (never page/email content) gave an
   * explicit instruction to send an email ("send an email to…", "email this
   * to…"). Checked in code — prompt text is forgeable. Authorizes email_send
   * directly: the same precedent as userLoginWords for browser_login.
   */
  userExplicitSend?: boolean;
  /**
   * True only when the user's OWN message (never page/email content) gave an
   * explicit instruction to clear the chat history ("clear history",
   * "delete our chat", ...). Checked in code — prompt text is forgeable.
   */
  userClearHistoryWords?: boolean;
  /**
   * True only when the user's OWN latest message (never page/email content)
   * contained explicit approval words ("yes", "send it", "approved", ...).
   * Checked in code — prompt text is forgeable. Alone it authorizes nothing:
   * the approvals stage additionally requires a pending-approval record for
   * the exact tool call, recorded when the agent was told the call needs
   * approval earlier in the same thread.
   */
  ownerApprovalWords?: boolean;
  /**
   * Resolves a calendar event's current attendees for the confirmation gate
   * (calendar.update/delete act on the stored event, not just the patch).
   * Returns undefined when the event cannot be read — the gate then fails
   * closed and requires approval.
   */
  resolveEventAttendees?: (args: unknown) => Promise<readonly string[] | undefined>;
  /**
   * Resolves the current page URL of the browser session named in a
   * browser_input call, for the sensitive-page gate. Returns undefined when
   * the session cannot be read — the gate then fails closed and requires
   * owner approval.
   */
  resolveBrowserPageUrl?: (args: unknown) => Promise<string | undefined>;
  /** Server-minted approval token for this exact call, when the owner approved. */
  approvalToken?: string;
  /** Per-connector beforeToolCall hooks; each may only narrow the verdict. */
  hooks?: ToolCallHook[];
  /**
   * Set while the agent follows a loaded skill: only these tool names may
   * run (the skill's `allowed-tools` intersected with the registered
   * toolset). `read_skill` itself is always exempt so the agent can load
   * another skill. Restriction only — never widens the toolset.
   */
  activeSkillTools?: readonly string[];
}

export type PolicyVerdict =
  | { kind: "allow" }
  | { kind: "deny"; reason: string; code?: string }
  | { kind: "requireApproval"; reason: string };

/**
 * A per-connector `beforeToolCall` hook, exported from the connector's own
 * folder. Hooks see possibly-injected args as data only and may only NARROW
 * the pending verdict (allow -> requireApproval -> deny); widening is
 * refused by narrowVerdict().
 */
export type ToolCallHook = (
  ctx: ToolCallContext,
  pending: PolicyVerdict | undefined,
) => PolicyVerdict | undefined | Promise<PolicyVerdict | undefined>;

export type PolicyStage = (
  ctx: ToolCallContext,
  pending: PolicyVerdict | undefined,
) => PolicyVerdict | undefined | Promise<PolicyVerdict | undefined>;

/** The user's own login words, matched against their actual message. */
const LOGIN_WORDS = /\b(?:log[\s-]?in|sign[\s-]?in)\b/i;

export function userSaidLogin(text: unknown): boolean {
  return typeof text === "string" && LOGIN_WORDS.test(text);
}

/** The user's own explicit approval words, matched against their actual message. */
const APPROVAL_WORDS =
  /\b(?:yes|yeah|yep|approve(?:d| it)?|send it|go ahead|do it|confirm(?:ed)?|looks good)\b/i;

export function userSaidApprove(text: unknown): boolean {
  return typeof text === "string" && APPROVAL_WORDS.test(text);
}

/**
 * The user's own explicit instruction to send an email ("send an email
 * to…", "email this to…", "send it to…"). "Send me …" (the user asking to
 * receive something), negations, and did-you-send questions never count.
 * Checked against the user's actual message only — page or email content
 * can never authorize a send.
 */
const SEND_WORDS =
  /(?:\bsend\b[^.!?]{0,80}\be-?mail\b|\be-?mail\b[^.!?]{0,80}\bto\b|\bsend\s+(?:it|this|them)\s+to\b)/i;
const NOT_SEND_WORDS =
  /\b(?:send\s+me\b|do\s*n'?t\s+send\b|do\s+not\s+send\b|never\s+send\b|did\s+(?:you|it)\s+send\b|have\s+you\s+sent\b)/i;

export function userSaidSend(text: unknown): boolean {
  if (typeof text !== "string") return false;
  if (NOT_SEND_WORDS.test(text)) return false;
  return SEND_WORDS.test(text);
}

/**
 * The user's own explicit instruction to clear the chat history ("clear
 * history", "delete our chat", "start fresh"). Negations and did-you-clear
 * questions never count. Checked against the user's actual message only —
 * page or email content can never authorize a clear.
 */
const CLEAR_HISTORY_WORDS =
  /\b(?:clear|delete|erase|wipe|forget)\b[^.!?]{0,60}\b(?:chat|conversation|history|messages)\b|\bstart\s+(?:a\s+)?fresh\b/i;
const NOT_CLEAR_HISTORY_WORDS =
  /\b(?:do\s*n'?t\s+(?:clear|delete|erase|wipe|forget)\b|do\s+not\s+(?:clear|delete|erase|wipe|forget)\b|never\s+(?:clear|delete|erase|wipe|forget)\b|did\s+(?:you|it)\s+(?:clear|delete|erase|wipe)\b|have\s+you\s+cleared\b)/i;

export function userSaidClearHistory(text: unknown): boolean {
  if (typeof text !== "string") return false;
  if (NOT_CLEAR_HISTORY_WORDS.test(text)) return false;
  return CLEAR_HISTORY_WORDS.test(text);
}

/**
 * Deterministic JSON: sorted keys, undefined-valued keys dropped (so an
 * explicit `undefined` hashes exactly like a missing property), arrays kept
 * in order. Key order can never change the digest.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

function hashToolCall(input: {
  toolName: string;
  args: unknown;
  owner: string;
  binding: string;
}): string {
  return createHash("sha256")
    .update(
      canonicalize({
        toolName: input.toolName,
        args: input.args,
        owner: input.owner,
        binding: input.binding,
      }),
    )
    .digest("hex");
}

interface ApprovalRecord {
  digest: string;
  toolName: string;
  owner: string;
  binding: string;
  expiresAt: number;
}

/**
 * Server-side approval tokens. Minted by the app layer when the owner
 * approves a specific tool call (durable worker: after a waiting_approval
 * action is decided; chat: via the native approval surface). One-time use,
 * 10-minute TTL. Never serialized into tool results, chat text, or records.
 */
const approvalTokens = new Map<string, ApprovalRecord>();
const APPROVAL_TTL_MS = 10 * 60 * 1000;

export function approveToolCall(input: {
  toolName: string;
  args: unknown;
  owner: string;
  binding: string;
  ttlMs?: number;
}): string {
  const token = randomUUID();
  approvalTokens.set(token, {
    digest: hashToolCall(input),
    toolName: input.toolName,
    owner: input.owner,
    binding: input.binding,
    expiresAt: Date.now() + (input.ttlMs ?? APPROVAL_TTL_MS),
  });
  return token;
}

/**
 * Re-hashes the exact call about to execute and compares it with the digest
 * pinned at approval time. The token is consumed before comparing so a failed
 * check cannot be retried with tweaked args. Throws a 409 AppError on any
 * mismatch — unknown/expired token, different tool, owner, binding, or args.
 */
export function assertToolCallApproved(input: {
  token: string;
  toolName: string;
  args: unknown;
  owner: string;
  binding: string;
}): void {
  const record = approvalTokens.get(input.token);
  if (!record || record.expiresAt <= Date.now()) {
    approvalTokens.delete(input.token);
    throw new AppError("Tool approval is missing or expired; ask the owner to approve again.", 409);
  }
  approvalTokens.delete(input.token);
  if (
    record.toolName !== input.toolName ||
    record.owner !== input.owner ||
    record.binding !== input.binding ||
    record.digest !== hashToolCall(input)
  ) {
    throw new AppError("The approved tool call changed after approval.", 409);
  }
}

/**
 * Pending owner approvals, keyed by owner + thread (stable across chat turns;
 * the per-turn requestKey inside `binding` is not). A record is written when
 * the policy tells the agent a call needs owner approval, and consumed when
 * the owner's own message approves it.
 *
 * The record pins sha256(canonicalize({ toolName, args })) — the SAME digest
 * the approval token pins — so the owner's "yes" can only ever authorize the
 * exact call the agent presented, never a rephrased or re-targeted variant.
 * Records are one-time use with a 10-minute TTL and live in server memory
 * only, like approval tokens.
 */
interface PendingApproval {
  digest: string;
  expiresAt: number;
  /** Turn that presented the call. Undefined when the caller has no turn concept (the worker). */
  turn?: string;
}

const pendingApprovals = new Map<string, PendingApproval[]>();
const PENDING_TTL_MS = 10 * 60 * 1000;

function pendingKey(ctx: ToolCallContext): string {
  return `${ctx.owner}\n${ctx.threadId ?? ctx.taskId ?? ctx.scope}`;
}

function pendingDigest(ctx: ToolCallContext): string {
  // Binding is deliberately excluded: it embeds the per-turn requestKey,
  // while the pending record must survive from the presenting turn to the
  // approving turn. Owner + thread scope the record instead.
  return hashToolCall({ toolName: ctx.toolName, args: ctx.args, owner: ctx.owner, binding: "" });
}

function recordPendingApproval(ctx: ToolCallContext): void {
  if (!OWNER_APPROVABLE_TOOLS.has(ctx.toolName)) return;
  const key = pendingKey(ctx);
  const now = Date.now();
  const digest = pendingDigest(ctx);
  const live = (pendingApprovals.get(key) ?? []).filter((record) => record.expiresAt > now);
  // Re-presenting the same call refreshes the TTL but keeps the ORIGINAL turn
  // binding.
  const previous = live.find((record) => record.digest === digest);
  const kept = live.filter((record) => record.digest !== digest);
  kept.push({ digest, expiresAt: now + PENDING_TTL_MS, turn: previous?.turn ?? ctx.turnKey });
  pendingApprovals.set(key, kept);
}

/**
 * Consumes the pending record for this exact call. Returns false when there
 * is no live record — the owner's approval words then authorize nothing.
 */
function consumePendingApproval(ctx: ToolCallContext): boolean {
  const key = pendingKey(ctx);
  const list = pendingApprovals.get(key);
  if (!list) return false;
  const now = Date.now();
  const digest = pendingDigest(ctx);
  const matched = list.find((record) => record.digest === digest && record.expiresAt > now);
  // Expired records go away on every attempt, whether or not one matched.
  const kept = list.filter((record) => record.expiresAt > now);
  if (!matched) {
    if (kept.length) pendingApprovals.set(key, kept);
    else pendingApprovals.delete(key);
    return false;
  }
  kept.splice(kept.indexOf(matched), 1);
  if (kept.length) pendingApprovals.set(key, kept);
  else pendingApprovals.delete(key);
  return true;
}

// ---------------------------------------------------------------------------
// Stage 2 classification sets. Exact tool names only.
// ---------------------------------------------------------------------------

/** Read-only tools: no state changes, always allowed. */
const READONLY_TOOLS = new Set([
  "agent_status",
  "browse_web",
  "browser_list_sessions",
  "browser_snapshot",
  "browser_read",
  "browser_screenshot",
  "collect_subagents",
  "whatsapp_search_recent",
  "computer_status",
  "inspect_pdf",
  "list_computer_files",
  "read_computer_file",
  "mailbox_read",
  "mailbox_search",
  "email_accounts_list",
  "read_mail_thread",
  "read_skill",
  "read_web",
  "read_workspace",
  "search_mail",
]);

/**
 * Standard agent tools that run freely today: planning, delegation, review
 * flows (prepare_email/prepare_event run their own ActionService review),
 * and user-confirmed mutations. Behavior-preserving allow list.
 */
const STANDARD_TOOLS = new Set([
  "ask_user",
  "browser_close_session",
  "create_goal",
  "delegate_task",
  "fill_pdf",
  "finish_task",
  "import_pdf",
  "prepare_email",
  "prepare_event",
  "remember_fact",
  "save_artifact",
  "set_plan",
  "spawn_subagents",
  "start_computer",
  "stop_computer",
  "watch_page",
  "whatsapp_send",
  "workboard_create_card",
  "workboard_dispatch",
  "workboard_move_card",
]);

/** Writes allowed only when confined under /workspace; otherwise gated. */
const WORKSPACE_WRITE_TOOLS = new Set([
  "export_computer_pdf",
  "import_computer_pdf",
  "mkdir_computer",
  "write_computer_file",
]);

/** Owner-approval-gated tools. Never auto-approved by any stage. */
const APPROVAL_TOOLS = new Set([
  "browser_login",
  "email send",
  "run_computer_command",
  "schedule_job",
]);

/** Calendar tools: gated only when the call would notify attendees. */
const CALENDAR_TOOLS = new Set(["calendar_create", "calendar_update", "calendar_delete"]);

/**
 * Tools whose execution can send mail to someone else. A requireApproval
 * verdict for one of these records a pending approval (see the ledger above)
 * so the owner's own approval words can authorize the exact presented call.
 */
const EXTERNAL_SEND_TOOLS = new Set(["email_send", ...CALENDAR_TOOLS]);

/** Tools whose requireApproval verdict records a pending owner approval. */
const OWNER_APPROVABLE_TOOLS = new Set([
  ...EXTERNAL_SEND_TOOLS,
  // Tiered-gated browser_input calls (sensitive pages, Enter, codes) stay
  // approvable in chat, so the owner can authorize the exact presented call.
  "browser_input",
]);

// ---------------------------------------------------------------------------
// Tiered browser_input policy: ordinary page interactions run free; only the
// sensitive ones need the owner. Deterministic — URL patterns plus the action
// and typed-text shapes, no model calls.
// ---------------------------------------------------------------------------

/**
 * Page URL fragments where a click, keypress or typed text could spend money,
 * move credentials, or transmit data externally: checkout/payment, auth and
 * account pages, and messaging/compose surfaces.
 */
const BROWSER_SENSITIVE_URL =
  /checkout|check-?out|\/cart\b|\border\b|\bpay\b|payment|billing|login|log-?in|sign-?in|sign-?up|register|\/account|password|passkey|forgot|verify|otp|\b2fa\b|two-?factor|\bmfa\b|oauth|sso|\/authorize|\/consent|subscribe|donate|transfer|wallet|whatsapp\.com|\/compose|\/contact|\/message|\/dm\b|\/chat|\/post|\/share|\/tweet|\/comment|\/review/i;

/** Typed text shaped like a one-time verification code (e.g. "123456", "123-456"). */
const BROWSER_SENSITIVE_TEXT = /^\s*\d{3,4}[-\s]?\d{3,4}\s*$/;

/**
 * Tiered verdict for browser_input. Auto-allowed: click, scroll, select, and
 * ordinary typing or keypresses on ordinary pages. Requires owner approval:
 * pressing Enter (it submits the focused form), typing verification-code-
 * shaped text, any interaction on a sensitive page (purchase, auth,
 * messaging — see BROWSER_SENSITIVE_URL), or when the page URL cannot be
 * resolved (fail closed).
 */
async function browserInputVerdict(ctx: ToolCallContext): Promise<PolicyVerdict> {
  const args = (ctx.args ?? {}) as { type?: unknown; text?: unknown; key?: unknown };
  const action = typeof args.type === "string" ? args.type : "";
  if (action === "key" && args.key === "Enter") {
    return {
      kind: "requireApproval",
      reason: "browser_input pressing Enter submits the focused form; owner approval is required.",
    };
  }
  if (
    action === "type" &&
    typeof args.text === "string" &&
    BROWSER_SENSITIVE_TEXT.test(args.text)
  ) {
    return {
      kind: "requireApproval",
      reason: "browser_input typing a verification code; owner approval is required.",
    };
  }
  let url: string | undefined;
  try {
    url = await ctx.resolveBrowserPageUrl?.(ctx.args);
  } catch {
    url = undefined;
  }
  if (typeof url !== "string" || url.length === 0) {
    return {
      kind: "requireApproval",
      reason: "browser_input could not resolve the page URL; owner approval is required.",
    };
  }
  if (BROWSER_SENSITIVE_URL.test(url)) {
    return {
      kind: "requireApproval",
      reason:
        "browser_input on a sensitive page (checkout, payment, login, account or messaging); owner approval is required.",
    };
  }
  return { kind: "allow" };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * The attendee list a calendar tool call would notify. For create it comes
 * from the args; for update/delete an explicit non-empty patch list wins,
 * otherwise the stored event's attendees apply (even a title change notifies
 * them on both the Google and local paths). Returns undefined when the
 * attendees cannot be determined — the gate then fails closed.
 */
async function effectiveAttendees(
  ctx: ToolCallContext,
  name: string,
): Promise<readonly string[] | undefined> {
  const args = (ctx.args ?? {}) as { attendees?: unknown };
  if (name === "calendar_create") return stringArray(args.attendees);
  const patch = stringArray(args.attendees);
  if (patch.length > 0) return patch;
  return ctx.resolveEventAttendees?.(ctx.args);
}

function isWorkspacePath(path: unknown): boolean {
  return typeof path === "string" && (path === "/workspace" || path.startsWith("/workspace/"));
}

/** Stage 1 — run finished/aborted guards. Never approval. */
export function loopAdmission(ctx: ToolCallContext): PolicyVerdict | undefined {
  if (ctx.loopClosed) {
    return {
      kind: "deny",
      code: "paused",
      reason: "The task is waiting or finished; do not perform more actions.",
    };
  }
  if (ctx.signal?.aborted) {
    return { kind: "deny", reason: "The run was aborted; no further tool calls are allowed." };
  }
  return undefined;
}

/** Stage 2 — deterministic, zero-AI classification by exact tool name. */
/** Stage 2 — deterministic, zero-AI classification by exact tool name. */
export async function trustedPolicies(ctx: ToolCallContext): Promise<PolicyVerdict | undefined> {
  const name = ctx.toolName;
  // A loaded skill's allowed-tools narrows the toolset: anything outside the
  // intersection is denied. Only applies while a skill set the restriction
  // (never widens); read_skill stays available so the agent can load a
  // different skill, whose allowed-tools then replace the restriction.
  if (ctx.activeSkillTools && name !== "read_skill" && !ctx.activeSkillTools.includes(name)) {
    return {
      kind: "deny",
      reason: `Skill restriction: "${name}" is outside this skill's allowed-tools.`,
    };
  }
  if (READONLY_TOOLS.has(name)) return { kind: "allow" };
  if (STANDARD_TOOLS.has(name)) return { kind: "allow" };
  if (WORKSPACE_WRITE_TOOLS.has(name)) {
    const path = (ctx.args as { path?: unknown } | null)?.path;
    if (isWorkspacePath(path)) return { kind: "allow" };
    return {
      kind: "requireApproval",
      reason: `${name} targets a path outside /workspace.`,
    };
  }
  if (name === "browser_login") {
    // The website saved-login feature: the user's own "log in" words in their
    // actual message are the authorization — checked here in code, never in
    // prompt text (page/email content could forge that). The server-side
    // domain-match rule still applies inside the credentials service.
    if (ctx.userLoginWords) return { kind: "allow" };
    return {
      kind: "requireApproval",
      reason: "browser_login needs the user's own log-in request or an owner approval.",
    };
  }
  if (name === "email_send") {
    // The user's own explicit "send an email" instruction in their message is
    // the authorization — checked here in code, never in prompt text (page or
    // email content could forge that). Same precedent as browser_login's
    // userLoginWords above. Without it, the owner-approval dance still
    // applies: the agent presents the draft and re-calls after approval.
    if (ctx.userExplicitSend) return { kind: "allow" };
    return { kind: "requireApproval", reason: "email_send is owner-approval-gated." };
  }
  if (name === "chat_clear_history") {
    // The user's own explicit "clear history" instruction in their message is
    // the authorization — checked here in code, never in prompt text (page or
    // email content could forge that). Same precedent as browser_login's
    // userLoginWords and email_send's userExplicitSend. Without it, the
    // owner-approval dance still applies: the agent presents the call and
    // re-calls after approval.
    if (ctx.userClearHistoryWords) return { kind: "allow" };
    return { kind: "requireApproval", reason: "chat_clear_history is owner-approval-gated." };
  }
  if (name === "browser_input") {
    return browserInputVerdict(ctx);
  }
  if (APPROVAL_TOOLS.has(name)) {
    return { kind: "requireApproval", reason: `${name} is owner-approval-gated.` };
  }
  if (CALENDAR_TOOLS.has(name)) {
    // Calendar calls are gated only when they would notify attendees.
    // email.send, which always sends, is in APPROVAL_TOOLS above and never
    // reaches this branch.
    const attendees = await effectiveAttendees(ctx, name);
    if (attendees === undefined || attendees.length > 0) {
      return {
        kind: "requireApproval",
        reason: `${name} would notify attendees; owner approval is required.`,
      };
    }
    return { kind: "allow" };
  }
  return { kind: "deny", reason: `Unknown tool "${name}" is denied by default.` };
}

/**
 * Stage 3 — recognize a valid owner approval, in either of two forms:
 *
 * 1. A server-minted approval token (approveToolCall), re-hashed against the
 *    exact call (mutation check), allow.
 * 2. The owner's own approval words in their latest message PLUS a live
 *    pending-approval record for this exact call — recorded when the policy
 *    required approval for it earlier in the same thread. One-time use: the
 *    record is consumed here.
 *
 * Never auto-approves: without a token or a matching pending record this
 * stage decides nothing, including for blocklisted tools. Approval words in
 * page or email content never reach here (ctx.ownerApprovalWords is set from
 * the user's own message only, in code).
 */
export function approvals(ctx: ToolCallContext): PolicyVerdict | undefined {
  if (ctx.approvalToken) {
    assertToolCallApproved({
      token: ctx.approvalToken,
      toolName: ctx.toolName,
      args: ctx.args,
      owner: ctx.owner,
      binding: ctx.binding ?? "",
    });
    return { kind: "allow" };
  }
  if (ctx.ownerApprovalWords && consumePendingApproval(ctx)) {
    return { kind: "allow" };
  }
  return undefined;
}

function verdictRank(verdict: PolicyVerdict): number {
  return verdict.kind === "deny" ? 2 : verdict.kind === "requireApproval" ? 1 : 0;
}

/**
 * Hooks may only narrow: allow -> requireApproval -> deny. A hook can never
 * widen (deny -> allow is refused), and when nothing was decided yet a hook
 * may only set a restrictive verdict, never allow.
 */
export function narrowVerdict(
  current: PolicyVerdict | undefined,
  next: PolicyVerdict | undefined,
): PolicyVerdict | undefined {
  if (!next) return current;
  if (!current) return next.kind === "allow" ? undefined : next;
  return verdictRank(next) >= verdictRank(current) ? next : current;
}

/** Stage 4 — per-connector beforeToolCall hooks (narrowing only). */
export async function hooksStage(
  ctx: ToolCallContext,
  pending: PolicyVerdict | undefined,
): Promise<PolicyVerdict | undefined> {
  let current = pending;
  for (const hook of ctx.hooks ?? []) {
    current = narrowVerdict(current, await hook(ctx, current));
  }
  return current;
}

/**
 * Stage 5 — final owner approval. Anything still undecided is gated: the app
 * layer runs the approval procedure (durable worker: propose an action and
 * pause with waiting_approval; chat: the native approval surface) and mints
 * a token via approveToolCall() when the owner approves.
 */
export function finalOwnerApproval(
  ctx: ToolCallContext,
  pending: PolicyVerdict | undefined,
): PolicyVerdict | undefined {
  if (pending) return pending;
  return {
    kind: "requireApproval",
    reason: `${ctx.toolName} is not classified by policy; owner approval is required.`,
  };
}

/** The five stages in fixed order. Ordering is behavior — do not reorder. */
export const POLICY_STAGES: readonly PolicyStage[] = [
  loopAdmission,
  trustedPolicies,
  approvals,
  hooksStage,
  finalOwnerApproval,
];

/**
 * Runs the stages in fixed order. The first `deny` wins immediately (later
 * stages never run); otherwise the first `requireApproval`/`allow` is
 * recorded, a later stage may only NARROW it (allow -> requireApproval ->
 * deny), and a valid owner approval (stage 3) may upgrade a pending
 * requireApproval to allow.
 *
 * A final requireApproval verdict for an external-send tool additionally
 * records a pending approval (one-time, 10-minute TTL) so the owner's own
 * approval words in a later message can authorize the exact presented call.
 */
export async function evaluateToolPolicy(
  ctx: ToolCallContext,
  stages: readonly PolicyStage[] = POLICY_STAGES,
): Promise<PolicyVerdict> {
  let pending: PolicyVerdict | undefined;
  for (const stage of stages) {
    const verdict = await stage(ctx, pending);
    if (!verdict) continue;
    if (verdict.kind === "deny") return verdict;
    if (!pending) {
      pending = verdict;
      continue;
    }
    if (verdictRank(verdict) > verdictRank(pending)) {
      pending = verdict; // narrowing only: a later stage can tighten, never loosen
    } else if (
      stage === approvals &&
      verdict.kind === "allow" &&
      pending.kind === "requireApproval"
    ) {
      pending = verdict; // a valid owner approval lifts the gate
    }
  }
  const result = pending ?? { kind: "allow" };
  if (result.kind === "requireApproval") recordPendingApproval(ctx);
  return result;
}

// ---------------------------------------------------------------------------
// Wiring helpers (shared by the chat and worker tool wrappers).
// ---------------------------------------------------------------------------

/** Base policy context a wrapper fills in; per-call fields are added inside. */
export interface PolicyBase {
  owner: string;
  scope: string;
  taskId?: string;
  threadId?: string;
  userLoginWords?: boolean;
  /**
   * True only when the user's OWN message gave an explicit instruction to
   * send an email. Chat wrappers set this from the user's actual message
   * text; the worker path leaves it unset (fail closed).
   */
  userExplicitSend?: boolean;
  /**
   * True only when the user's OWN message gave an explicit instruction to
   * clear the chat history. Chat wrappers set this from the user's actual
   * message text; the worker path leaves it unset (fail closed).
   */
  userClearHistoryWords?: boolean;
  /**
   * True only when the user's OWN latest message contained approval words.
   * Chat wrappers set this from the user's actual message text; the worker
   * path leaves it unset (its approvals go through ActionService decisions).
   */
  ownerApprovalWords?: boolean;
  /**
   * Chat turn identity (see ToolCallContext.turnKey): the chat wrapper sets it
   * from the per-message request key, and `withPolicy` forwards it. The
   * worker leaves it unset.
   */
  turnKey?: string;
  /**
   * Resolves a calendar event's current attendees for the confirmation gate.
   * Chat wrappers provide it; the worker path leaves it unset (fail closed).
   */
  resolveEventAttendees?: (args: unknown) => Promise<readonly string[] | undefined>;
  /**
   * Resolves the current page URL of the browser session in a browser_input
   * call. Chat wrappers provide it; the worker path leaves it unset (fail
   * closed).
   */
  resolveBrowserPageUrl?: (args: unknown) => Promise<string | undefined>;
  approvalToken?: string;
  hooks?: ToolCallHook[];
  signal?: AbortSignal;
  loopClosed?: boolean;
  /**
   * Set while the agent follows a loaded skill: only these tool names may
   * run (the skill's `allowed-tools` intersected with the registered
   * toolset). Propagated into every tool call by withPolicy().
   */
  activeSkillTools?: readonly string[];
}

/** Approval binding: owner + task/thread + browser session id. */
export function bindingOf(input: {
  scope: string;
  taskId?: string;
  threadId?: string;
  sessionId?: string;
}): string {
  return [input.scope, input.threadId ?? input.taskId ?? "", input.sessionId ?? ""]
    .filter((part) => part.length > 0)
    .join(":");
}

export function sessionIdOf(args: unknown): string | undefined {
  if (args !== null && typeof args === "object") {
    const sessionId = (args as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === "string" && sessionId.length > 0) return sessionId;
  }
  return undefined;
}

/** The `{ error }` message for a non-allow verdict. Never includes args. */
export function policyError(
  toolName: string,
  verdict: Exclude<PolicyVerdict, { kind: "allow" }>,
): string {
  if (verdict.kind === "deny") return `Policy denied ${toolName}: ${verdict.reason}`;
  return `${toolName} requires owner approval before it can run: ${verdict.reason}`;
}

async function parseStandard(schema: unknown, value: unknown): Promise<unknown> {
  const standard = (schema as { "~standard"?: { validate: (v: unknown) => unknown } } | null)?.[
    "~standard"
  ];
  if (!standard) return value;
  const result = (await standard.validate(value)) as { issues?: unknown[]; value?: unknown };
  if (result.issues) throw new Error("Invalid tool arguments");
  return result.value;
}

/**
 * Wraps a tool definition so its execute runs the policy chain after
 * argument parsing and before the real handler. On deny/unapproved the
 * existing `{ error }` shape is returned and the handler never runs.
 * Tools without an execute handler are returned unchanged.
 */
export function withPolicy(tool: ToolDefinition, base: PolicyBase): ToolDefinition {
  const inner = tool.execute;
  if (!inner) return tool;
  return {
    ...tool,
    execute: async (rawArgs: unknown) => {
      let parsed: unknown;
      try {
        parsed = await parseStandard(tool.parameters, rawArgs);
      } catch {
        // Let the tool report its own validation error, unchanged.
        return inner(rawArgs);
      }
      const sessionId = sessionIdOf(parsed);
      let verdict: PolicyVerdict;
      try {
        verdict = await evaluateToolPolicy({
          ...base,
          toolName: tool.name,
          args: parsed,
          sessionId,
          binding: bindingOf({
            scope: base.scope,
            taskId: base.taskId,
            threadId: base.threadId,
            sessionId,
          }),
        });
      } catch (error) {
        // A failed approval check (e.g. 409 on a tampered token) surfaces as
        // the existing { error } shape, like the other wrappers.
        return { error: error instanceof Error ? error.message : "Policy check failed" };
      }
      if (verdict.kind !== "allow") return { error: policyError(tool.name, verdict) };
      return inner(rawArgs);
    },
  };
}
