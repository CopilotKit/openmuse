/**
 * Stopping the API server.
 *
 * `server.close()` only calls back once every connection has ended, and `/api/copilotkit/*` is a
 * long-lived event stream that is open for as long as a chat turn is running. So closing a server
 * that somebody is talking to waits on that conversation: `agent.stop()` is never reached, the
 * model run in flight is never aborted, and the platform kills the process instead of it stopping
 * itself.
 *
 * So the graceful path gets a bounded window to finish, the connections are then taken down so the
 * close can complete, and a hard deadline behind that leaves the process even if `agent.stop()`
 * never settles. The same shape `apps/worker` already uses for its own signal handling.
 */

export type ShutdownServer = {
  close(callback: () => void): unknown;
  /** Node 18.2+. Absent on some embedders, which is why it is optional. */
  closeAllConnections?: () => void;
};

export type ShutdownOptions = {
  server: ShutdownServer;
  agent: { stop(): Promise<void> };
  db: { close(): Promise<void> };
  /** How long a live connection may delay the close before it is dropped. */
  drainMs?: number;
  /** Backstop for a stop that never settles. */
  forceExitAfterMs?: number;
  /** Injectable so a test can observe the backstop instead of ending the test run. */
  forceExit?: () => void;
};

const DEFAULT_DRAIN_MS = 5_000;
const DEFAULT_FORCE_EXIT_MS = 30_000;

export async function shutdownOnce(options: ShutdownOptions): Promise<"drained"> {
  const drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;
  const forceExit = options.forceExit ?? (() => process.exit(1));

  // Behind everything else, and unref'd so it never holds the process open by itself.
  const hardStop = setTimeout(forceExit, options.forceExitAfterMs ?? DEFAULT_FORCE_EXIT_MS);
  hardStop.unref?.();

  // The close below cannot finish while a conversation is still streaming, so give it a moment to
  // finish on its own and then end the connections that are holding it open.
  const drain = setTimeout(() => options.server.closeAllConnections?.(), drainMs);
  drain.unref?.();

  try {
    await new Promise<void>((resolve) => {
      options.server.close(() => resolve());
    });
  } finally {
    clearTimeout(drain);
  }

  // Aborts whatever run is in flight, so the work stops rather than being orphaned by the exit.
  await options.agent.stop();
  await options.db.close();
  clearTimeout(hardStop);
  return "drained";
}
