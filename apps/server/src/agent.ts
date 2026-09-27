import "./config.ts";
import { HttpAgent } from "@ag-ui/client";
import {
  type AgentsFactory,
  type CopilotKitIntelligence,
  CopilotRuntime,
  createCopilotHonoHandler,
} from "@copilotkit/runtime/v2";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import { ConversationAgent } from "./engine/conversation.ts";
import type { AgentService } from "./engine/service.ts";

export function agentConfigured(config: Config) {
  const hasModel = Boolean(config.model ?? config.chatModel ?? config.taskModel);
  return (
    config.agentBackend === "sample" ||
    (config.agentBackend === "agui"
      ? Boolean(config.agentUrl)
      : Boolean(
          hasModel &&
            (process.env.OPENAI_API_KEY ||
              process.env.ANTHROPIC_API_KEY ||
              process.env.GOOGLE_API_KEY),
        ))
  );
}
/**
 * Resolve the effective model configuration with fallbacks, for the health
 * endpoint and client discovery. Returns undefined when a route has no model
 * configured (sample mode, or a slot not set).
 */
export function modelInfo(config: Config) {
  const chatModel = config.chatModel ?? config.model ?? undefined;
  const taskModel = config.taskModel ?? config.model ?? config.chatModel ?? undefined;
  const simpleTaskModel = config.simpleTaskModel ?? config.chatModel ?? config.model ?? undefined;
  return {
    chatModel,
    taskModel,
    simpleTaskModel,
    maxSteps: {
      chat: config.chatMaxSteps ?? 6,
      task: config.taskMaxSteps ?? 16,
      simpleTask: config.simpleTaskMaxSteps ?? 6,
    },
    simpleTaskKinds: ["monitor", "finance"] as const,
  };
}
export function makeRuntime(
  config: Config,
  service: AgentService,
  auth: Auth,
  intelligence: CopilotKitIntelligence,
) {
  const agents: AgentsFactory = async ({ request }) => {
    if (config.agentBackend === "agui")
      return {
        default: new HttpAgent({
          url: config.agentUrl ?? "http://127.0.0.1:1/unconfigured",
          headers: config.agentToken ? { Authorization: `Bearer ${config.agentToken}` } : {},
        }),
      };
    const device = await auth.device(request.headers.get("authorization") ?? undefined);
    return {
      default: new ConversationAgent(config, service, device.owner, {
        deviceId: device.deviceId,
        deviceName: device.deviceName,
      }),
    };
  };
  const runtime = new CopilotRuntime({
    agents,
    intelligence,
    identifyUser: async (request) => ({
      id: await auth.owner(request.headers.get("authorization") ?? undefined),
      name: "OpenMuse user",
    }),
    generateThreadNames: false,
  });
  return createCopilotHonoHandler({ runtime, basePath: "/api/copilotkit" });
}
