import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import type { WorkerToolHost } from "../../plugins/plugin-api.ts";
import type { TelegramService } from "./service.ts";

const SEND_DESCRIPTION =
  "Send a direct notification message to the owner's Telegram chat. Call this when you want to proactively alert or message the owner on Telegram.";

const sendParams = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .describe("Message text to send to the owner on Telegram"),
});

export function telegramSendMessageChatTool(service: TelegramService, owner: string) {
  return defineTool({
    name: "telegram_send_message",
    description: SEND_DESCRIPTION,
    parameters: sendParams,
    execute: async ({ text }) => {
      try {
        const result = await service.sendMessage(owner, text);
        return result.ok
          ? { ok: true, message: "Telegram message sent successfully." }
          : { ok: false, error: result.error ?? "Failed to send Telegram message." };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Could not send Telegram message",
        };
      }
    },
  });
}

export function telegramSendMessageWorkerTool(service: TelegramService, host: WorkerToolHost) {
  return host.defineTool(
    "telegram_send_message",
    SEND_DESCRIPTION,
    sendParams,
    async ({ text }) => {
      try {
        const result = await service.sendMessage(host.owner, text);
        return result.ok
          ? { ok: true, message: "Telegram message sent successfully." }
          : { ok: false, error: result.error ?? "Failed to send Telegram message." };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Could not send Telegram message",
        };
      }
    },
  );
}
