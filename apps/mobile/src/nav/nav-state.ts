import { useSyncExternalStore } from "react";

/**
 * Single shared navigation-drawer controller.
 *
 * The hamburger button, the drawer itself, and any future nav trigger all
 * drive this one module-level store, so there is exactly one source of truth
 * for "is the nav drawer open". Components read it via `useNavOpen()` (a
 * `useSyncExternalStore` binding) and drive it via `openNav` / `closeNav` /
 * `toggleNav`. No props need to be threaded from a parent component.
 */

type NavListener = () => void;

let open = false;
const listeners = new Set<NavListener>();

function emit() {
  for (const listener of listeners) listener();
}

function setOpen(next: boolean) {
  if (open === next) return;
  open = next;
  emit();
}

/** Snapshot for `useSyncExternalStore`; also handy in tests. */
export function isNavOpen(): boolean {
  return open;
}

/** Open the drawer. No-op when already open. */
export function openNav(): void {
  setOpen(true);
}

/** Close the drawer. No-op when already closed. */
export function closeNav(): void {
  setOpen(false);
}

/** Toggle the drawer open/closed. */
export function toggleNav(): void {
  setOpen(!open);
}

export function subscribeNav(listener: NavListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React binding: re-renders the component whenever the drawer opens/closes. */
export function useNavOpen(): boolean {
  return useSyncExternalStore(subscribeNav, isNavOpen);
}

/** Full controller for components that both read and drive nav state. */
export function useNav(): {
  open: boolean;
  openNav: () => void;
  closeNav: () => void;
  toggleNav: () => void;
} {
  return { open: useNavOpen(), openNav, closeNav, toggleNav };
}

/**
 * Build the keydown handler the drawer attaches on web so ESC closes it.
 * Factored out (instead of inline) so the "only Escape closes" logic is
 * unit-testable without a DOM.
 */
export function createEscapeHandler(onEscape: () => void) {
  return (event: { key: string }) => {
    if (event.key === "Escape") onEscape();
  };
}
