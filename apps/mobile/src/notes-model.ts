/**
 * The wording and derived state on the notes screen.
 *
 * RN-free for the same reason as `device-work-copy.ts`: `node --test` cannot load
 * anything that imports `react-native`, so text that only ever appears on a
 * device would otherwise be text nobody reviews. The promotion affordance in
 * particular is a decision worth testing — whether to show "Make it a task" is
 * the difference between a capture surface and work the user did not ask for.
 */

import type { Note } from "../../../packages/domain/src/agent.ts";
import { NOTE_BODY_MAX, promotionTitle } from "../../../packages/domain/src/note.ts";

/** A note as `GET /notes` returns it. */
export interface NoteRow extends Note {
  /** Server-resolved, so the client never offers a refused promotion. */
  promotable: boolean;
}

/**
 * The heading for a note: its own title, or the first line of its body.
 *
 * Shares `promotionTitle` with the server so a note and the task it becomes are
 * labelled identically. A note that renders as "Untitled" here and as its first
 * line on the board is the same note wearing two names.
 */
export function noteHeading(note: Pick<Note, "title" | "body">): string {
  return promotionTitle(note) || "Untitled note";
}

/**
 * "Turn this into work?" — the button, and what it says it will do.
 *
 * Returns null rather than a disabled button when the note cannot be promoted.
 * A control whose only possible outcome is an error is a dead end, and a
 * permanently-greyed button invites the user to keep tapping it.
 */
export function promotionAction(note: NoteRow): { label: string; detail: string } | null {
  if (note.status === "promoted")
    return { label: "Already a task", detail: "This note became a task on the board." };
  if (!note.promotable || !note.body.trim()) return null;
  return {
    label: "Make it a task",
    detail: "Starts work you can watch on the board. Nothing runs until you do.",
  };
}

/** Why the compose button is disabled, or "" when the note can be saved. */
export function canSaveNote(body: string): boolean {
  return body.trim().length > 0;
}

/** A note too long to save, with the limit named rather than left implicit. */
export function noteTooLong(body: string): boolean {
  return body.length > NOTE_BODY_MAX;
}

/**
 * Notes in the order they should be read: promoted ones recede, because they
 * have already become work and the open notes are the ones still needing a
 * decision.
 */
export function orderedNotes(rows: NoteRow[]): NoteRow[] {
  return [...rows].sort((a, b) => {
    // Open before promoted, then newest first within each group.
    if ((a.status === "promoted") !== (b.status === "promoted"))
      return a.status === "promoted" ? 1 : -1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/** How many notes are still waiting on the user's decision. */
export function openNoteCount(rows: NoteRow[]): number {
  return rows.filter((note) => note.promotable).length;
}
