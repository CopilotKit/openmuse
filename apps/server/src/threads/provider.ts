import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import type { Config, ThreadsBackend } from "../config.ts";
import { intelligenceKeyRequiredMessage } from "../config.ts";
import type { Store } from "../db.ts";
import { CHAT_THREADS_KIND, defaultTitleGenerator, PersistentAgentRunner } from "./local-runner.ts";

/**
 * Persistence boundary for chat threads. "intelligence" is the CopilotKit-hosted
 * default; "local" keeps threads on the server's own database and never makes
 * Intelligence requests. See docs/PLUGGABLE-THREADS.md for the capability matrix.
 */
export type ThreadProvider =
  | {
      backend: "intelligence";
      intelligence: CopilotKitIntelligence;
      getOrCreateMainThread(input: { owner: string; threadId: string }): Promise<void>;
    }
  | {
      backend: "local";
      runner: PersistentAgentRunner;
      getOrCreateMainThread(input: { owner: string; threadId: string }): Promise<void>;
    };

export function createThreadProvider(
  config: Config,
  deps: { db: Store; ownerOf: (agent: unknown) => string | undefined },
): ThreadProvider {
  const backend: ThreadsBackend = config.threadsBackend ?? "intelligence";
  if (backend === "intelligence") {
    // assertThreadsBackendConfig guards the real startup path; this keeps the
    // factory honest when it is built directly (tests, demos).
    if (!config.intelligenceApiKey?.trim()) throw new Error(intelligenceKeyRequiredMessage);
    const intelligence = new CopilotKitIntelligence({ apiKey: config.intelligenceApiKey });
    return {
      backend: "intelligence",
      intelligence,
      getOrCreateMainThread: ({ owner, threadId }) =>
        intelligence
          .getOrCreateThread({ threadId, userId: owner, agentId: "default" })
          .then(() => undefined),
    };
  }
  if (config.intelligenceApiKey)
    console.warn("[OpenMuse] THREADS_BACKEND=local ignores CPK_INTELLIGENCE_API_KEY.");
  const runner = new PersistentAgentRunner(
    deps.db,
    deps.ownerOf,
    defaultTitleGenerator(config.model),
  );
  const { db } = deps;
  return {
    backend: "local",
    runner,
    getOrCreateMainThread: async ({ owner, threadId }) => {
      const now = new Date().toISOString();
      await db.insertIfAbsent(owner, CHAT_THREADS_KIND, {
        id: threadId,
        owner,
        agentId: "default",
        name: null,
        archived: false,
        createdAt: now,
        updatedAt: now,
        messages: [],
        runs: [],
      });
    },
  };
}

export type { ThreadsBackend };
