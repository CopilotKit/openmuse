import {
  encodeJevAction,
  type JevAction,
  type JevPanel,
  type JevToolResult,
  jevActionPrefix,
  jevToolResultSchema,
  parseJevAction,
} from "../../../packages/domain/src/jev";

export function parseJevResult(value: unknown): JevToolResult | null {
  let result = value;
  if (typeof result === "string") {
    try {
      result = JSON.parse(result);
    } catch {
      return null;
    }
  }
  const parsed = jevToolResultSchema.safeParse(result);
  return parsed.success ? parsed.data : null;
}

function isPresentChoicesCall(call: unknown): call is { id: string } {
  if (!call || typeof call !== "object") return false;
  const tool = call as Record<string, unknown>;
  const fn = tool.function;
  return (
    typeof tool.id === "string" &&
    (tool.name === "present_choices" ||
      (fn !== null &&
        typeof fn === "object" &&
        (fn as Record<string, unknown>).name === "present_choices"))
  );
}

/** The transcript, rather than a rendered card, decides which panel may accept input. */
export function latestJevPanelId(messages: readonly unknown[], threadId: string): string | null {
  const choices = new Set<string>();
  let latest: string | null = null;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const item = message as Record<string, unknown>;
    if (item.role === "user") latest = null;
    if (item.role === "assistant" && Array.isArray(item.toolCalls)) {
      for (const call of item.toolCalls) {
        if (isPresentChoicesCall(call)) choices.add(call.id);
      }
    }
    if (item.role !== "tool" || typeof item.toolCallId !== "string") continue;
    if (!choices.has(item.toolCallId)) continue;
    const result = parseJevResult(item.content);
    if (result?.panel?.threadId === threadId) latest = result.panel.id;
  }
  return latest;
}

export type ChoiceAvailability =
  | "ready"
  | "wrong-thread"
  | "stale"
  | "selected"
  | "busy"
  | "pending";

export function choiceAvailability(
  panel: JevPanel,
  threadId: string,
  latestPanelId: string | null,
  busy: boolean,
  pending: boolean,
): ChoiceAvailability {
  if (panel.threadId !== threadId) return "wrong-thread";
  if (panel.id !== latestPanelId) return "stale";
  if (panel.selectedId) return "selected";
  if (pending) return "pending";
  if (busy) return "busy";
  return "ready";
}

export function selectionText(panel: JevPanel, optionId: string): string {
  if (!panel.options.some((option) => option.id === optionId)) throw new Error("Unknown choice");
  return encodeJevAction({
    panelId: panel.id,
    threadId: panel.threadId,
    candidateSetVersion: panel.candidateSetVersion,
    optionId,
  });
}

function actionFromText(text: string): JevAction | null {
  try {
    return parseJevAction(text);
  } catch {
    return null;
  }
}

function panelForAction(messages: readonly unknown[], action: JevAction): JevPanel | null {
  const choices = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const item = message as Record<string, unknown>;
    if (item.role === "assistant" && Array.isArray(item.toolCalls)) {
      for (const call of item.toolCalls) {
        if (isPresentChoicesCall(call)) choices.add(call.id);
      }
    }
    if (
      item.role !== "tool" ||
      typeof item.toolCallId !== "string" ||
      !choices.has(item.toolCallId)
    )
      continue;
    const panel = parseJevResult(item.content)?.panel;
    if (
      panel?.id === action.panelId &&
      panel.threadId === action.threadId &&
      panel.candidateSetVersion === action.candidateSetVersion &&
      panel.options.some((option) => option.id === action.optionId)
    )
      return panel;
  }
  return null;
}

export function displayJevUserMessage(text: string, precedingMessages: readonly unknown[]): string {
  if (!text.startsWith(jevActionPrefix)) return text;
  const action = actionFromText(text);
  if (!action) return "Choice unavailable";
  const option = panelForAction(precedingMessages, action)?.options.find(
    (candidate) => candidate.id === action.optionId,
  );
  return option ? `Selected: ${option.label}` : "Choice unavailable";
}

export function confirmedJevSelection(
  messages: readonly unknown[],
  panelId: string,
): string | null {
  let pending: string | null = null;
  let confirmed: string | null = null;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const item = message as Record<string, unknown>;
    if (item.role === "user") {
      pending = null;
      if (typeof item.content === "string") {
        const action = actionFromText(item.content);
        if (action?.panelId === panelId && panelForAction(messages.slice(0, index), action))
          pending = action.optionId;
      }
    }
    if (
      pending &&
      item.role === "assistant" &&
      typeof item.content === "string" &&
      item.content.trim()
    ) {
      confirmed = pending;
      pending = null;
    }
  }
  return confirmed;
}
