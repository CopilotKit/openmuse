import assert from "node:assert/strict";
import { test } from "node:test";
import type { Note } from "../src/agent.ts";
import {
  checkPromotion,
  isNoteStatus,
  isPromotable,
  NOTE_BODY_MAX,
  NOTE_TITLE_MAX,
  noteInputSchema,
  promotionTaskId,
  promotionTitle,
} from "../src/note.ts";

/** Stand-in for the server's sha256, so the tests do not import node:crypto. */
const hash = (text: string) => `h:${text.length}:${text}`;

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    title: "Ask about the lease window",
    body: "Find out how long a device lease lasts.",
    status: "open",
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    ...overrides,
  };
}

test("a note is open until it is promoted, and a promoted one is not open again", () => {
  assert.equal(isNoteStatus("open"), true);
  assert.equal(isNoteStatus("promoted"), true);
  assert.equal(isNoteStatus("archived"), false);
  assert.equal(isNoteStatus(1), false);
  // Promotion is one-way: reopening promoted work means a new note, the same
  // rule the board applies to `Done`.
  assert.equal(isPromotable(note()), true);
  assert.equal(isPromotable(note({ status: "promoted", taskId: "t1" })), false);
});

test("a note with no text is not promotable", () => {
  // Empty is refused rather than allowed through to a task with a blank prompt,
  // which would surface as a schema error the user cannot act on.
  assert.equal(isPromotable(note({ body: "   " })), false);
  const decision = checkPromotion(note({ body: "" }), hash);
  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.reason, "empty");
});

test("promotion carries the note body as the task prompt", () => {
  const decision = checkPromotion(note(), hash);
  assert.equal(decision.ok, true);
  assert.equal(decision.ok === true && decision.prompt, "Find out how long a device lease lasts.");
  assert.equal(decision.ok === true && decision.title, "Ask about the lease window");
});

test("a note captured without a title still yields a readable task title", () => {
  // The title is display sugar; the body's first line stands in for it rather
  // than the board showing a blank card.
  const decision = checkPromotion(
    note({ title: "", body: "  Book the dentist\n\nand the vet" }),
    hash,
  );
  assert.equal(decision.ok === true && decision.title, "Book the dentist");
});

test("an over-long first line is truncated to the title limit", () => {
  const title = promotionTitle({ title: "", body: "x".repeat(500) });
  assert.equal(title.length, NOTE_TITLE_MAX);
});

test("an explicit title wins over the first line of the body", () => {
  assert.equal(
    promotionTitle({ title: "Lease question", body: "Something else entirely" }),
    "Lease question",
  );
});

test("the promoted task id is derived from the note id, so it is stable", () => {
  const first = promotionTaskId("note-1", hash);
  assert.equal(first, promotionTaskId("note-1", hash));
  // A different note must never collide onto the same task, or promoting two
  // notes would leave one board card standing for both.
  assert.notEqual(first, promotionTaskId("note-2", hash));
});

test("promoting an already-promoted note is refused, and reports the task", () => {
  // The refusal carries the existing task so a client can navigate to the work
  // rather than telling the user something is wrong when it already happened.
  const decision = checkPromotion(note({ status: "promoted", taskId: "task-9" }), hash);
  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.reason, "already-promoted");
  assert.equal(decision.ok === false && decision.taskId, "task-9");
});

test("a note body must be present and within the ceiling", () => {
  assert.equal(noteInputSchema.safeParse({ body: "hello" }).success, true);
  assert.equal(noteInputSchema.safeParse({ body: "   " }).success, false);
  assert.equal(noteInputSchema.safeParse({}).success, false);
  assert.equal(noteInputSchema.safeParse({ body: "x".repeat(NOTE_BODY_MAX + 1) }).success, false);
  // The optional title is trimmed, so a whitespace-only title behaves as absent.
  assert.equal(noteInputSchema.safeParse({ title: "   ", body: "hello" }).success, true);
});
