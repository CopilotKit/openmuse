import { createHash, randomUUID } from "node:crypto";
import {
  type ActionProposal,
  type CalendarEvent,
  type ProposalInput,
  proposalSchema,
} from "../../../packages/domain/src/index.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

interface Options {
  execute: (
    owner: string,
    input: ProposalInput,
    connectionId?: string,
    targetVersion?: string,
  ) => Promise<string>;
  prepare?: (
    owner: string,
    input: ProposalInput,
    connectionId?: string,
  ) => Promise<{
    input: ProposalInput;
    target?: CalendarEvent;
    targetVersion?: string;
  }>;
  connected: (owner: string) => Promise<boolean>;
  connection?: (owner: string) => Promise<{ id: string; account: string } | null>;
  /**
   * Email-specific connection used for email.send proposals. Defaults to the
   * Google connection; when provided, IMAP/SMTP accounts can approve and
   * execute sends too.
   */
  emailConnected?: (owner: string) => Promise<boolean>;
  emailConnection?: (owner: string) => Promise<{ id: string; account: string } | null>;
  /**
   * WhatsApp-specific connection used for whatsapp.send proposals. Unlike
   * email/Google, the "connection" is the paired Baileys socket: the send
   * is gated on it being connected at both proposal and execution time, and
   * execution additionally requires the recipient to be on the allow-list.
   */
  whatsappConnected?: (owner: string) => Promise<boolean>;
  whatsappConnection?: (owner: string) => Promise<{ id: string; account: string } | null>;
  now?: () => number;
}
export class ActionService {
  private readonly now: () => number;
  constructor(
    private readonly db: Store,
    private readonly options: Options,
  ) {
    this.now = options.now ?? Date.now;
  }
  async propose(
    owner: string,
    raw: unknown,
    idempotencyKey?: string,
    taskId?: string,
  ): Promise<ActionProposal> {
    const id =
      idempotencyKey === undefined
        ? randomUUID()
        : createHash("sha256").update(idempotencyKey).digest("hex");
    if (idempotencyKey !== undefined) {
      const existing = await this.db.get<ActionProposal>(owner, "actions", id);
      if (existing) return existing;
    }
    const parsed = proposalSchema.parse(raw);
    const forEmail = parsed.kind === "email.send";
    const forWhatsApp = parsed.kind === "whatsapp.send";
    const forCalendar =
      parsed.kind === "calendar.create" ||
      parsed.kind === "calendar.update" ||
      parsed.kind === "calendar.delete";
    // A workboard dispatch needs no account connection: it only spends task
    // worker runs, which the owner's approval authorizes.
    const connectionFor =
      parsed.kind === "workboard.dispatch"
        ? undefined
        : forWhatsApp
          ? (this.options.whatsappConnection ?? this.options.connection)
          : forEmail
            ? (this.options.emailConnection ?? this.options.connection)
            : this.options.connection;
    const connection = await connectionFor?.(owner);
    if (connectionFor && !connection && !forCalendar)
      throw new AppError(
        forWhatsApp
          ? "Pair WhatsApp before preparing an action"
          : "Connect an email account before preparing an action",
        409,
      );
    const prepared = await this.options.prepare?.(owner, parsed, connection?.id);
    const input = proposalSchema.parse(prepared?.input ?? parsed);
    const title =
      input.kind === "email.send"
        ? `Send “${input.data.subject}”`
        : input.kind === "whatsapp.send"
          ? `Send WhatsApp to ${input.data.toJid}`
          : input.kind === "workboard.dispatch"
            ? input.data.mode === "fanout"
              ? `Fan out ${input.data.subagents?.length ?? "?"} subagents for “${input.data.cardTitle}”`
              : `Dispatch “${input.data.cardTitle}” as a task`
            : input.kind === "calendar.delete"
              ? `Delete ${input.data.title}`
              : `${input.kind === "calendar.create" ? "Create" : "Update"} ${input.data.title}`;
    const createdAt = new Date(this.now()).toISOString();
    const proposal: ActionProposal = {
      id,
      taskId,
      title,
      kind: input.kind,
      data: input.data,
      account: connection?.account,
      connectionId: connection?.id,
      target: prepared?.target,
      targetVersion: prepared?.targetVersion,
      status: "awaiting_review",
      hash: createHash("sha256")
        .update(
          JSON.stringify({
            input,
            connection,
            target: prepared?.target,
            targetVersion: prepared?.targetVersion,
          }),
        )
        .digest("hex"),
      createdAt,
      expiresAt: new Date(this.now() + 30 * 60 * 1000).toISOString(),
    };
    const saved =
      idempotencyKey === undefined
        ? await this.db.put(owner, "actions", proposal)
        : await this.db.insertIfAbsent(owner, "actions", proposal);
    if (!saved) {
      const existing = await this.db.get<ActionProposal>(owner, "actions", id);
      if (!existing) throw new AppError("Prepared action could not be loaded", 409);
      return existing;
    }
    await this.record(owner, saved, "Ready for your review");
    return saved;
  }
  async decide(
    owner: string,
    id: string,
    hash: string,
    decision: "approve" | "deny",
  ): Promise<ActionProposal> {
    const proposal = await this.db.get<ActionProposal>(owner, "actions", id);
    if (!proposal) throw new AppError("Action not found", 404);
    if (proposal.hash !== hash)
      throw new AppError("This proposal changed. Open its latest review before deciding.", 409);
    if (proposal.status !== "awaiting_review") return proposal;
    if (decision === "approve" && proposal.taskId) {
      const task = await this.db.get<{ status: string }>(owner, "tasks", proposal.taskId);
      if (!task || !["running", "waiting_approval"].includes(task.status))
        throw new AppError(
          "Resume the task before approving this action. Cancelled tasks cannot execute.",
          409,
        );
    }
    if (Date.parse(proposal.expiresAt) <= this.now()) {
      const expired = await this.db.compareAndSwap<ActionProposal>(
        owner,
        "actions",
        id,
        { status: "awaiting_review", hash, expiresAt: proposal.expiresAt },
        { status: "expired" },
      );
      if (!expired) {
        const current = await this.db.get<ActionProposal>(owner, "actions", id);
        if (!current) throw new AppError("Action not found", 404);
        return current;
      }
      throw new AppError("This review expired. Create a fresh proposal.", 409);
    }
    if (decision === "approve") {
      const forEmail = proposal.kind === "email.send";
      const forWhatsApp = proposal.kind === "whatsapp.send";
      const forCalendar =
        proposal.kind === "calendar.create" ||
        proposal.kind === "calendar.update" ||
        proposal.kind === "calendar.delete";
      const connected =
        proposal.kind === "workboard.dispatch"
          ? undefined
          : forWhatsApp
            ? (this.options.whatsappConnected ?? this.options.connected)
            : forEmail
              ? (this.options.emailConnected ?? this.options.connected)
              : this.options.connected;
      if (connected && !(await connected(owner)) && !forCalendar)
        throw new AppError(
          forWhatsApp
            ? "WhatsApp is disconnected. Re-pair before approving this action."
            : forEmail
              ? "The email account is disconnected. Reconnect before approving this action."
              : "Google is disconnected. Reconnect before approving this action.",
          409,
        );
      const connectionFor =
        proposal.kind === "workboard.dispatch"
          ? undefined
          : forEmail
            ? (this.options.emailConnection ?? this.options.connection)
            : this.options.connection;
      const connection = await connectionFor?.(owner);
      if (
        connectionFor &&
        !forCalendar &&
        (!connection ||
          connection.id !== proposal.connectionId ||
          connection.account !== proposal.account)
      )
        throw new AppError(
          forEmail
            ? "Email account or connection changed. Prepare a new action for the connected account."
            : "Google account or connection changed. Prepare a new action for the connected account.",
          409,
        );
    }
    const claimed = await this.db.claim<ActionProposal>(
      owner,
      id,
      decision === "deny" ? "denied" : "executing",
      new Date(this.now()).toISOString(),
    );
    if (!claimed) {
      const current = await this.db.get<ActionProposal>(owner, "actions", id);
      if (!current) throw new AppError("Action not found", 404);
      return current;
    }
    await this.record(
      owner,
      claimed,
      decision === "deny" ? "Declined; no changes made" : "Approved; execution started",
    );
    if (decision === "deny") return claimed;
    let finished: ActionProposal;
    try {
      const input = proposalSchema.parse({ kind: claimed.kind, data: claimed.data });
      const result = await this.options.execute(
        owner,
        input,
        claimed.connectionId,
        claimed.targetVersion,
      );
      finished = { ...claimed, status: "succeeded", result };
    } catch (error) {
      const unknown =
        error instanceof Error &&
        (("outcomeUnknown" in error && error.outcomeUnknown === true) ||
          ("code" in error && error.code === "outcome_unknown"));
      finished = {
        ...claimed,
        status: unknown ? "outcome_unknown" : "failed",
        error: error instanceof Error ? error.message : "Execution failed",
      };
    }
    await this.db.put(owner, "actions", finished);
    await this.record(owner, finished, finished.result ?? finished.error ?? finished.status);
    return finished;
  }
  private async record(owner: string, action: ActionProposal, detail: string) {
    await this.db.put(owner, "activity", {
      id: randomUUID(),
      actionId: action.id,
      title: action.title,
      detail,
      date: new Date(this.now()).toISOString(),
      status: action.status,
    });
  }
}
