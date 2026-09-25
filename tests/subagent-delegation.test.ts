import assert from "node:assert/strict";
import test from "node:test";
import type { TelegramService } from "../apps/server/src/connectors/telegram/service.ts";
import type { AgentService } from "../apps/server/src/engine/service.ts";
import { createSubagentDelegationTool } from "../apps/server/src/engine/subagents/delegate.ts";

test("Subagent delegation tool (OpenClaw style)", async (t) => {
  let spawnedPayload: any = null;
  let _telegramSentText: string | null = null;

  const mockAgentService = {
    spawnSubagents: async (_owner: string, input: any) => {
      spawnedPayload = input;
      return {
        spawned: [{ id: "task_123", label: input.subagents[0].label, status: "running" as any }],
        fanoutId: "f1",
      };
    },
    collectSubagents: async (_owner: string, _ids: string[]) => {
      return [
        {
          id: "task_123",
          label: "Research Lead",
          status: "succeeded" as const,
          result: "Found 5 competitor pricing models.",
          error: undefined,
          updatedAt: new Date().toISOString(),
        },
      ];
    },
  } as unknown as AgentService;

  const mockTelegram = {
    sendMessage: async (_owner: string, text: string) => {
      _telegramSentText = text;
      return { ok: true };
    },
  } as unknown as TelegramService;

  const tool = createSubagentDelegationTool(mockAgentService, mockTelegram);

  await t.test("spawns subagent asynchronously with custom role", async () => {
    const res = await tool.execute(
      { owner: "owner" },
      {
        role: "Competitor Researcher",
        task: "Analyze top 3 SaaS competitors in AI productivity",
        notifyTelegram: true,
      },
    );

    assert.equal(res.status, "running");
    assert.equal(res.taskId, "task_123");
    assert.match(res.role, / - Competitor Researcher$/); // animal-prefixed by formatSubagentName
    assert.ok(spawnedPayload);
    assert.match(spawnedPayload.subagents[0].prompt, /Competitor Researcher/);
  });
});
