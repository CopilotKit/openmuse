/**
 * Notes, and their deliberate promotion into tasks.
 *
 * Vision requirement 1 is that notes and tasks live in **one** store with
 * deliberate promotion between them, not two systems. That is why this is not a
 * separate notes feature bolted beside the board: a note is a row in the same
 * owner-scoped `records` table, and promotion is an ordinary `createTask` call
 * that also records where the note went.
 *
 * The promotion rule, settled in `docs/SYNC.md`: **the agent suggests, the user
 * confirms.** So nothing here runs automatically. A note becomes a task only when
 * a caller asks, and once asked it happens exactly once — the task id is derived
 * from the note id, which is what makes a double promotion a no-op rather than a
 * second task.
 *
 * Pure, no I/O, like `board.ts` and `device-work.ts`.
 */

import { z } from "zod";
import type { Note } from "./agent.ts";

export type { Note };
export type NoteStatus = Note["status"];

export const NOTE_STATUSES: readonly NoteStatus[] = ["open", "promoted"] as const;

/** Longest note body accepted, matching the task prompt ceiling. */
export const NOTE_BODY_MAX = 12_000;

/** How a note's first line becomes a task title when none was given. */
export const NOTE_TITLE_MAX = 90;

export function isNoteStatus(value: unknown): value is NoteStatus {
  return typeof value === "string" && (NOTE_STATUSES as readonly string[]).includes(value);
}

/**
 * A captured note.
 *
 * `title` is optional and defaults to empty rather than to the first line: the
 * title is display sugar, and `promotionTitle` derives a usable one at promotion
 * time from whatever is there. Inventing it here would make the note look titled
 * in one view and untitled in another.
 */
export const noteInputSchema = z.object({
  title: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1, "A note needs some text").max(NOTE_BODY_MAX),
});

/**
 * The task a note promotes into, derived from its id.
 *
 * Deterministic on purpose: it is the same value on every device and on every
 * retry, so two devices promoting one note concurrently produce one task rather
 * than two. This is the note plane's equivalent of the claim CAS.
 *
 * `hash` is injected rather than imported so this stays pure and testable; the
 * server passes the same `hash` it uses for idempotency keys.
 */
export function promotionTaskId(noteId: string, hash: (input: string) => string): string {
  return hash(`task:note:${noteId}`);
}

/**
 * The title a promoted task gets.
 *
 * Falls back to the note's own title, and only then to a slice of the body, so a
 * note captured without a title still produces a readable board card.
 */
export function promotionTitle(note: Pick<Note, "title" | "body">): string {
  const explicit = note.title.trim();
  if (explicit) return explicit;
  const firstLine = note.body.trim().split("\n")[0]?.trim() ?? "";
  return firstLine.slice(0, NOTE_TITLE_MAX);
}

export type PromotionRejection = {
  ok: false;
  reason: "already-promoted" | "empty";
  message: string;
  /** Present on `already-promoted`, so a client can show the work that exists. */
  taskId?: string | undefined;
};

export type PromotionAcceptance = {
  ok: true;
  taskId: string;
  title: string;
  /** The prompt the task runs on: the note's body, verbatim. */
  prompt: string;
};

export type PromotionDecision = PromotionAcceptance | PromotionRejection;

/**
 * Whether this note may be promoted, and to what.
 *
 * Two refusals, each because the alternative is work the user did not ask for:
 *
 * - **Already promoted.** Returns the existing task rather than creating a
 *   second one. Promotion is one-way; reopening a promoted note means a new note,
 *   the same rule the board applies to `Done`.
 * - **Empty.** A blank note has no prompt to run, and `createTask` would reject
 *   it with a schema error the user cannot act on.
 */
export function checkPromotion(note: Note, hash: (input: string) => string): PromotionDecision {
  if (note.status === "promoted")
    return {
      ok: false,
      reason: "already-promoted",
      message: "This note is already a task.",
      taskId: note.taskId,
    };
  const prompt = note.body.trim();
  if (!prompt) return { ok: false, reason: "empty", message: "This note is empty." };
  return {
    ok: true,
    taskId: promotionTaskId(note.id, hash),
    title: promotionTitle(note),
    prompt,
  };
}

/**
 * Should this note be offered for promotion?
 *
 * Open and non-empty only — the UI's rule for rendering the action, kept beside
 * the decision it mirrors so the button and the endpoint cannot disagree about
 * what is promotable.
 */
export function isPromotable(note: Note): boolean {
  return note.status === "open" && note.body.trim().length > 0;
}
