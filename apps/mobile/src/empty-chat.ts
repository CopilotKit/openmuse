// Empty chat screen content helpers.
//
// Kept free of react-native imports so the text and the shortcut -> button
// mapping stay unit-testable under plain node:test. chat.tsx renders these.

import type { ChatShortcut } from "./shortcuts";

export const EMPTY_CHAT_HEADING = "A little help. A lot more room for life.";

export const EMPTY_CHAT_SUBTITLE =
  "Tell me what’s on your mind. I can make a plan, work with your apps, and use my computer to " +
  "help. Add your own shortcuts in Settings (Apps) to reach them in one tap.";

export const EMPTY_CHAT_NO_SHORTCUTS_HINT = "No shortcuts yet — add your own in Settings (Apps).";

export interface EmptyChatButton {
  key: string;
  label: string;
  instruction: string;
}

/**
 * Map the user's shortcuts to the buttons shown on the empty chat screen.
 * Each shortcut renders as a button (label) with its instruction text
 * displayed underneath; tapping the button enqueues the instruction.
 */
export function emptyChatButtons(shortcuts: ChatShortcut[]): EmptyChatButton[] {
  return shortcuts.map((shortcut) => ({
    key: shortcut.id,
    label: shortcut.label,
    instruction: shortcut.instruction,
  }));
}
