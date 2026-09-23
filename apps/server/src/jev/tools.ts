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
    options: z.array(optionInput).max(12),
    mailThreadId: z.string().trim().min(1).max(500).optional(),
    refinementPanelId: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (!input.refinementPanelId && input.options.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "New choices need at least one option",
      });
  });
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
      "Present prepared clarification buttons or a sourced comparison after reading evidence. For choices based on a read email, include its mailThreadId; generic choices need no mail. Give 1–12 factual options for a new panel. Comparison details must be exact excerpts from the read source page. To refine an earlier panel, supply refinementPanelId and leave options empty; the server reuses the full original candidate set. This only asks the user for a preference and performs no external action.",
    parameters: presentChoicesParameters,
    execute: async (input): Promise<JevToolResult> => {
      try {
        signal.throwIfAborted();
        if (
          mode === "live" &&
          input.mailThreadId &&
          !(await jev.hasEvidence(owner, threadId, turnId, "mail", input.mailThreadId))
        )
          throw new Error("Read the referenced email before presenting choices.");
        if (mode === "live" && input.control === "comparison") {
          if (input.refinementPanelId) {
            await jev.candidateSources(owner, threadId, input.refinementPanelId);
          } else {
            for (const option of input.options) {
              const texts: string[] = [];
              for (const source of option.sources) {
                const observed = await jev.evidenceText(owner, threadId, turnId, "web", source.url);
                if (!observed)
                  throw new Error(`Read the source page before comparing: ${source.url}`);
                texts.push(observed.replace(/\s+/g, " ").toLowerCase());
              }
              for (const detail of option.details)
                if (
                  !texts.some((observed) =>
                    observed.includes(detail.replace(/\s+/g, " ").toLowerCase()),
                  )
                )
                  throw new Error(
                    `Comparison detail is not present in source text: ${option.label}`,
                  );
            }
          }
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
