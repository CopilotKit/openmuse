/**
 * Pre-turn active memory: the single entry point the chat agent calls once
 * per user turn, BEFORE the model runs.
 *
 * Pipeline:
 *   1. capture  — fire-and-forget: "remember this" moments in the user
 *      message become pending memory candidates (capture.ts). Never blocks
 *      the turn; failures are logged, never thrown. Capture runs regardless
 *      of whether the trigger fires.
 *   2. trigger  — cheap sync regex on the user text (trigger.ts). False ->
 *      no DB read at all this turn.
 *   3. cooldown — at most one recall per thread per 60s (module-level map,
 *      pruned lazily). Within the window -> return "" without touching the DB.
 *   4. recall   — bounded token-overlap retrieval (recall.ts), returned as a
 *      labeled prompt block for the model.
 *
 * Fail-open by design: this must never break a chat turn. Callers should
 * catch errors and fall back to "".
 */
import { backgroundFailure } from "../../log.ts";
import { captureMemoryCandidate } from "./capture.ts";
import { type RecallResult, recallMemories } from "./recall.ts";
import { shouldRecall } from "./trigger.ts";

const RECALL_COOLDOWN_MS = 60_000;
/** threadId -> timestamp of the last successful recall. Pruned lazily. */
const lastRecallAt = new Map<string, number>();

export function pruneRecallCooldowns(now = Date.now()): void {
  for (const [threadId, at] of lastRecallAt)
    if (now - at > RECALL_COOLDOWN_MS) lastRecallAt.delete(threadId);
}

export interface PreTurnMemoryStore {
  list<T>(owner: string, kind: string): Promise<T[]>;
  insertIfAbsent<T extends { id: string }>(
    owner: string,
    kind: string,
    value: T,
  ): Promise<T | null>;
}

export async function preparePreTurnMemory(args: {
  db: PreTurnMemoryStore;
  owner: string;
  threadId: string;
  message: { role?: string; content?: unknown } | undefined;
}): Promise<string> {
  const { db, owner, threadId, message } = args;
  // Capture is independent of recall: a "remember this" turn rarely needs
  // past memories, but always deserves a candidate. Fire-and-forget so a
  // slow store never blocks the reply.
  void captureMemoryCandidate(db, owner, message)
    .then((candidate) => {
      if (candidate?.conflictWith)
        backgroundFailure(
          "memory capture conflict",
          new Error(`Candidate ${candidate.id} conflicts with memory ${candidate.conflictWith}`),
        );
    })
    .catch((error) => backgroundFailure("memory capture", error));

  const text = typeof message?.content === "string" ? message.content : "";
  if (!shouldRecall(text)) return "";
  const now = Date.now();
  const last = lastRecallAt.get(threadId);
  if (last !== undefined && now - last < RECALL_COOLDOWN_MS) return "";
  lastRecallAt.set(threadId, now);
  pruneRecallCooldowns(now);
  const recalled: RecallResult = await recallMemories(db, owner, text, {
    maxItems: 5,
    maxChars: 1200,
  });
  return recalled.block;
}

// Item #8 (context registry) imports recallMemories from here.
export { captureMemoryCandidate, recallMemories, shouldRecall };
