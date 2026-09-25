/**
 * Active-memory trigger: a PURE, SYNCHRONOUS heuristic that decides whether
 * the current user turn warrants a memory-recall DB read.
 *
 * This runs on the chat hot path BEFORE any database access, so it does NO
 * I/O and makes NO model calls — regex/keyword matching only. `recallMemories`
 * (recall.ts) is only reached after this returns true AND the per-thread
 * cooldown passes (index.ts).
 *
 * Trigger rules (order matters):
 * 1. EXPLICIT CUES -> true. The user is directly asking to remember or
 *    recall something: "remember", "recall", "remind me", "didn't you say".
 * 2. PERSONAL-REFERENCE CUE + QUESTION WORD -> true. The user is asking
 *    about their own history/preferences: "my", "earlier", "you said",
 *    "you told me", "last time", "previously" combined with a question word
 *    (what/who/where/when/why/how/did/do/is/...). Example: "what did you
 *    say earlier about the budget?" — recall is useful there.
 * 3. DEFAULT -> false. Commands ("watch this page", "run the report"),
 *    greetings ("hi", "hello"), and plain chatter never trigger recall —
 *    reading memories for those turns would just waste a DB round trip.
 *
 * The trigger errs toward recall (cheap false positives) rather than toward
 * silence: a needless recall costs one indexed DB read, while a missed recall
 * costs the agent answering from scratch.
 */
const EXPLICIT_CUES =
  /\b(rememb(?:er|ered|ering)|recall(?:ed|ing)?|remind\s+me|didn['']?t\s+you|don['']?t\s+you\s+remember)\b/i;

const PERSONAL_REFS =
  /\b(my|mine|earlier|you\s+said|you\s+told\s+me|you\s+mentioned|last\s+time|previously|before)\b/i;

const QUESTION_WORDS =
  /\b(what|who|whom|whose|where|when|why|how|did|do|does|is|are|was|were|which|can\s+you|could\s+you|tell\s+me)\b/i;

export function shouldRecall(text: string | undefined | null): boolean {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return false;
  if (EXPLICIT_CUES.test(trimmed)) return true;
  return PERSONAL_REFS.test(trimmed) && QUESTION_WORDS.test(trimmed);
}
