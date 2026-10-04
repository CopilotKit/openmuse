/**
 * Board state — where a task sits on the user's board.
 *
 * Distinct from `TaskStatus` (agent.ts), which is the *execution* state the
 * worker owns. The two are deliberately separate: a task can be
 * `waiting_approval` for the agent while being `InProgress` on the board, and
 * can be `Blocked` on the board while its execution status is `queued`. A
 * single field collapses those and loses the information.
 *
 * Transitions lifted from cntrl's `src/utils/kanban/state-machine.ts`, which is
 * the only copy of this rule anywhere across our repos. `Done` and `Cancelled`
 * are terminal here: re-opening work creates a new task so the audit trail of
 * what actually shipped stays intact.
 */

export type BoardState = "Backlog" | "InProgress" | "Review" | "Blocked" | "Done" | "Cancelled";

export const BOARD_STATES: readonly BoardState[] = [
  "Backlog",
  "InProgress",
  "Review",
  "Blocked",
  "Done",
  "Cancelled",
] as const;

/** Allowed forward transitions. Anything absent here is rejected. */
export const ALLOWED_TRANSITIONS: Record<BoardState, readonly BoardState[]> = {
  Backlog: ["InProgress", "Cancelled"],
  InProgress: ["Review", "Blocked", "Cancelled"],
  Blocked: ["Backlog", "Cancelled"],
  Review: ["Done", "InProgress", "Cancelled"],
  Done: [],
  Cancelled: [],
} as const;

export function isBoardState(value: unknown): value is BoardState {
  return typeof value === "string" && (BOARD_STATES as readonly string[]).includes(value);
}

export function canTransition(from: BoardState, to: BoardState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** States reachable from `from`, so the UI can render only legal actions. */
export function validTransitionsFor(from: BoardState): readonly BoardState[] {
  return ALLOWED_TRANSITIONS[from];
}

export function isTerminal(state: BoardState): boolean {
  return ALLOWED_TRANSITIONS[state].length === 0;
}

export type TransitionRejection = {
  ok: false;
  currentState: BoardState;
  attemptedTransition: BoardState;
  allowedTransitions: readonly BoardState[];
  message: string;
};

export type TransitionAcceptance = { ok: true; from: BoardState; to: BoardState };

/**
 * Structured transition check. Rejections carry the legal alternatives so the
 * API can answer "what could I have done instead?" in one round-trip.
 */
export function checkTransition(
  from: BoardState,
  to: BoardState,
): TransitionAcceptance | TransitionRejection {
  if (canTransition(from, to)) return { ok: true, from, to };
  return {
    ok: false,
    currentState: from,
    attemptedTransition: to,
    allowedTransitions: ALLOWED_TRANSITIONS[from],
    message: isTerminal(from)
      ? `Task is in terminal state ${from}; create a new task instead of re-opening it.`
      : `Invalid transition from ${from} to ${to}.`,
  };
}

/**
 * Apply the validation-gate override to a requested transition. A failed gate
 * never advances a task regardless of what the caller asked for: the work goes
 * back to InProgress so it can be retried. This is what makes the gate binary
 * rather than advisory.
 */
export function computeEffectiveState(
  requested: BoardState,
  validationPassed: boolean | undefined,
): BoardState {
  if (validationPassed === false) return "InProgress";
  return requested;
}

/** A task that is finished on the board, whatever its execution status is. */
export function isBoardClosed(state: BoardState): boolean {
  return state === "Done" || state === "Cancelled";
}
