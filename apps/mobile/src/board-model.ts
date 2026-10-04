import type { BoardState } from "../../../packages/domain/src/board.ts";

/** A task as `/tasks/board` returns it: enough to render a column, no more. */
export interface BoardTask {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  /** From the server. Never recomputed here — see the note on the screen. */
  allowedTransitions: BoardState[];
  /** How many prerequisites have not settled yet. */
  dependsOn: number;
  blocked: boolean;
}

export interface Board {
  columns: { boardState: BoardState; tasks: BoardTask[] }[];
}

export const COLUMN_LABEL: Record<BoardState, string> = {
  Backlog: "Backlog",
  InProgress: "In progress",
  Review: "Review",
  Blocked: "Blocked",
  Done: "Done",
  Cancelled: "Cancelled",
};

export function boardTotal(board: Board | undefined): number {
  return (board?.columns ?? []).reduce((sum, column) => sum + column.tasks.length, 0);
}

/** Columns with at least one task, in board order. Empty ones render as placeholders. */
export function populatedColumns(board: Board | undefined) {
  return (board?.columns ?? []).filter((column) => column.tasks.length > 0);
}

/**
 * "Waiting on 1 task" / "Waiting on 3 tasks".
 *
 * Kept out of the component so the wording is covered by a test rather than only
 * being visible on a device.
 */
export function waitingLabel(dependsOn: number): string {
  return dependsOn === 1 ? "Waiting on 1 task" : `Waiting on ${String(dependsOn)} tasks`;
}

/**
 * Columns worth showing by default: everything except Cancelled, which is a
 * graveyard rather than active work. Empty non-cancelled columns still render,
 * so a column does not appear and disappear as a single task moves through it.
 */
export function isVisibleColumn(boardState: BoardState): boolean {
  return boardState !== "Cancelled";
}
