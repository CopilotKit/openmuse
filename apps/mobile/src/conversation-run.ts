type RunError = { error: unknown; code?: string; context?: { agentId?: string } };

/** A RUN_ERROR event from the thread's saved history, not a failure of this call. */
export const replayedRunError = "agent_run_error_event";

/** CopilotKit emits run failures through onError even when runAgent resolves. */
export async function runConversationTurn(
  agentId: string,
  execute: () => Promise<unknown>,
  subscribe: (listener: (event: RunError) => void) => { unsubscribe: () => void },
  ignore: readonly string[] = [],
) {
  let failure: Error | undefined;
  const subscription = subscribe((event) => {
    if (event.context?.agentId && event.context.agentId !== agentId) return;
    if (event.code && ignore.includes(event.code)) return;
    failure = event.error instanceof Error ? event.error : new Error(String(event.error));
  });
  try {
    await execute();
    if (failure) throw failure;
  } finally {
    subscription.unsubscribe();
  }
}
