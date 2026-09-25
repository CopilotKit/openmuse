import { z } from "zod";
import { CARD_STATUSES, MAX_SUBAGENTS } from "../../../../packages/domain/src/agent.ts";

export const cardStatusSchema = z.enum(CARD_STATUSES);
export const cardPrioritySchema = z.enum(["low", "medium", "high"]);

const titleSchema = z.string().trim().min(1).max(160);
const descriptionSchema = z.string().max(4000);
const labelsSchema = z.array(z.string().trim().min(1).max(40)).max(20);
const goalIdSchema = z.string().min(1).max(200);

export const createCardSchema = z.object({
  title: titleSchema,
  description: descriptionSchema.default(""),
  status: cardStatusSchema.default("backlog"),
  priority: cardPrioritySchema.default("medium"),
  labels: labelsSchema.default([]),
  goalId: goalIdSchema.optional(),
});
export type CreateCardInput = z.input<typeof createCardSchema>;

export const updateCardSchema = z
  .object({
    title: titleSchema,
    description: descriptionSchema,
    priority: cardPrioritySchema,
    labels: labelsSchema,
    goalId: goalIdSchema.nullable(),
  })
  .partial();
export type UpdateCardInput = z.input<typeof updateCardSchema>;

/**
 * Moving a card is a compare-and-swap on updatedAt: the caller passes the
 * updatedAt it last saw, and a stale value is rejected (409) so a
 * concurrent move by the worker or another client is never silently
 * overwritten.
 */
export const moveCardSchema = z.object({
  status: cardStatusSchema,
  updatedAt: z.string().min(1).max(100),
});
export type MoveCardInput = z.input<typeof moveCardSchema>;

const subagentSpecSchema = z.object({
  label: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(12000),
});

export const dispatchCardSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("task"),
    prompt: z.string().trim().min(1).max(12000).optional(),
    goalId: goalIdSchema.optional(),
  }),
  z.object({
    mode: z.literal("fanout"),
    purpose: z.string().trim().max(160).optional(),
    goalId: goalIdSchema.optional(),
    subagents: z.array(subagentSpecSchema).min(1).max(MAX_SUBAGENTS),
  }),
]);
export type DispatchCardInput = z.input<typeof dispatchCardSchema>;
