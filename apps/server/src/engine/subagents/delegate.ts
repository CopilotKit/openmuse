import { z } from "zod";
import type { TelegramService } from "../../connectors/telegram/service.ts";
import type { AgentService } from "../service.ts";

export interface SubagentDelegationResult {
  taskId: string;
  role: string;
  status: "queued" | "running";
  message: string;
}

export const ANIMAL_NAMES = [
  "Turtle",
  "Falcon",
  "Otter",
  "Beaver",
  "Fox",
  "Cheetah",
  "Owl",
  "Badger",
  "Panda",
  "Dolphin",
  "Koala",
  "Hawk",
  "Wolf",
  "Lynx",
  "Raven",
  "Tiger",
  "Bear",
  "Eagle",
];

export function pickAnimalForTopic(topic: string): string {
  let hash = 0;
  for (let i = 0; i < topic.length; i++) {
    hash = (hash << 5) - hash + topic.charCodeAt(i);
    hash |= 0;
  }
  return ANIMAL_NAMES[Math.abs(hash) % ANIMAL_NAMES.length];
}

export function formatSubagentName(role: string, taskPrompt = ""): string {
  const clean = role.trim();
  const hasAnimal = ANIMAL_NAMES.some((a) => clean.toLowerCase().startsWith(a.toLowerCase()));
  if (hasAnimal && clean.includes(" - ")) return clean;
  const animal = hasAnimal ? clean.split(" - ")[0] : pickAnimalForTopic(taskPrompt || clean);
  const topic = hasAnimal
    ? clean.replace(new RegExp(`^${animal}\\s*(-)?\\s*`, "i"), "").trim() || "Specialist"
    : clean;
  return `${animal} - ${topic}`;
}

export function createSubagentDelegationTool(
  agentService: AgentService,
  telegram?: TelegramService,
) {
  return {
    name: "delegate_to_subagent",
    description:
      "Spawn an autonomous background sub-agent with a specialized role (e.g. 'Turtle - Fixing email issue', 'Falcon - Market Research') to perform work asynchronously without blocking the user conversation.",
    parameters: z.object({
      role: z
        .string()
        .describe(
          "Specialized role or title for the sub-agent (can be formatted as 'Animal - Topic' e.g. 'Turtle - Fixing email issue')",
        ),
      task: z
        .string()
        .describe(
          "Detailed, self-contained prompt describing what the sub-agent should accomplish",
        ),
      notifyTelegram: z
        .boolean()
        .optional()
        .describe(
          "Whether to send a Telegram push notification when the sub-agent finishes (default true)",
        ),
    }),
    requiresApproval: false,
    execute: async (
      ctx: { owner?: string; threadId?: string },
      args: { role: string; task: string; notifyTelegram?: boolean },
    ): Promise<SubagentDelegationResult> => {
      const owner = ctx?.owner || "default";
      const subagentName = formatSubagentName(args.role, args.task);
      const result = await agentService.spawnSubagents(
        owner,
        {
          subagents: [
            {
              label: subagentName,
              prompt: `[Role: ${subagentName}]
${args.task}`,
            },
          ],
        },
        { depth: 0, threadId: ctx?.threadId },
      );

      const spawned = result.spawned[0];
      const notify = args.notifyTelegram !== false;

      if (notify && telegram && spawned) {
        const checkInterval = setInterval(async () => {
          try {
            const status = await agentService.collectSubagents(owner, [spawned.id]);
            const entry = status[0];
            if (entry && (entry.status === "succeeded" || entry.status === "failed")) {
              clearInterval(checkInterval);
              const icon = entry.status === "succeeded" ? "✅" : "❌";
              const text = `${icon} *Sub-Agent Finished: ${subagentName}*

Status: ${entry.status}
Result: ${entry.result || "Completed"}`;
              await telegram.sendMessage(owner, text).catch(() => {});
            }
          } catch {
            clearInterval(checkInterval);
          }
        }, 5000);
        if (checkInterval.unref) checkInterval.unref();
      }

      return {
        taskId: spawned ? spawned.id : "subagent_task",
        role: subagentName,
        status: "running",
        message: `Sub-agent "${subagentName}" spawned successfully (Task ID: ${spawned ? spawned.id : "pending"}). Working in background.`,
      };
    },
  };
}
