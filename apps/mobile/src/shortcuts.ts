// User-configurable chat shortcuts.
//
// Each shortcut is a label plus the instruction text that gets enqueued when the
// user taps it on the empty chat screen. Shortcuts are persisted as JSON in
// the shared localStorage-backed key/value backend from session-store.ts
// (durable on web, in-memory fallback on native), so they survive reloads.
//
// The module keeps a snapshot of the current list and notifies subscribers
// (React's useSyncExternalStore in chat.tsx and the settings screen), so both
// views stay in sync without a full reload.

import { getStorageBackend, type KeyValueStore, setStorageBackend } from "./session-store";

export interface ChatShortcut {
  /** Stable id, e.g. "sc-1727220000000-a1b2c3". */
  id: string;
  /** Short label shown on the button. */
  label: string;
  /** Full instruction text enqueued when the button is tapped. */
  instruction: string;
}

const SHORTCUTS_KEY = "openmuse.chat.shortcuts";
const MAX_LABEL_LENGTH = 80;
const MAX_INSTRUCTION_LENGTH = 4000;

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Validate + normalize untrusted parsed JSON into a clean shortcut list. */
function sanitize(raw: unknown): ChatShortcut[] {
  if (!Array.isArray(raw)) return [];
  const clean: ChatShortcut[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { id, label, instruction } = item as Record<string, unknown>;
    if (typeof label !== "string" || typeof instruction !== "string") continue;
    const trimmedLabel = label.trim();
    const trimmedInstruction = instruction.trim();
    if (!trimmedLabel || !trimmedInstruction) continue;
    clean.push({
      id: typeof id === "string" && id ? id : `sc-${Date.now()}-x`,
      label: clip(trimmedLabel, MAX_LABEL_LENGTH),
      instruction: clip(trimmedInstruction, MAX_INSTRUCTION_LENGTH),
    });
  }
  return clean;
}

function newId(): string {
  return `sc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- snapshot + subscription -----------------------------------------------

let snapshot: ChatShortcut[] = [];
let loaded = false;
const listeners = new Set<() => void>();

/** React useSyncExternalStore subscribe function. */
export function subscribeShortcuts(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** React useSyncExternalStore snapshot. */
export function getShortcutsSnapshot(): ChatShortcut[] {
  return snapshot;
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** Test seam: swap the storage backend (delegates to session-store). */
export function setShortcutStore(store: KeyValueStore | null): void {
  setStorageBackend(store);
  // A fresh backend means a fresh read on next access.
  loaded = false;
  snapshot = [];
}

async function readRaw(): Promise<ChatShortcut[]> {
  try {
    const raw = await getStorageBackend().getItem(SHORTCUTS_KEY);
    if (!raw) return [];
    return sanitize(JSON.parse(raw));
  } catch {
    // Corrupt or unreadable JSON: start empty rather than crash.
    return [];
  }
}

async function writeRaw(list: ChatShortcut[]): Promise<void> {
  try {
    await getStorageBackend().setItem(SHORTCUTS_KEY, JSON.stringify(list));
  } catch {
    // Best effort: shortcuts still work for this session.
  }
}

/** Load from storage on first use (idempotent); notifies subscribers. */
export async function ensureShortcutsLoaded(): Promise<void> {
  if (loaded) return;
  snapshot = await readRaw();
  loaded = true;
  emit();
}

async function commit(next: ChatShortcut[]): Promise<ChatShortcut[]> {
  await ensureShortcutsLoaded();
  snapshot = next;
  await writeRaw(next);
  emit();
  return snapshot;
}

// --- public API --------------------------------------------------------------

/** Current shortcuts (a copy). Loads from storage on first call. */
export async function loadShortcuts(): Promise<ChatShortcut[]> {
  await ensureShortcutsLoaded();
  return [...snapshot];
}

/** Add a shortcut; throws when the label or instruction is blank. */
export async function addShortcut(label: string, instruction: string): Promise<ChatShortcut> {
  const trimmedLabel = clip(label.trim(), MAX_LABEL_LENGTH);
  const trimmedInstruction = clip(instruction.trim(), MAX_INSTRUCTION_LENGTH);
  if (!trimmedLabel) throw new Error("Shortcut label cannot be empty.");
  if (!trimmedInstruction) throw new Error("Shortcut instruction cannot be empty.");
  const shortcut: ChatShortcut = {
    id: newId(),
    label: trimmedLabel,
    instruction: trimmedInstruction,
  };
  await commit([...(await loadShortcuts()), shortcut]);
  return shortcut;
}

/**
 * Update a shortcut's label/instruction. Returns the updated shortcut, or null
 * when no shortcut with that id exists. Blank values in the patch are
 * ignored (the existing value is kept).
 */
export async function updateShortcut(
  id: string,
  patch: { label?: string; instruction?: string },
): Promise<ChatShortcut | null> {
  const list = await loadShortcuts();
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const current = list[index];
  const label = patch.label?.trim() ? clip(patch.label.trim(), MAX_LABEL_LENGTH) : current.label;
  const instruction = patch.instruction?.trim()
    ? clip(patch.instruction.trim(), MAX_INSTRUCTION_LENGTH)
    : current.instruction;
  const updated: ChatShortcut = { ...current, label, instruction };
  const next = [...list];
  next[index] = updated;
  await commit(next);
  return updated;
}

/** Delete a shortcut; returns true when one was removed. */
export async function deleteShortcut(id: string): Promise<boolean> {
  const list = await loadShortcuts();
  const next = list.filter((item) => item.id !== id);
  if (next.length === list.length) return false;
  await commit(next);
  return true;
}
