/**
 * The sync log's wire format.
 *
 * The server owns an ordered log; a device stores the highest `seq` it has seen
 * and pulls everything after it. Device state is a rebuildable projection of
 * this log, not something that is itself synchronised — the Telegram model.
 */

export interface SyncChange {
  /** Monotonic per owner. Gaps are allowed; out-of-order delivery is not. */
  seq: number;
  /** Record collection, e.g. `tasks`, `messages`. */
  kind: string;
  recordId: string;
  op: "put" | "delete";
  /** Full record body for `put`; absent for `delete`. */
  data?: Record<string, unknown> | undefined;
  /** Which device caused the write, when it was a device. */
  deviceId?: string | undefined;
  /** Server-assigned. Never trust a client-supplied time. */
  at: string;
}

export interface SyncPage {
  changes: SyncChange[];
  /** Highest seq actually delivered, NOT the newest in the table. */
  cursor: number;
  /** More remains; pull again with this cursor. */
  hasMore: boolean;
}

/** Device-placement policy for a new step. */
export type StepPlacement = "device" | "server";

/**
 * Apply a change to a local projection.
 *
 * Returns the record to store, or `null` when the change removes it. Pure, so a
 * device can rebuild its cache from `seq=0` and reach the same state the server
 * holds — which is the property that makes local state disposable.
 *
 * A `put` replaces the record rather than merging into what was there. Merging
 * would resurrect fields a newer change on another device had already cleared,
 * and deletion of a single field is exactly the case last-write-wins has to get
 * right.
 */
export function applyChange(change: SyncChange): Record<string, unknown> | null {
  if (change.op === "delete") return null;
  return { ...(change.data ?? {}) };
}

/** Stable key for a change, for use as a projection map key. */
export function changeKey(change: SyncChange): string {
  return `${change.kind}:${change.recordId}`;
}

/**
 * Fold a page of changes into a projection, oldest first.
 *
 * Later changes win, which is last-write-wins by log order rather than by
 * timestamp. Using the server's ordering instead of a client clock is what stops
 * a device with a skewed clock from rewriting history.
 */
export function foldChanges(
  current: Record<string, Record<string, unknown>>,
  changes: readonly SyncChange[],
): Record<string, Record<string, unknown>> {
  const next = { ...current };
  for (const change of changes) {
    const key = changeKey(change);
    const applied = applyChange(change);
    if (applied === null) delete next[key];
    else next[key] = applied;
  }
  return next;
}
