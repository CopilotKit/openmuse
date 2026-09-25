/**
 * Honest activity presentation.
 *
 * One pure projection: raw activity records and run events go in, honest
 * display records come out. Nonzero-exit work is shown as **failed**, never
 * as "tool completed"; routine operational noise is hidden from progress
 * surfaces; the same projection feeds the mascot state.
 *
 * Rules:
 * - Read-only transforms only: raw records are never mutated (spreads only)
 *   and are preserved server-side for audit.
 * - `detail`/`title` are untrusted (model summaries, email subjects, page
 *   titles): they are passed through as text and never executed or
 *   interpolated. Secret-shaped values are redacted before display because
 *   activity syncs to devices.
 * - Unknown statuses pass through fail-open: they render with a prettified
 *   label instead of crashing.
 * - No model calls, no new dependencies, no CopilotKit cloud.
 */

import type { RunEvent } from "./agent.ts";
import type { ActivityEntry } from "./index.ts";

/**
 * Normalized, honest display status. `failed` covers every failure shape:
 * failed/error records, nonzero exit codes, `{ error }` result shapes, and
 * computer receipts that are failed/timed_out/interrupted.
 */
export type HonestStatus =
  | "succeeded"
  | "failed"
  | "executing"
  | "awaiting_review"
  | "outcome_unknown"
  | "denied"
  | "cancelled"
  | "expired"
  | "unknown";

/** Mascot states the activity projection may produce. Every member exists in
 * the mobile `MascotState` registry (`apps/mobile/src/mascot-state.ts`); no
 * new mascot states are invented here. */
export type ActivityMascotState =
  | "idle"
  | "thinking"
  | "searching"
  | "reading"
  | "writing"
  | "coding"
  | "uploading"
  | "awaiting_approval"
  | "success"
  | "error";

/** Projected activity record: the raw record plus honest display fields. */
export interface ProjectedActivityEntry extends ActivityEntry {
  /** Honest machine status: nonzero-exit work is "failed", never "succeeded". */
  honestStatus: HonestStatus;
  /** Human label, e.g. "Needs review". */
  label: string;
  /** Tool name when derivable from the raw record; drives the mascot. */
  toolName?: string;
}

/** Projected run event: the raw event plus honest display fields. */
export interface ProjectedRunEvent extends RunEvent {
  honestStatus: HonestStatus;
  label: string;
  toolName?: string;
}

export interface RoutineContext {
  /** A later record in the same action/task scope replaced this one. */
  superseded: boolean;
  /** An identical record exists; this copy is not the latest. */
  duplicate: boolean;
}

export interface RoutinePattern {
  /** Stable id used in debug logs and tests. */
  id: string;
  /** Human-readable description for audits. */
  description: string;
  test: (
    record: { title: string; detail: string; kind?: string; toolName?: string },
    context: RoutineContext,
  ) => boolean;
}

/**
 * Explicit, auditable list of routine operational noise hidden from progress
 * surfaces. This is a hand-maintained allowlist — never ML, never heuristic
 * scoring. Hidden records are reported through `ProjectionOptions.onHidden`
 * so a buried real failure stays visible in incident review.
 *
 * Note: hidden here means "not shown on progress surfaces". A record whose
 * honest status is `failed` is still projected as failed before the routine
 * filter runs; the debug log line carries that status.
 */
export const ROUTINE_PATTERNS: ReadonlyArray<RoutinePattern> = [
  {
    id: "subagent-progress-ping",
    description: "collect_subagents progress pings",
    test: (record) => /collect_subagents/i.test(`${record.toolName ?? ""} ${record.title}`),
  },
  {
    id: "status-poll",
    description: "computer_status / agent_status polls",
    test: (record) =>
      /\b(computer_status|agent_status)\b/i.test(`${record.toolName ?? ""} ${record.title}`),
  },
  {
    id: "browser-session-inspection",
    description: "browser_list_sessions inspections",
    test: (record) => /\bbrowser_list_sessions\b/i.test(`${record.toolName ?? ""} ${record.title}`),
  },
  {
    id: "duplicate-step",
    description: "exact duplicate steps (same kind, title and detail); earliest copies hidden",
    test: (_record, context) => context.duplicate,
  },
  {
    id: "superseded-started-working",
    description: "a 'Started working' event superseded by a later event in the same task scope",
    test: (record, context) => context.superseded && /\bstarted? working\b/i.test(record.title),
  },
];

