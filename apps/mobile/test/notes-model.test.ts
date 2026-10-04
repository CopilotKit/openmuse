import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canSaveNote,
  type NoteRow,
  noteHeading,
  noteTooLong,
  openNoteCount,
  orderedNotes,
  promotionAction,
} from "../src/notes-model.ts";

function note(overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    id: "n1",
    title: "Lease window",
    body: "How long does a lease last?",
    status: "open",
    promotable: true,
    createdAt: "2026-10-04T10:00:00.000Z",
    updatedAt: "2026-10-04T10:00:00.000Z",
    ...overrides,
  };
}

test("a note heading falls back to its body, and only then to a placeholder", () => {
  assert.equal(noteHeading(note()), "Lease window");
  assert.equal(noteHeading(note({ title: "", body: "Check the docs\n\nrest" })), "Check the docs");
  // The same title the promoted task will carry, so a note and its task are
  // never labelled two different things.
  assert.equal(noteHeading(note({ title: "", body: "x".repeat(200) })).length, 90);
});

test("an open note offers promotion, and says what it will do", () => {
  const action = promotionAction(note());
  assert.ok(action);
  assert.equal(action.label, "Make it a task");
  // The detail has to set the expectation that nothing runs on its own, or the
  // button reads as "start this now".
  assert.match(action.detail, /Nothing runs until you do/);
});

test("a promoted note reports itself as work rather than offering it again", () => {
  const action = promotionAction(note({ status: "promoted", promotable: false, taskId: "t1" }));
  assert.equal(action?.label, "Already a task");
});

test("an empty note offers no promotion at all", () => {
  // Null rather than a disabled button: a control whose only possible outcome
  // is an error is a dead end.
  assert.equal(promotionAction(note({ body: "   " })), null);
  // Even if a stale client sent `promotable: true`, the empty body still wins.
  assert.equal(promotionAction(note({ body: "", promotable: true })), null);
});

test("saving needs some text, and over-long text is refused by name", () => {
  assert.equal(canSaveNote("hello"), true);
  assert.equal(canSaveNote("   "), false);
  assert.equal(canSaveNote(""), false);
  assert.equal(noteTooLong("x".repeat(12_001)), true);
  assert.equal(noteTooLong("short"), false);
});

test("open notes are read first, and each group is newest first", () => {
  const rows = [
    note({ id: "old-open", createdAt: "2026-10-01T00:00:00.000Z" }),
    note({ id: "new-open", createdAt: "2026-10-03T00:00:00.000Z" }),
    note({ id: "promoted", status: "promoted", promotable: false }),
  ];
  assert.deepEqual(
    orderedNotes(rows).map((row) => row.id),
    ["new-open", "old-open", "promoted"],
  );
});

test("ordering does not mutate the caller's array", () => {
  // A sort in place would reorder the caller's state, so a re-render would show
  // a different order than the one just computed.
  const rows = [
    note({ id: "promoted", status: "promoted", promotable: false }),
    note({ id: "open" }),
  ];
  const before = rows.map((row) => row.id);
  orderedNotes(rows);
  assert.deepEqual(
    rows.map((row) => row.id),
    before,
  );
});

test("the count follows the server's own promotable flag", () => {
  // The server resolves `promotable`, so the count must not re-derive it here —
  // a client copy of the rule would drift and count notes it cannot promote.
  const rows = [
    note({ id: "a" }),
    note({ id: "b" }),
    note({ id: "c", status: "promoted", promotable: false }),
    note({ id: "d", promotable: false }),
  ];
  // `d` is open but the server refused to mark it promotable, so it is not
  // waiting on the user — counting it would advertise an action that 409s.
  assert.equal(openNoteCount(rows), 2);
  assert.equal(
    rows
      .filter((row) => row.promotable)
      .map((row) => row.id)
      .join(","),
    "a,b",
  );
});
