import {
  type BuiltInAgentLearnedSkillsOptions,
  CopilotKitIntelligence,
  type LearningContainerSelectorInput,
} from "@copilotkit/runtime/v2";
import type { Config } from "./config.ts";

// Automatic Learning is opt-in and scoped to live Threads produced by OpenMuse's built-in
// model agent, the same executor that receives published Skills. External AG-UI backends
// are not collected, so evidence and delivery stay on one runtime boundary.
export function learningContainerFor(config: Config): string | undefined {
  if (config.mode !== "live" || config.agentBackend !== "model") return undefined;
  return config.intelligenceLearningContainerId?.trim() || undefined;
}

export function selectLearningContainer(
  config: Config,
  { agentId }: Pick<LearningContainerSelectorInput, "agentId">,
): string | undefined {
  return agentId === "default" ? learningContainerFor(config) : undefined;
}

export function createIntelligence(
  config: Config & { intelligenceApiKey: string },
): CopilotKitIntelligence {
  return new CopilotKitIntelligence({
    apiKey: config.intelligenceApiKey,
    getLearningContainerId: (input) => selectLearningContainer(config, input),
  });
}

export function learnedSkillsFor(
  config: Config,
  intelligence: CopilotKitIntelligence,
): BuiltInAgentLearnedSkillsOptions | undefined {
  const containerId = learningContainerFor(config);
  return containerId ? { client: intelligence, containerId } : undefined;
}
