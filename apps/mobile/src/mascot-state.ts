import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  deriveMascotState,
  type ProjectedActivityEntry,
} from "../../../packages/domain/src/activity-presentation";

/**
 * Tiny global store for the Muse Cat mascot's state. Each app surface reports
 * what it is really doing (chat awaiting a reply, terminal running a command,
 * a delegated task running on the server, …); the header cat renders the
 * highest-priority active state, and brief success/error flashes override
 * everything for ~1.5s. Driven by real state — never by timers alone.
 */
export type MascotState =
  | "idle"
  | "listening"
  | "thinking"
  | "searching"
  | "reading"
  | "pdf_review"
  | "writing"
  | "coding"
  | "uploading"
  | "dispatching"
  | "delegating"
  | "awaiting_approval"
  | "restarting_browser"
  | "clearing_history"
  | "success"
  | "error";

export type MascotSource = "chat" | "terminal" | "browser" | "upload" | "agent" | "maintenance";

/** Central status registry: the always-visible header label under the cat,
 * plus the matching animation the cat plays for that state. Add new
 * activity states here (and a matching eye-motion case in muse-cat.tsx) —
 * the header label and animations pick them up automatically. */
export interface MascotStatusInfo {
  /** Display text shown under the header cat. */
  label: string;
  /** Which animation the cat plays; must match a case in muse-cat.tsx. */
  animation: string;
}

export const MASCOT_COLORS: Record<MascotState, string> = {
  idle: "#94a3b8",
  listening: "#3b82f6",
  thinking: "#8b5cf6",
  searching: "#0ea5e9",
  reading: "#f59e0b",
  pdf_review: "#ea580c",
  writing: "#6366f1",
  coding: "#10b981",
  uploading: "#eab308",
  dispatching: "#6366f1",
  delegating: "#8b5cf6",
  awaiting_approval: "#f59e0b",
  restarting_browser: "#0ea5e9",
  clearing_history: "#94a3b8",
  success: "#10b981",
  error: "#ef4444",
};

export const MASCOT_STATUSES: Record<MascotState, MascotStatusInfo> = {
  idle: { label: "Ready", animation: "gentle drift, slow blink" },
  listening: { label: "Listening", animation: "eyes toward user, slow typing" },
  thinking: { label: "Thinking", animation: "eyes circle, quick blinks" },
  searching: { label: "Searching the web", animation: "eyes sweep side to side" },
  reading: { label: "Reading", animation: "eyes scan lines downward" },
  pdf_review: { label: "Reviewing PDF", animation: "eyes scan pages, quick pass" },
  writing: { label: "Writing", animation: "eyes down on laptop, fast typing" },
  coding: { label: "Coding", animation: "eyes dart, fastest typing" },
  uploading: { label: "Uploading", animation: "eyes look up" },
  dispatching: { label: "Dispatching team", animation: "eyes sweep wide, fast typing" },
  delegating: { label: "Delegating work", animation: "eyes to laptop, quick typing" },
  awaiting_approval: {
    label: "Waiting for approval",
    animation: "eyes look up, still, slow blink",
  },
  restarting_browser: { label: "Restarting browser", animation: "eyes spin fast, fastest typing" },
  clearing_history: { label: "Clearing history", animation: "eyes sweep down and away" },
  success: { label: "Done", animation: "sparkles" },
  error: { label: "Something went wrong", animation: "wobble, eyes dart side to side" },
};

/** Header label for a state; falls back to "Ready" for unknown values. */
export function mascotLabel(state: MascotState): string {
  return MASCOT_STATUSES[state]?.label ?? MASCOT_STATUSES.idle.label;
}

const PRIORITY: MascotState[] = [
  "error",
  "success",
  "awaiting_approval",
  "uploading",
  "restarting_browser",
  "clearing_history",
  "coding",
  "dispatching",
  "delegating",
  "searching",
  "writing",
  "reading",
  "pdf_review",
  "thinking",
  "listening",
  "idle",
];

const sources = new Map<MascotSource, MascotState>();
let flash: "success" | "error" | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
let snapshot: MascotState = "idle";

function current(): MascotState {
  if (flash) return flash;
  let best: MascotState = "idle";
  for (const state of sources.values()) {
    if (PRIORITY.indexOf(state) < PRIORITY.indexOf(best)) best = state;
  }
  return best;
}

function emit() {
  const next = current();
  if (next !== snapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
  }
}

/** Report what a surface is doing; pass "idle" when it goes quiet. */
export function setMascotSource(source: MascotSource, state: MascotState) {
  if (state === "idle") sources.delete(source);
  else sources.set(source, state);
  emit();
}

/** Brief success/error flash (e.g. a chat turn finished or failed). */
export function flashMascot(state: "success" | "error") {
  flash = state;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flash = null;
    flashTimer = null;
    emit();
  }, 1500);
  emit();
}

export function useMascotState(): MascotState {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    () => snapshot,
  );
}

/** Read the current resolved state outside React (tests, debugging). */
export function getMascotSnapshot(): MascotState {
  return snapshot;
}

const activityReports = new Map<number, MascotState>();
let activityReportSeq = 0;

function publishActivityMascot() {
  let best: MascotState = "idle";
  for (const state of activityReports.values()) {
    if (PRIORITY.indexOf(state) < PRIORITY.indexOf(best)) best = state;
  }
  setMascotSource("agent", best);
}

/**
 * Report the honest activity-derived mascot state on the "agent" source.
 * Takes the server-projected activity (honest statuses, routine noise
 * filtered) and maps it via `deriveMascotState` — error outranks working
 * outranks idle, per the shared PRIORITY order. Multiple mounted call sites
 * are safe: each registers its own report, the highest-priority one wins,
 * and each site cleans up only its own report on unmount. `flashMascot`
 * overrides still win over everything.
 */
export function useActivityMascot(records: readonly ProjectedActivityEntry[]): void {
  const state: MascotState = useMemo(() => deriveMascotState(records), [records]);
  useEffect(() => {
    const id = ++activityReportSeq;
    activityReports.set(id, state);
    publishActivityMascot();
    return () => {
      activityReports.delete(id);
      publishActivityMascot();
    };
  }, [state]);
}