export interface HiddenRecord {
  id: string;
  title: string;
  /** ROUTINE_PATTERNS id, or "action-collapse" for structural later-wins drops. */
  pattern: string;
  honestStatus: HonestStatus;
}

export interface ProjectionOptions {
  /**
   * Called for every record filtered out of a progress surface, at the
   * caller's chosen log level (debug on the server). This is the audit trail
   * that keeps a buried real failure visible in incident review.
   */
  onHidden?: (hidden: HiddenRecord) => void;
}

/** True when a tool result receipt reports failure rather than success. */
export function isFailureReceipt(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (receipt.error !== undefined && receipt.error !== null && receipt.error !== "") return true;
  if (typeof receipt.exitCode === "number" && receipt.exitCode !== 0) return true;
  if (
    typeof receipt.status === "string" &&
    ["failed", "error", "timed_out", "interrupted"].includes(receipt.status.toLowerCase())
  )
    return true;
  return false;
}

// Matches `key=value`, `key: value`, `"key": "value"` and `Bearer <token>` shapes.
const SECRET_PAIR =
  /([\w.-]*(?:password|passwd|pwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?key|client[_-]?secret|session[_-]?token)[\w.-]*)\s*(["']?\s*[:=])\s*(".*?"|'.*?'|\S+)/gi;
const BEARER_TOKEN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*"?/gi;

/**
 * Redact secret-shaped values from free text before it is projected to a
 * display surface. Activity syncs to devices, so a failed `browser_login`
 * must never carry more than its label.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return text.replace(SECRET_PAIR, "$1$2[redacted]").replace(BEARER_TOKEN, "$1 [redacted]");
}

const FAILED_STATUSES = new Set(["failed", "error", "timed_out", "interrupted"]);
const KNOWN_STATUSES: Record<string, Exclude<HonestStatus, "unknown">> = {
  succeeded: "succeeded",
  executing: "executing",
  awaiting_review: "awaiting_review",
  outcome_unknown: "outcome_unknown",
  denied: "denied",
  cancelled: "cancelled",
  expired: "expired",
};

const STATUS_LABELS: Record<Exclude<HonestStatus, "unknown">, string> = {
  succeeded: "Done",
  failed: "Failed",
  executing: "In progress",
  awaiting_review: "Needs review",
  outcome_unknown: "Outcome unknown",
  denied: "Denied",
  cancelled: "Cancelled",
  expired: "Expired",
};

function prettifyStatus(raw: string): string {
  const words = raw.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unknown";
}

/** Parse an embedded JSON receipt out of a detail string, if it looks like one. */
function receiptFromDetail(detail: string): unknown {
  const trimmed = detail.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function honestStatus(
  rawStatus: string,
  detail: string,
  record: unknown,
): { status: HonestStatus; label: string } {
  const raw = rawStatus.trim().toLowerCase();
  if (
    FAILED_STATUSES.has(raw) ||
    isFailureReceipt(record) ||
    isFailureReceipt(receiptFromDetail(detail))
  )
    return { status: "failed", label: STATUS_LABELS.failed };
  const known = KNOWN_STATUSES[raw];
  if (known) return { status: known, label: STATUS_LABELS[known] };
  // Fail-open display: unknown statuses render, never crash.
  return { status: "unknown", label: prettifyStatus(rawStatus) };
}

function toolNameOf(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const fields = record as Record<string, unknown>;
  if (typeof fields.toolName === "string" && fields.toolName) return fields.toolName;
  if (typeof fields.tool === "string" && fields.tool) return fields.tool;
  return undefined;
}

/** Project one raw activity record into its honest display form. */
export function projectActivityEntry(entry: ActivityEntry): ProjectedActivityEntry {
  const { status, label } = honestStatus(entry.status, entry.detail, entry);
  return {
    ...entry,
    detail: redactSecrets(entry.detail),
    honestStatus: status,
    label,
    toolName: toolNameOf(entry),
  };
}

const RUN_EVENT_STATUS: Record<RunEvent["kind"], string> = {
  error: "failed",
  result: "succeeded",
  approval: "awaiting_review",
  plan: "executing",
  step: "executing",
  observation: "executing",
  status: "executing",
};

/** Project one raw run event into its honest display form. */
export function projectRunEvent(event: RunEvent): ProjectedRunEvent {
  const { status, label } = honestStatus(
    RUN_EVENT_STATUS[event.kind] ?? "unknown",
    event.detail,
    event,
  );
  return {
    ...event,
    detail: redactSecrets(event.detail),
    honestStatus: status,
    label,
    toolName: toolNameOf(event),
  };
}

function matchRoutinePattern(
  record: { id: string; title: string; detail: string; kind?: string; toolName?: string },
  projected: { honestStatus: HonestStatus },
  context: RoutineContext,
  options: ProjectionOptions | undefined,
): boolean {
  for (const pattern of ROUTINE_PATTERNS) {
    if (pattern.test(record, context)) {
      options?.onHidden?.({
        id: record.id,
        title: record.title,
        pattern: pattern.id,
        honestStatus: projected.honestStatus,
      });
      return true;
    }
  }
  return false;
}

function compareDateAsc(a: { date: string }, b: { date: string }): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
}

/**
 * Project a full activity list. Later records with the same `actionId` win:
 * `actions.record()` writes one row per lifecycle transition ("Ready for your
 * review" → "Approved; execution started" → final outcome) and only the
 * latest is shown. Routine noise is filtered via ROUTINE_PATTERNS.
 */
export function projectActivityEntries(
  entries: readonly ActivityEntry[],
  options?: ProjectionOptions,
): ProjectedActivityEntry[] {
  const byDate = entries.map(projectActivityEntry).sort(compareDateAsc);
  const latestByAction = new Map<string, ProjectedActivityEntry>();
  for (const entry of byDate) {
    if (entry.actionId) latestByAction.set(entry.actionId, entry);
  }
  const seen = new Set<string>();
  const visible: ProjectedActivityEntry[] = [];
  // Walk latest-first so duplicate detection and action collapse keep the
  // newest copy; the output is re-sorted oldest-first at the end.
  for (const entry of [...byDate].reverse()) {
    if (entry.actionId && latestByAction.get(entry.actionId) !== entry) {
      // Structural later-wins: an earlier lifecycle row for this action loses.
      // Still logged so a buried failure stays visible in incident review.
      options?.onHidden?.({
        id: entry.id,
        title: entry.title,
        pattern: "action-collapse",
        honestStatus: entry.honestStatus,
      });
      continue;
    }
    const duplicateKey = `${entry.actionId ?? ""}\n${entry.title}\n${entry.detail}\n${entry.honestStatus}`;
    const duplicate = seen.has(duplicateKey);
    if (!duplicate) seen.add(duplicateKey);
    if (matchRoutinePattern(entry, entry, { superseded: false, duplicate }, options)) continue;
    visible.push(entry);
  }
  return visible.sort(compareDateAsc);
}

/**
 * Project a task's run events for the timeline. Steps are the timeline's
 * content and are kept; routine inspections, duplicate steps and superseded
 * "Started working" events are hidden.
 */
export function projectRunEvents(
  events: readonly RunEvent[],
  options?: ProjectionOptions,
): ProjectedRunEvent[] {
  const byDate = events.map(projectRunEvent).sort(compareDateAsc);
  const latestByTask = new Map<string, ProjectedRunEvent>();
  for (const event of byDate) latestByTask.set(event.taskId, event);
  const seen = new Set<string>();
  const visible: ProjectedRunEvent[] = [];
  for (const event of [...byDate].reverse()) {
    const superseded = latestByTask.get(event.taskId) !== event;
    const duplicateKey = `${event.taskId}\n${event.kind}\n${event.title}\n${event.detail}`;
    const duplicate = seen.has(duplicateKey);
    if (!duplicate) seen.add(duplicateKey);
    if (matchRoutinePattern(event, event, { superseded, duplicate }, options)) continue;
    visible.push(event);
  }
  return visible.sort(compareDateAsc);
}

// Keyword hints mapping in-flight work to a mascot state. The text is
// lowercased with separators normalized first, so `import_pdf` matches
// /\bimport\b/ while "Important" does not.
const WORK_HINTS: ReadonlyArray<[RegExp, ActivityMascotState]> = [
  [/\b(upload|import|attach)\b/, "uploading"],
  [/\b(write|fill|save|create|prepare|draft|send|compose)\b/, "writing"],
  [/\b(computer|shell|terminal|exec|command|code|run|script)\b/, "coding"],
  [/\b(search|lookup|find)\b/, "searching"],
  [/\b(read|inspect|observe|fetch|open|list)\b/, "reading"],
];

function mascotForWork(record: { title: string; toolName?: string }): ActivityMascotState {
  const text = `${record.toolName ?? ""} ${record.title}`.toLowerCase().replace(/[_-]+/g, " ");
  for (const [pattern, state] of WORK_HINTS) {
    if (pattern.test(text)) return state;
  }
  return "thinking";
}

/**
 * Map projected activity to a mascot state. Precedence: unacknowledged
 * failed/error → `error`; work awaiting review → `awaiting_approval`;
 * in-flight meaningful work → thinking/searching/reading/writing/coding/
 * uploading (derived from tool name); clean finish → `success`; otherwise
 * `idle`.
 *
 * Only records inside the recency window drive the mascot; a record older
 * than `recentMs` is stale and ignored. A transient (executing /
 * awaiting_review) only counts while it is the latest record in its scope —
 * a step followed by a result for the same task is finished work, not
 * in-flight work. A failure counts while it is the latest in its scope
 * ("unacknowledged"); a later success in the same scope clears it.
 *
 * Returns only states from the shared registry; never encodes sensitive
 * detail (generic `error`, never "failed login to bank").
 */
export function deriveMascotState(
  records: readonly (ProjectedActivityEntry | ProjectedRunEvent)[],
  now: number = Date.now(),
  recentMs: number = 10 * 60 * 1000,
): ActivityMascotState {
  const recent = records.filter((record) => {
    const at = Date.parse(record.date);
    return Number.isFinite(at) && at <= now && now - at <= recentMs;
  });
  if (!recent.length) return "idle";
  const scopeOf = (record: (typeof recent)[number]): string => {
    if ("taskId" in record && record.taskId) return `task:${record.taskId}`;
    if ("actionId" in record && record.actionId) return `action:${record.actionId}`;
    return `record:${record.id}`;
  };
  const latestByScope = new Map<string, (typeof recent)[number]>();
  for (const record of recent) {
    const key = scopeOf(record);
    const previous = latestByScope.get(key);
    if (!previous || record.date >= previous.date) latestByScope.set(key, record);
  }
  const current = [...latestByScope.values()];
  if (current.some((record) => record.honestStatus === "failed")) return "error";
  if (current.some((record) => record.honestStatus === "awaiting_review"))
    return "awaiting_approval";
  const working = current
    .filter((record) => record.honestStatus === "executing")
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  if (working.length) return mascotForWork(working[0]);
  const latest = recent.reduce((a, b) => (a.date >= b.date ? a : b));
  if (latest.honestStatus === "succeeded") return "success";
  return "idle";
}

/**
 * Short, redacted, single-purpose summary for an error event emitted when a
 * tool resolves with a failure receipt. Raw receipts stay server-side; this
 * is all a progress surface ever sees.
 */
export function describeFailureReceipt(toolName: string, receipt: unknown): string {
  const fields =
    typeof receipt === "object" && receipt !== null ? (receipt as Record<string, unknown>) : {};
  if (typeof fields.exitCode === "number" && fields.exitCode !== 0)
    return `${toolName} exited with code ${fields.exitCode}`;
  if (typeof fields.error === "string" && fields.error)
    return redactSecrets(fields.error).slice(0, 300);
  return `${toolName} reported a failure`;
}
