import {
  type BuiltInAgentLearnedSkillsOptions,
  CopilotKitIntelligence,
  type LearningContainerSelectorInput,
} from "@copilotkit/runtime/v2";
import type { Config } from "./config.ts";

export function selectLearningContainer(
  config: Config,
  { agentId }: Pick<LearningContainerSelectorInput, "agentId">,
): string | undefined {
  if (config.mode !== "live" || agentId !== "default") return undefined;
  return config.intelligenceLearningContainerId;
}

export function createIntelligence(config: Config): CopilotKitIntelligence | undefined {
  const apiKey = config.intelligenceApiKey?.trim();
  if (!apiKey) return undefined;
  return new CopilotKitIntelligence({
    apiKey,
    getLearningContainerId: (input) => selectLearningContainer(config, input),
  });
}

export function learnedSkillsFor(
  config: Config,
  intelligence: CopilotKitIntelligence | undefined,
): BuiltInAgentLearnedSkillsOptions | undefined {
  if (
    config.mode !== "live" ||
    config.agentBackend !== "model" ||
    !intelligence ||
    !config.intelligenceLearningContainerId
  ) {
    return undefined;
  }
  return { client: intelligence, containerId: config.intelligenceLearningContainerId };
}
