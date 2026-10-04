import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardState } from "../../../packages/domain/src/board.ts";
import type { Board, BoardTask } from "../src/board-model.ts";
import {
  boardTotal,
  COLUMN_LABEL,
  isVisibleColumn,
  populatedColumns,
  waitingLabel,
} from "../src/board-model.ts";

const task = (id: string, overrides: Partial<BoardTask> = {}): BoardTask => ({
  id,
  title: id,
  status: "queued",
  updatedAt: "2026-10-04T00:00:00.000Z",
  allowedTransitions: [],
  dependsOn: 0,
  blocked: false,
  ...overrides,
});

const board: Board = {
  columns: [
    { boardState: "Backlog", tasks: [task("a"), task("b", { blocked: true, dependsOn: 2 })] },
    { boardState: "InProgress", tasks: [task("c", { status: "running" })] },
    { boardState: "Review", tasks: [] },
    { boardState: "Blocked", tasks: [] },
    { boardState: "Done", tasks: [task("d")] },
    { boardState: "Cancelled", tasks: [] },
  ],
};

test("every board state has a human label", () => {
  // A missing label renders an empty column header, which is worse than an
  // internal name, so assert the whole table rather than the states in use.
  const states: BoardState[] = ["Backlog", "InProgress", "Review", "Blocked", "Done", "Cancelled"];
  for (const state of states) assert.ok(COLUMN_LABEL[state], state);
  assert.equal(COLUMN_LABEL.InProgress, "In progress");
});

test("the total counts tasks across every column, including hidden ones", () => {
  assert.equal(boardTotal(board), 4);
  assert.equal(boardTotal(undefined), 0);
});

test("populated columns skip the empty ones but keep board order", () => {
  assert.deepEqual(
    populatedColumns(board).map((column) => column.boardState),
    ["Backlog", "InProgress", "Done"],
  );
  assert.deepEqual(populatedColumns(undefined), []);
});

test("Cancelled is hidden by default, everything else is shown even when empty", () => {
  // Empty-but-visible keeps a column from popping into existence as the first
  // task arrives; Cancelled is a graveyard rather than active work.
  assert.equal(isVisibleColumn("Cancelled"), false);
  for (const state of ["Backlog", "InProgress", "Review", "Blocked", "Done"] as const)
    assert.equal(isVisibleColumn(state), true, state);
});

test("the waiting label agrees in number", () => {
  assert.equal(waitingLabel(1), "Waiting on 1 task");
  assert.equal(waitingLabel(2), "Waiting on 2 tasks");
  assert.equal(waitingLabel(0), "Waiting on 0 tasks");
});
