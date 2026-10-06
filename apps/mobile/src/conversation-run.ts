type RunError = { error: unknown; code?: string; context?: { agentId?: string } };

/** A RUN_ERROR event from the thread's saved history, not a failure of this call. */
export const replayedRunError = "agent_run_error_event";

/** The thread is busy with another run, so the server refused this one before starting it. */
export const threadLocked = "agent_thread_locked";

/** CopilotKit reports a lock as agent_thread_locked, then again as agent_run_failed. */
export function isThreadLocked(event: Pick<RunError, "error" | "code">) {
  return (
    event.code === threadLocked ||
    (event.error instanceof Error && event.error.name === "AgentThreadLockedError")
  );
}

/** A failed turn, carrying the CopilotKit error code that reported it. */
export class ConversationTurnError extends Error {
  constructor(
    readonly cause: Error,
    readonly code?: string,
  ) {
    super(cause.message);
    this.name = cause.name;
  }
}

/** Whether the chat's error banner shows an error reported while these are in progress. */
export function showsRunError(
  event: Pick<RunError, "error" | "code">,
  during: { replaying: boolean; queuedTurn: boolean },
) {
  // A failed turn saved in history is already over; it is not a failure of this session.
  if (during.replaying && event.code === replayedRunError) return false;
  // A queued message refused by a lock goes back on hold. Retry is not a queued turn, so it shows.
  if (during.queuedTurn && isThreadLocked(event)) return false;
  return true;
}

/** CopilotKit emits run failures through onError even when runAgent resolves. */
export async function runConversationTurn(
  agentId: string,
  execute: () => Promise<unknown>,
  subscribe: (listener: (event: RunError) => void) => { unsubscribe: () => void },
  ignore: readonly string[] = [],
) {
  let failure: ConversationTurnError | undefined;
  const subscription = subscribe((event) => {
    if (event.context?.agentId && event.context.agentId !== agentId) return;
    if (event.code && ignore.includes(event.code)) return;
    const error = event.error instanceof Error ? event.error : new Error(String(event.error));
    // The first report is the specific one; CopilotKit follows it with a generic agent_run_failed.
    failure ??= new ConversationTurnError(error, isThreadLocked(event) ? threadLocked : event.code);
  });
  try {
    await execute();
    if (failure) throw failure;
  } finally {
    subscription.unsubscribe();
  }
}
