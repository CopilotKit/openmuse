import { z } from "zod";
import { nextCronRun } from "./cron.ts";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "scheduled"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";
/** Kanban columns of the agent workboard. */
export type CardStatus = "backlog" | "todo" | "doing" | "review" | "done" | "failed";
export const CARD_STATUSES: readonly CardStatus[] = [
  "backlog",
  "todo",
  "doing",
  "review",
  "done",
  "failed",
];
export type CardPriority = "low" | "medium" | "high";
/**
 * A workboard card: a unit of agent work tracked on the Kanban board.
 * Backed by the generic store (kind "workboard-cards"), owner-scoped.
 * Card text is plain text only — never rendered as HTML.
 */
export interface WorkboardCard {
  id: string;
  title: string;
  description: string;
  status: CardStatus;
  priority: CardPriority;
  labels: string[];
  goalId?: string;
  /** Task worker task id, set when the card is dispatched in task mode. */
  taskId?: string;
  /** Fan-out id, set when the card is dispatched in fanout mode. */
  fanoutId?: string;
  /** Child card ids created by a fanout dispatch. */
  childCardIds: string[];
  /** Set on cards created by a fanout dispatch. */
  parentCardId?: string;
  createdBy: "user" | "agent";
  /** Ordering within a column; assigned as max+1 on create. */
  position: number;
  createdAt: string;
  updatedAt: string;
}
/** The workboard.cards.list/stats binding shape: one call renders the board. */
export interface WorkboardStats {
  total: number;
  byStatus: Record<CardStatus, number>;
  /** Cards in doing + review. */
  active: number;
}
export interface Evidence {
  id: string;
  kind: "mail" | "file" | "web" | "user";
  title: string;
  excerpt: string;
  url?: string;
}
export interface TaskStep {
  id: string;
  title: string;
  status: "pending" | "running" | "succeeded" | "failed" | "waiting";
  detail?: string;
}
export interface AgentTask {
  id: string;
  title: string;
  prompt: string;
  kind: "agent" | "document" | "monitor" | "finance" | "plan" | "scheduled";
  status: TaskStatus;
  goalId?: string;
  plan: TaskStep[];
  evidence: Evidence[];
  input: Record<string, unknown>;
  state: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  leaseId?: string | null;
  leaseUntil?: string | null;
  attempts: number;
  actionId?: string | null;
  result?: string;
  error?: string | null;
  question?: string;
  artifactIds: string[];
}
export interface RunEvent {
  id: string;
  taskId: string;
  date: string;
  kind: "plan" | "step" | "observation" | "approval" | "result" | "error" | "status";
  title: string;
  detail: string;
}
export interface Goal {
  id: string;
  title: string;
  description: string;
  category: string;
  status: "active" | "paused" | "completed";
  milestones: { id: string; title: string; done: boolean }[];
  createdAt: string;
}
export interface Monitor {
  id: string;
  taskId: string;
  title: string;
  url: string;
  condition: "change" | "contains" | "price_below";
  value: string;
  intervalMinutes: number;
  status: "active" | "paused" | "stopped";
  nextCheckAt: string;
  lastCheckedAt?: string;
  lastValue?: string;
  lastHash?: string;
  error?: string;
  checks: number;
}
export interface Schedule {
  id: string;
  taskId: string;
  title: string;
  cron: string;
  timezone: string;
  prompt: string;
  status: "active" | "paused" | "stopped";
  nextRunAt: string;
  lastRunAt?: string;
  lastResult?: string;
  error?: string;
  runs: number;
  createdAt: string;
}
export interface Idea {
  id: string;
  title: string;
  reason: string;
  evidence: Evidence[];
  prompt: string;
  kind: AgentTask["kind"];
  input: Record<string, unknown>;
  status: "new" | "dismissed" | "accepted";
  taskId?: string;
  createdAt: string;
}
export interface AgentMemory {
  id: string;
  text: string;
  source: string;
  createdAt: string;
}
/**
 * A "remember this" moment captured from a user turn, awaiting human review.
 * Additive: AgentMemory is untouched. Candidates live under the
 * "memory-candidates" store kind with status "pending" and are NEVER written
 * into "memories" except by an explicit authenticated approveCandidate() call.
 */
