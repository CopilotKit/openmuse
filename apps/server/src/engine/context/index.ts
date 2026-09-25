/**
 * Context-engine entry point: budget constants and the chat prompt builder.
 *
 * Budgets are exported constants AND accepted as parameters so orchestra mode
 * can later set per-subagent budgets without changing call sites.
 */
import { computerInstructions } from "../../computer-tools.ts";
import {
  type AssembledPrompt,
  type ContextPlan,
  ContextRegistry,
  inlineResource,
} from "./registry.ts";
import {
  CHAT_CORE,
  CHAT_IDENTITY_PREFIX,
  COMPUTER_FALLBACK,
  computerInstructionsResource,
  EMAIL_POLICY_FALLBACK,
  emailPolicyResource,
  IDENTITY_FALLBACK,
  identityResource,
  memoriesResource,
  timezoneResource,
} from "./resources.ts";

/** Default character budget for the interactive chat system prompt. */
export const CHAT_BUDGET = 6000;
/** Default character budget for delegated worker task prompts. */
export const WORKER_BUDGET = 4000;
/** Reserved for orchestra mode: per-subagent budgets (not yet wired). */
export const SUBAGENT_BUDGET = 2500;

export interface ChatPromptInput {
  /** loadSoul() result: the owner's standing instructions. */
  soul: string;
  /** skillPromptBlock(skills); "" when no skills. */
  skillsBlock: string;
  /** Pre-turn memory block (preparePreTurnMemory); "" when none recalled. */
  memoryBlock: string;
  /** Whether the email search/read tools are registered this turn. */
  mailAvailable: boolean;
  /** Override the default CHAT_BUDGET. */
  budgetChars?: number;
}

/**
 * Assemble the chat system prompt from registered context resources.
 * Section bodies are byte-identical to the pre-refactor concatenation;
 * sections are headed with `## <id>` and ordered by priority.
 */
export async function buildChatPrompt(input: ChatPromptInput): Promise<AssembledPrompt> {
  const registry = new ContextRegistry();
  registry
    .register(
      identityResource(`${CHAT_IDENTITY_PREFIX}${input.soul}${CHAT_CORE}`, {
        fallback: IDENTITY_FALLBACK,
      }),
    )
    .register(timezoneResource(process.env.OWNER_TIMEZONE ?? "America/Chicago"))
    .register(
      memoriesResource({
        materialize: () => input.memoryBlock,
        estimateChars: () => input.memoryBlock.length,
      }),
    )
    .register(
      inlineResource({
        id: "skills",
        priority: 70,
        text: input.skillsBlock ? ` ${input.skillsBlock}` : "",
      }),
    )
    .register(computerInstructionsResource(computerInstructions, { fallback: COMPUTER_FALLBACK }))
    .register(emailPolicyResource(input.mailAvailable, { fallback: EMAIL_POLICY_FALLBACK }));
  return registry.assemble(input.budgetChars ?? CHAT_BUDGET);
}

export {
  CHAT_CORE,
  COMPUTER_FALLBACK,
  computerInstructionsResource,
  EMAIL_POLICY_FALLBACK,
  emailPolicyResource,
  IDENTITY_FALLBACK,
  identityResource,
  MEMORIES_ESTIMATE_CAP,
  memoriesResource,
  SUBAGENT_BRIEF,
  TIMEZONE_FALLBACK,
  taskStateResource,
  timezoneResource,
  WORKER_CORE,
} from "./resources.ts";
export type { AssembledPrompt, ContextPlan };
export { ContextRegistry, inlineResource };
