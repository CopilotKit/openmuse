import { z } from "zod";
import type { ProjectedActivityEntry } from "./activity-presentation.ts";
import { workboardDispatchSchema } from "./agent.ts";

export type WorkspaceMode = "sample" | "live";
export type Section =
  | "today"
  | "chat"
  | "mail"
  | "calendar"
  | "browser"
  | "files"
  | "activity"
  | "connections"
  | "ideas"
  | "goals"
  | "apps"
  | "connectors"
  | "settings";
export interface Mail {
  id: string;
  threadId: string;
  from: string;
  sender: string;
  to: string[];
  subject: string;
  body: string;
  bodyHtml?: string;
  date: string;
  unread: boolean;
  label: string;
  attachments: string[];
}
export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timeZone: string;
  location: string;
  description: string;
  attendees: string[];
  /** Email account used for this event's invites: an email-account UUID or "google". */
  emailAccountId?: string;
}
export interface Artifact {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  pageCount: number;
  url: string;
  createdAt: string;
  source: string;
  parentId?: string;
  fields?: { name: string; value: string; type: "text" | "checkbox" | "unsupported" }[];
}
export interface BrowserSession {
  id: string;
  title: string;
  url: string;
  status: "idle" | "active" | "closed" | "error";
  updatedAt: string;
  previewUrl?: string;
  consoleUrl?: string;
}
/**
 * Strict RFC 5322 Message-ID shape (`<local@domain>`). The regex inherently
 * rejects CR/LF, so a value that passes here is safe to splice into a mail
 * header. Use at every boundary where a message id becomes a header value.
 */
export const messageIdSchema = z
  .string()
  .regex(/^<[^<>\s]+@[^<>\s]+>$/, "Invalid Message-ID: expected <local@domain>")
  .max(998);

/**
 * Strict WhatsApp JID: a numeric user (or group id) on s.whatsapp.net, or a
 * group on g.us. Display/push names are never identity — only the JID is.
 * Status broadcasts (status@broadcast) and newsletters (@newsletter) are
 * rejected here; the bridge drops them before they reach any handler.
 */
export const whatsappJidSchema = z
  .string()
  .regex(/^\d+@(s\.whatsapp\.net|g\.us)$/, "Invalid WhatsApp JID")
  .max(64);

/** Reviewed-action payload for an approved WhatsApp send (kind whatsapp.send). */
export const whatsappSendSchema = z.object({
  toJid: whatsappJidSchema,
  text: z.string().trim().min(1).max(4096),
});
export type WhatsAppSend = z.infer<typeof whatsappSendSchema>;

export const emailDraftSchema = z.object({
  to: z.array(z.email()).min(1).max(50),
  cc: z.array(z.email()).max(50).default([]),
  bcc: z.array(z.email()).max(50).default([]),
  subject: z
    .string()
    .trim()
    .min(1)
    .max(998)
    .refine((s) => !/[\r\n]/.test(s), "Subject must be a single line"),
  body: z.string().min(1).max(100000),
  attachmentIds: z.array(z.string()).max(10).default([]),
  threadId: z.string().optional(),
  // Polymorphic by backend: a Gmail resource id ("18d3f2a1…") for the Gmail
  // connector, "folder:uid" for IMAP. The strict messageIdSchema cannot apply
  // here (it would break Gmail replies); CR/LF are rejected so the value can
  // never smuggle extra mail headers. Backends validate further: the IMAP send
  // path requires messageIdSchema before building the In-Reply-To header, and
  // the Gmail path pins the value through idPath() ([A-Za-z0-9_-]+ only).
  replyToMessageId: z
    .string()
    .max(998)
    .refine((value) => !/[\r\n]/.test(value), "replyToMessageId must not contain line breaks")
    .optional(),
});
export const eventDraftSchema = z
  .object({
    calendarId: z.string().default("primary"),
    title: z.string().trim().min(1).max(500),
    start: z.string().min(1),
    end: z.string().min(1),
    allDay: z.boolean().default(false),
    timeZone: z.string().default("America/Los_Angeles"),
    location: z.string().max(2000).default(""),
    description: z.string().max(10000).default(""),
    attendees: z.array(z.email()).max(50).default([]),
    // The email account used for this event's invites: an email-account UUID
    // (from /api/email-accounts) or the literal "google" for the connected
    // Google account. Optional everywhere; execution decides whether an
    // invite is actually sent.
    emailAccountId: z.union([z.string().uuid(), z.literal("google")]).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      !Number.isFinite(Date.parse(value.start)) ||
      !Number.isFinite(Date.parse(value.end)) ||
      Date.parse(value.end) <= Date.parse(value.start)
    ) {
      ctx.addIssue({ code: "custom", message: "End must be after a valid start", path: ["end"] });
    }
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
    const timed = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/;
    if (
      !(value.allDay ? dateOnly : timed).test(value.start) ||
      !(value.allDay ? dateOnly : timed).test(value.end)
    ) {
      ctx.addIssue({
        code: "custom",
        message: value.allDay
          ? "All-day events need date-only values"
          : "Timed events need an explicit offset",
        path: ["start"],
      });
    }
    try {
      new Intl.DateTimeFormat("en", { timeZone: value.timeZone });
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid time zone", path: ["timeZone"] });
    }
  });
