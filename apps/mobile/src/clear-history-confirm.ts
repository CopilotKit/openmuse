// The exact word the user must type to confirm permanent chat-history deletion.
// Kept in a dependency-free module so the gating rule is unit-testable.
export const CLEAR_HISTORY_CONFIRMATION = "DELETE";

export function isDeleteConfirmed(value: string): boolean {
  return value === CLEAR_HISTORY_CONFIRMATION;
}
