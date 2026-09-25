import { z } from "zod";
import { whatsappJidSchema, whatsappSendSchema } from "../../../../../packages/domain/src/index.ts";

export { whatsappJidSchema, whatsappSendSchema };

/** Explicit opt-in: the user accepts the unofficial-client ban risk. */
export const whatsappConsentSchema = z.object({
  accepted: z.boolean(),
});
export type WhatsAppConsent = z.infer<typeof whatsappConsentSchema>;

/** Allow/deny rule for one JID. Inbound is default-deny; outbound requires allow. */
export const whatsappRuleSchema = z.object({
  jid: whatsappJidSchema,
  action: z.enum(["allow", "deny"]),
  label: z.string().trim().min(1).max(120).optional(),
});
export type WhatsAppRuleInput = z.infer<typeof whatsappRuleSchema>;

export const whatsappRuleIdSchema = z.string().min(1).max(200);

/** Stripped inbound message, as forwarded by the sidecar. Never raw Baileys payloads. */
export const whatsappInboundSchema = z.object({
  owner: z.string().min(1).max(200),
  message: z.object({
    fromJid: whatsappJidSchema,
    chatJid: whatsappJidSchema,
    text: z.string().max(8192),
    hasMedia: z.boolean(),
    messageId: z.string().min(1).max(200),
    timestamp: z.number().int().nonnegative(),
  }),
});
export type WhatsAppInbound = z.infer<typeof whatsappInboundSchema>;

export const whatsappRecentQuerySchema = z.object({
  query: z.string().trim().max(500).default(""),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const whatsappSendRequestSchema = whatsappSendSchema.extend({
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export type WhatsAppSendRequest = z.infer<typeof whatsappSendRequestSchema>;
