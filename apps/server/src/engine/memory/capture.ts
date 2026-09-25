import { createHash } from "node:crypto";
import type { MemoryCandidate } from "../../../../../packages/domain/src/agent.ts";
import { tokenize } from "./recall.ts";

/**
 * Memory capture: extracts explicit "remember this" moments from USER
 * messages and stages them as human-approved candidates.
 *
 * SECURITY INVARIANT — read this before touching this file:
 * captureMemoryCandidate() MUST only ever be called with the user's own
 * message (role === "user"). It must NEVER run on tool outputs, email
 * bodies, page text, or any other attacker-controlled source: the capture
 * cues below ("remember this", "note that", ...) are trivially forgeable in
 * third-party content, and running capture on them would let a malicious
 * page or email plant memories that later steer the agent. The role guard at
 * the top of captureMemoryCandidate() enforces this; callers must pass the
 * real user turn, not re-wrapped content.
 *
 * Candidates NEVER land in `memories` directly — they are written with kind
 * "memory-candidates" and status "pending", and only an explicit, authenticated
 * approve in the app moves them into memories (see service.approveCandidate).
 * Deduplication is by sha256 of the normalized text, so the same phrasing
 * from repeated turns produces exactly one candidate.
 *
 * Polarity-conflict detection: when the candidate shares >= 2 content tokens
 * with an existing memory AND flips an antonym pair (e.g. love/hate,
 * always/never), the candidate carries `conflictWith` pointing at the memory
 * id so the review UI can flag the contradiction for the user.
 */

const CAPTURE_CUE =
  /\b(remember this|remember that|don't forget|do not forget|note that|keep in mind)\b/i;

const TRAILING_NOISE = /\s*(please|thanks|thank you|ok|okay)\s*[.!?]?\s*$/i;
const LEADING_NOISE = /^\s*[:\-–—,"']+|\s*[:\-–—,"']+\s*$/g;

/** Antonym pairs used for polarity-flip detection. */
const ANTONYM_PAIRS: Array<[string, string]> = [
  ["like", "dislike"],
  ["love", "hate"],
  ["prefer", "dislike"],
  ["always", "never"],
  ["often", "rarely"],
  ["morning", "evening"],
  ["hot", "cold"],
  ["yes", "no"],
  ["true", "false"],
  ["best", "worst"],
];

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function extractCandidateText(message: string): string | null {
  const match = CAPTURE_CUE.exec(message);
  if (!match) return null;
  let rest = message.slice(match.index + match[0].length);
  // "note that the meeting moved" -> keep "the meeting moved".
  rest = rest.replace(/^\s*that\b/i, "");
  // Take the first clause (up to sentence end or ~300 chars).
  const clause = rest.split(/(?<=[.!?])\s+|\n/)[0] ?? "";
  const cleaned = clause.replace(LEADING_NOISE, "").replace(TRAILING_NOISE, "").trim();
  if (tokenize(cleaned).length < 3) return null;
  return cleaned.slice(0, 300);
}

function polarityFlip(candidateTokens: Set<string>, memoryTokens: Set<string>): boolean {
  return ANTONYM_PAIRS.some(
    ([a, b]) =>
      (candidateTokens.has(a) && memoryTokens.has(b)) ||
      (candidateTokens.has(b) && memoryTokens.has(a)),
  );
}

export function findConflict(
  candidateText: string,
  memories: Array<{ id: string; text: string }>,
): string | undefined {
  const candidateTokens = new Set(tokenize(candidateText));
  for (const memory of memories) {
    const memoryTokens = new Set(tokenize(memory.text ?? ""));
    const shared = [...candidateTokens].filter((token) => memoryTokens.has(token)).length;
    if (shared >= 2 && polarityFlip(candidateTokens, memoryTokens)) return memory.id;
  }
  return undefined;
}

export interface CaptureStore {
  list<T>(owner: string, kind: string): Promise<T[]>;
  insertIfAbsent<T extends { id: string }>(
    owner: string,
    kind: string,
    value: T,
  ): Promise<T | null>;
}

export async function captureMemoryCandidate(
  db: CaptureStore,
  owner: string,
  message: { role?: string; content?: unknown } | undefined,
): Promise<MemoryCandidate | null> {
  // Invariant: capture runs ONLY on the user's own message.
  if (message?.role !== "user") return null;
  const content = typeof message.content === "string" ? message.content : "";
  const text = extractCandidateText(content);
  if (!text) return null;
  const memories = await db.list<{ id: string; text: string }>(owner, "memories");
  const candidate: MemoryCandidate = {
    id: sha256(normalizeForDedupe(text)),
    text,
    source: "Chat capture",
    status: "pending",
    conflictWith: findConflict(text, memories),
    createdAt: new Date().toISOString(),
  };
  if (candidate.conflictWith === undefined) delete candidate.conflictWith;
  // insertIfAbsent dedupes on the sha256 id: the same phrasing captured twice
  // (e.g. across repeated turns) yields exactly one candidate.
  return (await db.insertIfAbsent(owner, "memory-candidates", candidate)) ?? null;
}
