import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { type JevToolResult, jevOptionSchema } from "../../../../packages/domain/src/jev.ts";
import type { JevService } from "./service.ts";

const optionInput = jevOptionSchema
  .omit({ id: true })
  .extend({ id: z.string().trim().min(1).max(200).optional() });
export const presentChoicesParameters = z
  .object({
    message: z.string().trim().min(1).max(2000),
    context: z.string().trim().min(1).max(8000),
    title: z.string().trim().min(1).max(200),
    control: z.enum(["clarification", "comparison"]),
    options: z.array(optionInput).min(1).max(12),
    refinementPanelId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export function presentChoicesTool(
  jev: JevService,
  owner: string,
  threadId: string,
  turnId: string,
  signal: AbortSignal,
  mode: "sample" | "live",
) {
  return defineTool({
    name: "present_choices",
    description:
      "Present prepared clarification buttons or a sourced comparison after reading evidence. Give 1–12 factual options. Refine an earlier panel with refinementPanelId; the server reuses the full original candidate set. This only asks the user for a preference and performs no external action.",
    parameters: presentChoicesParameters,
    execute: async (input): Promise<JevToolResult> => {
      try {
        signal.throwIfAborted();
        if (
          mode === "live" &&
          input.control === "clarification" &&
          !(await jev.hasAnyMailEvidence(owner, threadId))
        )
          throw new Error("Read the relevant email before presenting choices.");
        if (mode === "live" && input.control === "comparison") {
          for (const option of input.options)
            for (const source of option.sources)
              if (!(await jev.hasEvidence(owner, threadId, "web", source.url)))
                throw new Error(`Read the source page before comparing: ${source.url}`);
        }
        return await jev.createPanel(owner, threadId, turnId, input, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        const message =
          error instanceof Error ? error.message : "Could not prepare choices. Please retry.";
        return {
          panel: null,
          error: message.length < 300 ? message : "Could not prepare choices. Please retry.",
        };
      }
    },
  });
}