export interface MemoryCandidate {
  id: string;
  text: string;
  source: string;
  status: "pending" | "approved" | "rejected";
  /** Id of an existing memory this candidate contradicts, when detected. */
  conflictWith?: string;
  createdAt: string;
}
export interface AgentArtifact {
  id: string;
  taskId: string;
  kind: "plan" | "comparison" | "finance" | "report";
  title: string;
  summary: string;
  data: Record<string, unknown>;
  createdAt: string;
}
export interface AgentNotification {
  id: string;
  taskId?: string;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
}
export interface AgentIdentity {
  name: string;
  tone: "warm" | "concise" | "thoughtful";
  avatar?: "sky" | "sand" | "lilac";
  showChatUpdates?: boolean;
}
export interface AgentWorkspace {
  tasks: AgentTask[];
  goals: Goal[];
  monitors: Monitor[];
  schedules: Schedule[];
  ideas: Idea[];
  memories: AgentMemory[];
  memoryCandidates: MemoryCandidate[];
  artifacts: AgentArtifact[];
  notifications: AgentNotification[];
  identity: AgentIdentity;
  worker: { running: boolean; lastTickAt?: string };
}
export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  prompt: z.string().trim().min(1).max(12000),
  kind: z.enum(["agent", "document", "monitor", "finance", "plan", "scheduled"]).default("agent"),
  goalId: z.string().optional(),
  input: z.record(z.string(), z.unknown()).default({}),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export const MAX_SUBAGENTS = 5;
export const spawnSubagentsSchema = z.object({
  purpose: z.string().trim().min(1).max(160).optional(),
  goalId: z.string().optional(),
  subagents: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(120),
        prompt: z.string().trim().min(1).max(12000),
      }),
    )
    .min(1)
    .max(MAX_SUBAGENTS),
});
export type SpawnSubagentsInput = z.infer<typeof spawnSubagentsSchema>;
/**
 * Reviewed-action payload for a workboard fan-out dispatch requested from
 * chat. The agent proposes; the owner approves in the app; approval executes
 * the dispatch via WorkboardService. All parameters are pinned at propose
 * time so the approval applies to the exact details shown.
 */
export const workboardDispatchSchema = z.object({
  kind: z.literal("workboard.dispatch"),
  data: z.object({
    cardId: z.string().min(1).max(200),
    cardTitle: z.string().trim().min(1).max(160),
    mode: z.enum(["task", "fanout"]),
    /** Fully-resolved task prompt (card text wrapped as data), for task mode. */
    prompt: z.string().trim().min(1).max(12000).optional(),
    goalId: z.string().min(1).max(200).optional(),
    purpose: z.string().trim().max(160).optional(),
    subagents: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(120),
          prompt: z.string().trim().min(1).max(12000),
        }),
      )
      .min(1)
      .max(MAX_SUBAGENTS)
      .optional(),
  }),
});
export type WorkboardDispatchInput = z.infer<typeof workboardDispatchSchema>;
export const monitorInputSchema = z
  .object({
    title: z.string().min(1).max(160),
    url: z.url().max(4096),
    condition: z.enum(["change", "contains", "price_below"]).default("change"),
    value: z.string().max(300).default(""),
    intervalMinutes: z.number().int().min(1).max(10080).default(15),
  })
  .superRefine((v, c) => {
    if (v.condition !== "change" && !v.value.trim())
      c.addIssue({ code: "custom", message: "Enter a condition value" });
    if (
      v.condition === "price_below" &&
      (!Number.isFinite(Number(v.value)) || Number(v.value) <= 0)
    )
      c.addIssue({ code: "custom", message: "Enter a positive price" });
  });
export const goalInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().max(4000).default(""),
  category: z.string().max(80).default("Personal"),
  milestones: z.array(z.string().min(1).max(200)).max(20).default([]),
});
export const scheduleInputSchema = z
  .object({
    title: z.string().min(1).max(160),
    prompt: z.string().trim().min(1).max(12000),
    cron: z.string().trim().min(1).max(100),
    timezone: z.string().trim().min(1).max(80).default("America/Chicago"),
  })
  .superRefine((v, c) => {
    try {
      nextCronRun(v.cron, v.timezone, new Date());
    } catch (error) {
      c.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid schedule",
      });
    }
  });
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;
