import { z } from "zod";
import type { BoardState } from "./board.ts";
import { CAPABILITIES, type Capability } from "./capabilities.ts";

/** Board state for a task that has never been moved on the board. */
export const DEFAULT_BOARD_STATE: BoardState = "Backlog";

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
export interface Evidence {
  id: string;
  kind: "mail" | "file" | "web" | "user";
  title: string;
  excerpt: string;
  url?: string | undefined;
}
export interface TaskStep {
  id: string;
  title: string;
  status: "pending" | "running" | "succeeded" | "failed" | "waiting";
  detail?: string | undefined;
}
export interface AgentTask {
  id: string;
  title: string;
  prompt: string;
  kind: "agent" | "document" | "monitor" | "finance" | "plan";
  status: TaskStatus;
  /**
   * Where the task sits on the user's board. Optional so rows written before
   * the board layer existed still load; treat a missing value as
   * `DEFAULT_BOARD_STATE`. Never infer this from `status`: waiting for your
   * approval and blocked-on-a-dependency are different things.
   */
  boardState?: BoardState | undefined;
  goalId?: string | undefined;
  plan: TaskStep[];
  evidence: Evidence[];
  input: Record<string, unknown>;
  state: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /**
   * The device that created this task. Execution is per-device, so this is the
   * scheduler's preferred home for the task, not an ownership marker: the task
   * travels with the user and may be resumed elsewhere if a capable device is
   * live (see `capabilities.ts`).
   */
  deviceId?: string | undefined;
  /**
   * What this task needs from a device to run. Optional so tasks written before
   * the capability layer existed still load; an absent value means "needs
   * nothing device-local", which is deliberately the most permissive reading —
   * refusing those would strand every existing task.
   */
  requiredCapabilities?: Capability[] | undefined;
  nextRunAt?: string | undefined;
  leaseId?: string | null | undefined;
  leaseUntil?: string | null | undefined;
  attempts: number;
  actionId?: string | null | undefined;
  result?: string | undefined;
  error?: string | null | undefined;
  question?: string | undefined;
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
  lastCheckedAt?: string | undefined;
  lastValue?: string | undefined;
  lastHash?: string | undefined;
  error?: string | undefined;
  checks: number;
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
  taskId?: string | undefined;
  createdAt: string;
}
export interface AgentMemory {
  id: string;
  text: string;
  source: string;
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
  taskId?: string | undefined;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
}
export interface AgentIdentity {
  name: string;
  tone: "warm" | "concise" | "thoughtful";
  avatar?: "sky" | "sand" | "lilac" | undefined;
  showChatUpdates?: boolean | undefined;
}
export interface AgentWorkspace {
  tasks: AgentTask[];
  goals: Goal[];
  monitors: Monitor[];
  ideas: Idea[];
  memories: AgentMemory[];
  artifacts: AgentArtifact[];
  notifications: AgentNotification[];
  identity: AgentIdentity;
  worker: { running: boolean; lastTickAt?: string | undefined };
}
/** Server-side model routing configuration, returned by /api/agent/models. */
export interface ModelRoutingInfo {
  chatModel?: string | undefined;
  taskModel?: string | undefined;
  simpleTaskModel?: string | undefined;
  maxSteps: {
    chat: number;
    task: number;
    simpleTask: number;
  };
  simpleTaskKinds: readonly ("monitor" | "finance")[];
  chatToolAllowlist?: string[] | undefined;
}
/** Per-device model routing overrides; stored server-side keyed by deviceId. */
export interface DeviceModelRouting {
  chatModel?: string | undefined;
  taskModel?: string | undefined;
  simpleTaskModel?: string | undefined;
  chatMaxSteps?: number | undefined;
  taskMaxSteps?: number | undefined;
  simpleTaskMaxSteps?: number | undefined;
  /** Override for the server-wide CHAT_TOOL_ALLOWLIST (comma-separated). */
  chatToolAllowlist?: string[] | undefined;
}
export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  prompt: z.string().trim().min(1).max(12000),
  kind: z.enum(["agent", "document", "monitor", "finance", "plan"]).default("agent"),
  goalId: z.string().optional(),
  input: z.record(z.string(), z.unknown()).default({}),
  /**
   * What the task needs from a device to run it. Validated against the known
   * capability vocabulary rather than taken on trust: a task must not be able to
   * declare a requirement the server cannot evaluate.
   */
  requiredCapabilities: z
    .array(z.enum(CAPABILITIES))
    .max(CAPABILITIES.length)
    .default([])
    .optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
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