export const proposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("email.send"), data: emailDraftSchema }),
  // An approved WhatsApp send. Execution goes through the WhatsApp sidecar
  // (app.ts routes it before workspace.execute); the recipient must be on
  // the owner's allow-list or execution is refused with 403.
  z.object({ kind: z.literal("whatsapp.send"), data: whatsappSendSchema }),
  z.object({ kind: z.literal("calendar.create"), data: eventDraftSchema }),
  z.object({
    kind: z.literal("calendar.update"),
    data: eventDraftSchema.and(z.object({ eventId: z.string().min(1) })),
  }),
  z.object({
    kind: z.literal("calendar.delete"),
    data: z.object({ calendarId: z.string(), eventId: z.string().min(1), title: z.string() }),
  }),
  // A workboard fan-out dispatch proposed from chat: spends N model runs, so
  // it goes through the reviewed-action flow like any other external effect.
  workboardDispatchSchema,
]);
export type EmailDraft = z.infer<typeof emailDraftSchema>;
export type EventDraft = z.infer<typeof eventDraftSchema>;
export type ProposalInput = z.infer<typeof proposalSchema>;
export interface ActionProposal {
  target?: CalendarEvent;
  targetVersion?: string;
  taskId?: string;
  account?: string;
  connectionId?: string;
  id: string;
  title: string;
  kind: ProposalInput["kind"];
  data: Record<string, unknown>;
  status:
    | "awaiting_review"
    | "executing"
    | "succeeded"
    | "failed"
    | "outcome_unknown"
    | "denied"
    | "cancelled"
    | "expired";
  hash: string;
  createdAt: string;
  expiresAt: string;
  result?: string;
  error?: string;
}
export interface ActivityEntry {
  id: string;
  title: string;
  detail: string;
  date: string;
  status: string;
  actionId?: string;
}
/**
 * Owner approval for a single agent tool call. Stored under the
 * "tool-approvals" record kind. The approval token itself lives only in
 * server memory (see apps/server/src/engine/tool-policy.ts) — never in this
 * record, in tool results, or in chat text.
 */
export interface ToolApproval {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  owner: string;
  /** Owner + task/thread + browser session binding, e.g. "task:abc:session-1". */
  binding: string;
  /** sha256 of the canonicalized { toolName, args, owner, binding } at approval time. */
  hash: string;
  status: "awaiting_review" | "approved" | "denied" | "expired" | "consumed";
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
}
export interface Connection {
  id: string;
  name: string;
  status: "connected" | "disconnected" | "sample" | "unconfigured";
  account?: string;
  capabilities: string[];
}
export interface Workspace {
  mode: WorkspaceMode;
  profile: { name: string; email: string };
  mail: Mail[];
  events: CalendarEvent[];
  files: Artifact[];
  browsers: BrowserSession[];
  actions: ActionProposal[];
  /** Projected server-side by projectActivityEntries: honest statuses, routine noise filtered. */
  activity: ProjectedActivityEntry[];
  connections: Connection[];
  runtime: {
    provider: "sample" | "model" | "openbot";
    configured: boolean;
    openbotConfigured: boolean;
    richThreads?: boolean;
  };
}

/** Provider-independent boundary: OpenBot/AG-UI runs never dictate presentation. */
export interface ExecutionBackend {
  readonly kind: "standalone" | "openbot";
  readonly capabilities: readonly string[];
  health(): Promise<{ available: boolean; detail: string }>;
}

export * from "./activity-presentation.ts";
export type { ComputerCommand, ComputerDirectory, ComputerSnapshot } from "./computer.ts";
