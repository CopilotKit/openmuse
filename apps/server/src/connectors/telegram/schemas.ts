import { z } from "zod";

export const telegramConfigSchema = z.object({
  botToken: z.string().min(1, "Bot token is required"),
  ownerChatId: z.string().min(1, "Owner chat ID is required"),
  enabled: z.boolean().default(true),
});

export type TelegramConfigInput = z.infer<typeof telegramConfigSchema>;

export const telegramStatusSchema = z.object({
  enabled: z.boolean(),
  running: z.boolean(),
  ownerChatId: z.string().optional(),
  botUsername: z.string().optional(),
  lastSeenAt: z.string().optional(),
  error: z.string().optional(),
});

export type TelegramStatus = z.infer<typeof telegramStatusSchema>;

export const telegramSendMessageSchema = z.object({
  chatId: z.string().min(1, "Chat ID is required"),
  text: z.string().min(1, "Message text is required").max(4096),
});

export type TelegramSendMessageInput = z.infer<typeof telegramSendMessageSchema>;
