import { choice, score, TypeSafeClient } from "@typesafe-ai/sdk";
import type { JevOption } from "../../../../packages/domain/src/jev.ts";

export type JevControl = "clarification" | "comparison" | "agent";
export type JevDecisionInput = {
  message: string;
  context: string;
  options: JevOption[];
  allowedControls: JevControl[];
  selectedId?: string;
};
export type JevDecision = { control: JevControl; scores: Record<string, number> };
export interface JevAdapter {
  decide(input: JevDecisionInput, signal: AbortSignal): Promise<JevDecision>;
}
export function rankJevOptions(options: JevOption[], decision: JevDecision): JevOption[] {
  const ids = new Set(options.map((option) => option.id));
  if (
    Object.keys(decision.scores).length !== options.length ||
    Object.keys(decision.scores).some((id) => !ids.has(id))
  )
    throw new Error("Jev returned invalid score IDs");
  options.forEach((option) => {
    if (!Number.isFinite(decision.scores[option.id]))
      throw new Error("Jev returned a missing or invalid score");
  });
  return options
    .map((option, index) => ({ option, index }))
    .sort(
      (a, b) => decision.scores[b.option.id] - decision.scores[a.option.id] || a.index - b.index,
    )
    .map(({ option }) => option);
}
export class SampleJevAdapter implements JevAdapter {
  async decide(input: JevDecisionInput, signal: AbortSignal): Promise<JevDecision> {
    signal.throwIfAborted();
    const handsOn = /hands[ -]?on|touch|interactive/i.test(input.message);
    const scores = Object.fromEntries(
      input.options.map((option, index) => [
        option.id,
        handsOn && /touch|rocky|interactive/i.test(`${option.label} ${option.details.join(" ")}`)
          ? 10
          : input.options.length - index,
      ]),
    );
    return {
      control: input.allowedControls.includes("comparison")
        ? "comparison"
        : input.allowedControls[0],
      scores,
    };
  }
}
type ClientPort = Pick<TypeSafeClient, "systemOne">;
export class LiveJevAdapter implements JevAdapter {
  constructor(
    private readonly client: ClientPort,
    private readonly model = "jev-1.13.0",
  ) {}
  static withKey(apiKey: string, model?: string): LiveJevAdapter {
    return new LiveJevAdapter(new TypeSafeClient({ apiKey }), model);
  }
  async decide(input: JevDecisionInput, signal: AbortSignal): Promise<JevDecision> {
    signal.throwIfAborted();
    if (!input.allowedControls.length) throw new Error("Jev has no allowed controls");
    const questions = {
      control: choice(
        "Which interaction best serves the user now? Present prepared choices when they let the user select a useful, supported next step. Choose an ordinary agent response only when those options are unhelpful or unsupported.",
        Object.fromEntries(
          input.allowedControls.map((control) => [
            control,
            control === "clarification"
              ? "Present the prepared options as clickable next steps"
              : control === "comparison"
                ? "Present the sourced candidates as clickable comparison cards"
                : "Answer the user in prose without choice cards",
          ]),
        ),
      ),
      ...Object.fromEntries(
        input.options.map((option, index) => [
          `fit_${index}`,
          score(
            `How well does option ${index} (${option.label}) fit the user's latest request? Use its verified details in the state as evidence.`,
            ["Does not fit", "Some fit", "Good fit", "Best fit"],
          ),
        ]),
      ),
    };
    const result = await this.client
      .systemOne(
        {
          model: this.model,
          state: {
            message: input.message,
            context: input.context,
            selectedId: input.selectedId ?? null,
            options: input.options,
          },
          questions,
        },
        { signal },
      )
      .catch((error: unknown) => {
        signal.throwIfAborted();
        throw new Error("Jev could not evaluate these choices. Please retry.", { cause: error });
      });
    signal.throwIfAborted();
    if (
      !result ||
      typeof result !== "object" ||
      !result.answers ||
      typeof result.answers !== "object" ||
      Array.isArray(result.answers)
    )
      throw new Error("Jev returned invalid answers");
    const answers = result.answers as Record<
      string,
      { type?: string; choice?: string; score?: number }
    >;
    const control = answers.control?.choice;
    if (
      answers.control?.type !== "choice" ||
      !input.allowedControls.includes(control as JevControl)
    )
      throw new Error("Jev returned an invalid control");
    const scores: Record<string, number> = {};
    input.options.forEach((option, index) => {
      const answer = answers[`fit_${index}`];
      if (
        answer?.type !== "score" ||
        typeof answer.score !== "number" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > 3
      )
        throw new Error("Jev returned an invalid score");
      scores[option.id] = answer.score;
    });
    return { control: control as JevControl, scores };
  }
}
