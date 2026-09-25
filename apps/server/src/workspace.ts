import { randomUUID } from "node:crypto";
import { projectActivityEntries } from "../../../packages/domain/src/activity-presentation.ts";
import type {
  ActionProposal,
  ActivityEntry,
  Artifact,
  BrowserSession,
  CalendarEvent,
  Mail,
  ProposalInput,
  Workspace,
} from "../../../packages/domain/src/index.ts";
import { GoogleClient } from "../../../packages/integrations/src/google.ts";
import { createSamplePdf } from "../../../packages/integrations/src/pdf.ts";
import { decryptSecret, encryptSecret } from "../../../packages/integrations/src/vault.ts";
import type { ActionService } from "./actions.ts";
import { agentConfigured } from "./agent.ts";
import type { Config } from "./config.ts";
import type { EmailService } from "./connectors/email/service.ts";
import { applyWorkSignature } from "./connectors/email/signature.ts";
import { imapToMail } from "./connectors/email/tools.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import type { Files } from "./files.ts";
import type { GoogleAuth } from "./google-auth.ts";

/** Normalized mailbox result for the agent's mailbox.search/read tools. */
export interface MailboxSummary {
  /** "folder:uid" for IMAP, the Gmail resource id for Google. */
  id: string;
  folder: string;
  uid?: number;
  messageId?: string;
  from: string;
  to: string[];
  subject: string;
  date?: string;
  snippet: string;
  unread: boolean;
}

export interface MailboxMessage extends MailboxSummary {
  cc: string[];
  body: string;
  bodyTruncated: boolean;
}

function encodeMailboxCursor(value: { offset?: number; pageToken?: string }): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeMailboxCursor(cursor?: string): { offset: number; pageToken?: string } {
  if (!cursor) return { offset: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      offset?: unknown;
      pageToken?: unknown;
    };
    const offset =
      typeof parsed.offset === "number" &&
      Number.isInteger(parsed.offset) &&
      parsed.offset >= 0 &&
      parsed.offset <= 200
        ? parsed.offset
        : 0;
    const pageToken =
      typeof parsed.pageToken === "string" && parsed.pageToken.length > 0
        ? parsed.pageToken
        : undefined;
    return { offset, pageToken };
  } catch {
    throw new AppError("Invalid mailbox cursor", 400);
  }
}

export class WorkspaceService {
  private seeding = new Map<string, Promise<void>>();
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly files: Files,
    private readonly googleAuth: GoogleAuth,
    private readonly email?: EmailService,
  ) {}
  google(owner: string, connectionId?: string) {
    return new GoogleClient({
      getAccessToken: () => this.googleAuth.accessToken(owner, connectionId),
    });
  }
  async connection(owner: string) {
    if (this.config.mode === "sample") {
      const value = await this.db.get<{ enabled: boolean; connectionId?: string }>(
        owner,
        "settings",
        "google",
      );
      return value?.enabled === false
        ? null
        : { id: value?.connectionId ?? "sample-google", account: "alex@example.com" };
    }
    const tokens = await this.googleAuth.tokens(owner);
    return tokens ? { id: tokens.connectionId, account: tokens.account } : null;
  }
  async connected(owner: string) {
    return this.config.mode === "sample"
      ? (await this.db.get<{ enabled: boolean }>(owner, "settings", "google"))?.enabled !== false
      : Boolean(await this.googleAuth.tokens(owner));
  }
  /**
   * The account used for email: Google when connected, otherwise the first
   * IMAP/SMTP account. IMAP accounts are identified by an `imap:` prefix on
   * the connection id so the action flow can route execution correctly.
   */
  async emailConnection(owner: string): Promise<{ id: string; account: string } | null> {
    const google = await this.connection(owner);
    if (google) return google;
    const account = await this.email?.defaultAccount(owner);
    return account ? { id: `imap:${account.id}`, account: account.emailAddress } : null;
  }
  async emailConnected(owner: string): Promise<boolean> {
    return (await this.emailConnection(owner)) !== null;
  }
  /**
   * Every account the agent can send from: the connected Google account
   * (id "google") plus each configured IMAP/SMTP account (id = its UUID).
   * Metadata only — labels, addresses and kinds, never secrets. Backs the
   * email_accounts_list chat tool so the agent can resolve "work email" or
   * "gmail" to an emailAccountId.
   */
  async emailAccounts(owner: string): Promise<
    Array<{
      id: string;
      label: string;
      address: string;
      kind: "google" | "titan" | "imap";
      designation?: "work" | "personal";
    }>
  > {
    const accounts: Array<{
      id: string;
      label: string;
      address: string;
      kind: "google" | "titan" | "imap";
      designation?: "work" | "personal";
    }> = [];
    const google = await this.connection(owner);
    if (google)
      accounts.push({ id: "google", label: "Google", address: google.account, kind: "google" });
    for (const stored of (await this.email?.listAccounts(owner)) ?? []) {
      const labelLower = stored.label.toLowerCase();
      const designation = labelLower.includes("work")
        ? ("work" as const)
        : labelLower.includes("personal")
          ? ("personal" as const)
          : undefined;
      accounts.push({
        id: stored.id,
        label: stored.label,
        address: stored.emailAddress,
        kind: stored.imap.host.toLowerCase().includes("titan") ? "titan" : "imap",
        ...(designation ? { designation } : {}),
      });
    }
    return accounts;
  }
  async calendars(owner: string) {
    const connection = await this.connection(owner);
    if (!connection) {
      // Live mode without Google: a single local calendar keeps the calendar
      // usable against the local DB store instead of presenting nothing.
      if (this.config.mode === "live")
        return [
          {
            id: "primary",
            name: "Local",
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            accessRole: "owner",
          },
        ];
      return [];
    }
    if (this.config.mode === "sample")
      return [
        {
          id: "primary",
          name: "Personal",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          accessRole: "owner",
        },
      ];
    return this.google(owner, connection.id).listCalendars();
  }
  async events(
    owner: string,
    options: { calendarId?: string; timeMin?: string; timeMax?: string } = {},
  ) {
    const connection = await this.connection(owner);
    // Live mode without Google: fall back to the local DB store.
    if (this.config.mode === "live" && !connection) return this.localEvents(owner, options);
    if (!connection) return [];
    if (this.config.mode === "live") return this.google(owner, connection.id).listEvents(options);
    return this.localEvents(owner, options);
  }
  /** Local DB copy of events (sample mode, and live mode without Google). */
  private async localEvents(
    owner: string,
    options: { calendarId?: string; timeMin?: string; timeMax?: string } = {},
  ) {
    return (await this.db.list<CalendarEvent>(owner, "events"))
      .filter(
        (event) =>
          event.calendarId === (options.calendarId ?? "primary") &&
          (!options.timeMax || Date.parse(event.start) < Date.parse(options.timeMax)) &&
          (!options.timeMin || Date.parse(event.end) > Date.parse(options.timeMin)),
      )
      .sort((a, b) => a.start.localeCompare(b.start));
  }
  private async cacheMail(owner: string, mail: Mail[], connectionId: string) {
    const imports = await this.db.list<{ id: string; artifactId: string; connectionId?: string }>(
      owner,
      "imports",
    );
    const result = mail.map((message) => ({
      ...message,
      attachments: message.attachments.map(
        (ref) =>
          imports.find((i) => i.id === ref && i.connectionId === connectionId)?.artifactId ?? ref,
      ),
    }));
    // Bodies are encrypted at rest (AES-256-GCM, same vault as passwords) so a
    // database backup or disk image never exposes readable email content.
    for (const message of result)
      await this.db.put(owner, "mail", {
        ...message,
        body: this.encryptMailBody(message.body),
        connectionId,
      });
    return result;
  }
  /** Encrypt a mail body for storage. Returns the plaintext unchanged when no key is configured (sample mode). */
  private encryptMailBody(body: string): string {
    if (!this.config.encryptionKey || !body) return body;
    return `enc:v1:${encryptSecret(body, this.config.encryptionKey)}`;
  }
  /** Reverse of encryptMailBody. Passes through plaintext and unparseable values safely. */
  private decryptMailBody(stored: string): string {
    if (!stored.startsWith("enc:v1:") || !this.config.encryptionKey) return stored;
    try {
      return decryptSecret(stored.slice("enc:v1:".length), this.config.encryptionKey);
    } catch {
      return "";
    }
  }
  private decryptMailList(mail: Mail[]): Mail[] {
    return mail.map((m) => ({ ...m, body: this.decryptMailBody(m.body) }));
  }
  async thread(owner: string, id: string) {
    const connection = await this.connection(owner);
    if (connection) {
      const mail =
        this.config.mode === "sample"
          ? this.decryptMailList(
              (await this.db.list<Mail>(owner, "mail")).filter((m) => m.threadId === id),
            )
          : await this.cacheMail(
              owner,
              await this.google(owner, connection.id).getThread(id),
              connection.id,
            );
      if (!mail.length) throw new AppError("Mail thread not found", 404);
      return mail.sort((a, b) => a.date.localeCompare(b.date));
    }
    const account = await this.email?.defaultAccount(owner);
    const email = this.email;
    if (!email || !account)
      throw new AppError(
        "Mail is disconnected. Connect Google or add an email account before reading mail",
        409,
      );
    // IMAP message ids are "folder:uid".
    const separator = id.lastIndexOf(":");
    const folder = separator > 0 ? id.slice(0, separator) : "INBOX";
    const uid = Number(id.slice(separator + 1));
    if (!Number.isInteger(uid) || uid < 1) throw new AppError("Mail thread not found", 404);
    return [imapToMail(account.label, await email.read(owner, account.id, folder, uid))];
  }
  async searchMail(owner: string, query: string) {
    const connection = await this.connection(owner);
    if (connection) {
      if (this.config.mode === "live")
        return this.cacheMail(
          owner,
          await this.google(owner, connection.id).listMail(query || "in:inbox"),
          connection.id,
        );
      const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
      return this.decryptMailList(await this.db.list<Mail>(owner, "mail"))
        .filter(
          (message) =>
            !/^Sent\b/i.test(message.label) &&
            words.every((word) =>
              `${message.sender} ${message.from} ${message.subject} ${message.body}`
                .toLowerCase()
                .includes(word),
            ),
        )
        .sort((a, b) => b.date.localeCompare(a.date));
    }
    const account = await this.email?.defaultAccount(owner);
    const email = this.email;
    if (!email || !account)
      throw new AppError(
        "Mail is disconnected. Connect Google or add an email account before searching mail",
        409,
      );
    const result = await email.page(owner, account.id, {
      folder: "INBOX",
      query,
      page: 1,
      pageSize: 20,
    });
    return result.items.map((message) => imapToMail(account.label, message));
  }
  /**
   * Explicit-account mailbox search for the agent's mailbox.search tool.
   * `"google"` searches Gmail; an email-account UUID searches that exact
   * IMAP account — the call never falls back to another account. Pass back
   * `nextCursor` to continue; IMAP paginates by offset inside a bounded
   * 200-message scan window, Gmail with its own page token.
   */
  async searchMailbox(
    owner: string,
    accountId: string,
    options: { folder?: string; query: string; limit: number; cursor?: string },
  ): Promise<{ items: MailboxSummary[]; nextCursor?: string }> {
    const limit = Math.min(Math.max(Math.floor(options.limit) || 20, 1), 50);
    const { offset, pageToken } = decodeMailboxCursor(options.cursor);
    if (accountId === "google") {
      const connection = await this.connection(owner);
      if (!connection) throw new AppError("Google is not connected", 409);
      const page = await this.google(owner, connection.id).listMailPage(
        options.query || "in:inbox",
        { pageToken, maxResults: limit },
      );
      return {
        items: page.messages.map((message) => ({
          id: message.id,
          folder: "INBOX",
          messageId: message.id,
          from: message.from,
          to: message.to,
          subject: message.subject,
          date: message.date,
          snippet: message.body.replace(/\s+/g, " ").trim().slice(0, 240),
          unread: message.unread,
        })),
        nextCursor: page.nextPageToken
          ? encodeMailboxCursor({ pageToken: page.nextPageToken })
          : undefined,
      };
    }
    const email = this.email;
    if (!email) throw new AppError("Email accounts are unavailable", 503);
    const account = (await email.listAccounts(owner)).find((item) => item.id === accountId);
    if (!account) throw new AppError("The email account was not found", 404);
    const folder = options.folder ?? "INBOX";
    // The offset cursor maps onto server-side page pagination: page is
    // 1-based and newest-first, so page = floor(offset / limit) + 1.
    const result = await email.page(owner, accountId, {
      folder,
      query: options.query,
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
    });
    const items = result.items.map((message) => ({
      id: `${message.folder}:${message.uid}`,
      folder: message.folder,
      uid: message.uid,
      messageId: message.messageId,
      from: message.from,
      to: message.to,
      subject: message.subject,
      date: message.date,
      snippet: message.snippet,
      unread: message.unread,
    }));
    const consumed = offset + items.length;
    return {
      items,
      nextCursor: consumed < result.total ? encodeMailboxCursor({ offset: consumed }) : undefined,
    };
  }
  /**
   * Explicit-account message read for the agent's mailbox.read tool. Gmail
   * takes a message id; IMAP takes a folder plus uid. Bodies are bounded at
   * 12000 characters.
   */
  async readMailboxMessage(
    owner: string,
    accountId: string,
    ref: { folder: string; uid: number } | { messageId: string },
  ): Promise<MailboxMessage> {
    if (accountId === "google") {
      if (!("messageId" in ref)) throw new AppError("messageId is required for Gmail", 400);
      const connection = await this.connection(owner);
      if (!connection) throw new AppError("Google is not connected", 409);
      const message = await this.google(owner, connection.id).getMessage(ref.messageId);
      return {
        id: message.id,
        folder: "INBOX",
        messageId: message.id,
        from: message.from,
        to: message.to,
        subject: message.subject,
        date: message.date,
        snippet: message.body.replace(/\s+/g, " ").trim().slice(0, 240),
        unread: message.unread,
        cc: [],
        body: message.body.slice(0, 12000),
        bodyTruncated: message.body.length > 12000,
      };
    }
    if (!("uid" in ref)) throw new AppError("folder and uid are required for IMAP accounts", 400);
    const email = this.email;
    if (!email) throw new AppError("Email accounts are unavailable", 503);
    const account = (await email.listAccounts(owner)).find((item) => item.id === accountId);
    if (!account) throw new AppError("The email account was not found", 404);
    const message = await email.read(owner, accountId, ref.folder, ref.uid);
    return {
      id: `${message.folder}:${message.uid}`,
      folder: message.folder,
      uid: message.uid,
      messageId: message.messageId,
      from: message.from,
      to: message.to,
      subject: message.subject,
      date: message.date,
      snippet: message.snippet,
      unread: message.unread,
      cc: message.cc,
      body: message.body,
      bodyTruncated: message.body.length >= 12000,
    };
  }
  /**
   * One calendar event by id, for the agent's calendar.update/delete tools
   * and the confirmation gate. The local DB is checked first (it caches
   * Google events the app created), then the Google Calendar API when
   * connected. Returns null when the event cannot be read — callers fail
   * closed and require owner approval.
   */
  async getCalendarEvent(
    owner: string,
    eventId: string,
    calendarId = "primary",
  ): Promise<CalendarEvent | null> {
    const local = await this.db.get<CalendarEvent>(owner, "events", eventId);
    if (local) return local;
    const connection = await this.connection(owner);
    if (!connection || this.config.mode !== "live") return null;
    try {
      return await this.google(owner, connection.id).getEvent(calendarId, eventId);
    } catch {
      return null;
    }
  }
  async ensureSample(owner: string, actions: ActionService) {
    if (this.config.mode !== "sample") return;
    const active = this.seeding.get(owner);
    if (active) return active;
    const task = this.seed(owner, actions).finally(() => this.seeding.delete(owner));
    this.seeding.set(owner, task);
    await task;
  }
  private async seed(owner: string, actions: ActionService) {
    if (await this.db.get(owner, "settings", "seeded")) return;
    const file = await this.files.import(
      owner,
      "Field trip permission slip.pdf",
      await createSamplePdf(),
      "Gmail · Lincoln Middle School",
    );
    const now = new Date();
    const at = (h: number, m = 0) => {
      const d = new Date(now);
      d.setHours(h, m, 0, 0);
      return d.toISOString();
    };
    const mails: Mail[] = [
      {
        id: "mail-fieldtrip",
        threadId: "trip-thread",
        sender: "Lincoln Middle School",
        from: "office@lincoln.example",
        to: ["alex@example.com"],
        subject: "A little reminder: permission slips are due Friday",
        body: "Hi Alex,\n\nOur class is heading to the aquarium this Friday. Please complete the attached permission slip and send it back when you have a moment.\n\nWe’ll leave school at 8:15 AM and return by 4:30 PM. Please pack lunch and a water bottle.\n\nThank you!\nMs. Rivera\n\nThis message is included with your local workspace.",
        date: at(8, 42),
        unread: true,
        label: "School",
        attachments: [file.id],
      },
      {
        id: "mail-design",
        threadId: "design-thread",
        sender: "Jamie Chen",
        from: "jamie@example.com",
        to: ["alex@example.com"],
        subject: "Coffee and a catch-up?",
        body: "Hey Alex,\n\nWould love to catch up this week. I’m free Thursday afternoon. How does 3 PM at Bluebird Coffee sound?\n\nJamie\n\nThis invitation is part of your local workspace.",
        date: at(8, 15),
        unread: true,
        label: "Personal",
        attachments: [],
      },
      {
        id: "mail-stay",
        threadId: "stay-thread",
        sender: "The Seabird",
        from: "stay@seabird.example",
        to: ["alex@example.com"],
        subject: "Your weekend, all sorted",
        body: "Your reservation is confirmed.\n\nCheck-in: Friday, 3 PM\nCheck-out: Sunday, 11 AM\n\nThis fictional reservation demonstrates how OpenMuse can organize travel details.",
        date: at(7, 30),
        unread: false,
        label: "Travel",
        attachments: [],
      },
      {
        id: "mail-studio",
        threadId: "studio-thread",
        sender: "Studio North",
        from: "hello@studionorth.example",
        to: ["alex@example.com"],
        subject: "Notes from our last conversation",
        body: "Thanks for a thoughtful conversation yesterday. Let’s use our next session to review the prototype and pick the three flows for testing.\n\nThis project is part of your local workspace.",
        date: new Date(now.getTime() - 86400000).toISOString(),
        unread: false,
        label: "Work",
        attachments: [],
      },
    ];
    for (const mail of mails) await this.db.put(owner, "mail", mail);
    const base = {
      calendarId: "primary",
      allDay: false,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      description: "A little time to catch up",
      attendees: [],
    };
    for (const event of [
      {
        ...base,
        id: "event-standup",
        title: "A slow start · morning walk",
        start: at(9),
        end: at(9, 30),
        location: "Neighborhood",
      },
      {
        ...base,
        id: "event-review",
        title: "Design catch-up",
        start: at(11),
        end: at(11, 45),
        location: "Studio North",
      },
      {
        ...base,
        id: "event-lunch",
        title: "Lunch with Maya",
        start: at(13),
        end: at(14),
        location: "Little Saint",
      },
    ])
      await this.db.put(owner, "events", event);
    await actions.propose(owner, {
      kind: "calendar.create",
      data: {
        ...base,
        title: "Coffee with Jamie",
        start: at(15),
        end: at(16),
        location: "Bluebird Coffee",
        description: "Catch up over coffee",
        attendees: ["jamie@example.com"],
      },
    });
    await this.db.put(owner, "settings", { id: "google", enabled: true });
    await this.db.put(owner, "settings", { id: "seeded", value: true });
  }
  async snapshot(owner: string, query?: string): Promise<Workspace> {
    let mail: Mail[], events: CalendarEvent[];
    const connected = await this.connected(owner);
    if (this.config.mode === "live" && connected) {
      const connection = await this.connection(owner);
      if (!connection) throw new AppError("Google is disconnected", 409);
      const google = this.google(owner, connection.id);
      [mail, events] = await Promise.all([google.listMail(query), google.listEvents()]);
      mail = await this.cacheMail(owner, mail, connection.id);
      for (const event of events) await this.db.put(owner, "events", event);
    } else if (this.config.mode === "sample" && connected) {
      mail = this.decryptMailList(await this.db.list<Mail>(owner, "mail"));
      events = await this.db.list<CalendarEvent>(owner, "events");
      if (query)
        mail = mail.filter((m) =>
          `${m.sender} ${m.subject} ${m.body}`.toLowerCase().includes(query.toLowerCase()),
        );
    } else if (this.config.mode === "live") {
      // Google is not connected: fall back to the first IMAP/SMTP account so
      // the inbox shows mail instead of sitting empty. Events come from the
      // local calendar store — IMAP has no calendar.
      const account = await this.email?.defaultAccount(owner);
      if (account && this.email) {
        const result = await this.email.page(owner, account.id, {
          folder: "INBOX",
          query: query ?? "",
          page: 1,
          pageSize: 20,
        });
        mail = result.items.map((message) => imapToMail(account.label, message));
        mail = await this.cacheMail(owner, mail, `imap:${account.id}`);
      } else {
        mail = [];
      }
      events = await this.localEvents(owner);
    } else {
      mail = [];
      events = [];
    }
    const tokens = this.config.mode === "live" ? await this.googleAuth.tokens(owner) : null;
    return {
      mode: this.config.mode,
      profile: {
        name: this.config.mode === "sample" ? "Alex" : "You",
        email: tokens?.account ?? (this.config.mode === "sample" ? "alex@example.com" : ""),
      },
      mail: mail.sort((a, b) => b.date.localeCompare(a.date)),
      events: events.sort((a, b) => a.start.localeCompare(b.start)),
      files: await this.files.list(owner),
      browsers: await this.db.list<BrowserSession>(owner, "browsers"),
      actions: await this.db.list<ActionProposal>(owner, "actions"),
      // Server projects; mobile stays dumb. Honest statuses, actionId
      // collapse, routine noise filtered. Hidden records are debug-logged so
      // a buried real failure stays visible in incident review.
      activity: projectActivityEntries(await this.db.list<ActivityEntry>(owner, "activity"), {
        onHidden: (hidden) =>
          console.debug(
            `[activity] hid record ${hidden.id} (${hidden.pattern}): ${hidden.title} [${hidden.honestStatus}]`,
          ),
      }),
      connections: [
        {
          id: "google",
          name: "Google",
          status: connected
            ? this.config.mode === "sample"
              ? "sample"
              : "connected"
            : "disconnected",
          account:
            tokens?.account ?? (this.config.mode === "sample" ? "alex@example.com" : undefined),
          capabilities:
            this.config.mode === "sample" ? ["Gmail", "Calendar"] : (tokens?.scopes ?? []),
        },
        {
          id: "browser",
          name: "Browser",
          status: this.config.workerUrl && this.config.workerToken ? "connected" : "unconfigured",
          capabilities: ["Persistent sessions", "PDF downloads"],
        },
        {
          id: "email",
          name: "Email (IMAP/SMTP)",
          status: (await this.email?.listAccounts(owner))?.length ? "connected" : "unconfigured",
          account: (await this.email?.defaultAccount(owner))?.emailAddress,
          capabilities: ["IMAP read", "SMTP send (approved)"],
        },
        {
          id: "openbot",
          name: "OpenBot",
          status: "unconfigured",
          capabilities: ["Integration adapter available"],
        },
      ],
      runtime: {
        provider: this.config.agentBackend === "sample" ? "sample" : "model",
        configured: agentConfigured(this.config),
        openbotConfigured: false,
        richThreads: Boolean(this.config.intelligenceApiKey),
      },
    };
  }
  async prepare(owner: string, input: ProposalInput, connectionId?: string) {
    if (input.kind === "email.send") {
      for (const id of input.data.attachmentIds) await this.files.get(owner, id);
      return { input };
    }
    // A workboard dispatch is pure task-worker fan-out: nothing to review
    // against Google, so there is no target version to pin.
    if (input.kind === "workboard.dispatch") return { input };
    // A WhatsApp send has nothing to pin either: the payload is reviewed
    // as-is, and the socket connection + allow-list are checked at approval
    // and execution time.
    if (input.kind === "whatsapp.send") return { input };
    if (input.kind === "calendar.create" || this.config.mode === "sample") return { input };
    // Live mode without Google: no target version to pin — the local-store
    // path in execute() handles updates/deletes directly, like sample mode.
    if (
      this.config.mode === "live" &&
      (input.kind === "calendar.update" || input.kind === "calendar.delete") &&
      !(await this.connected(owner))
    )
      return { input };
    const reviewed = await this.google(owner, connectionId).reviewEvent(
      input.data.calendarId,
      input.data.eventId,
    );
    return {
      input:
        input.kind === "calendar.delete"
          ? { ...input, data: { ...input.data, title: reviewed.event.title } }
          : input,
      target: reviewed.event,
      targetVersion: reviewed.version,
    };
  }
  async execute(
    owner: string,
    input: ProposalInput,
    connectionId?: string,
    targetVersion?: string,
  ): Promise<string> {
    // Kind-guard first: these proposals are never executed by this service,
    // not even in sample mode — app wiring routes each to its own executor.
    if (input.kind === "workboard.dispatch")
      throw new AppError("Workboard dispatches execute through the workboard service", 500);
    if (input.kind === "whatsapp.send")
      throw new AppError("WhatsApp sends execute through the WhatsApp sidecar", 500);
    if (this.config.mode === "sample") {
      if (input.kind === "email.send") {
        const id = randomUUID();
        await this.db.put(owner, "mail", {
          id,
          threadId: input.data.threadId ?? id,
          sender: "You",
          from: "alex@example.com",
          to: input.data.to,
          subject: input.data.subject,
          body: input.data.body,
          date: new Date().toISOString(),
          unread: false,
          label: "Sent · local",
          attachments: input.data.attachmentIds,
        });
        return `Saved to local sent mail · ${id}`;
      }
      return this.executeLocalCalendar(owner, input);
    }
    const tokens = await this.googleAuth.tokens(owner);
    if (input.kind === "email.send" && connectionId?.startsWith("imap:")) {
      // Approved IMAP/SMTP send. The proposal was pinned to this account at
      // approval time; a changed account is rejected before execution.
      const email = this.email;
      if (!email) throw new AppError("Email accounts are unavailable", 503);
      const accountId = connectionId.slice("imap:".length);
      const account = (await email.listAccounts(owner)).find((item) => item.id === accountId);
      if (!account) throw new AppError("The approved email account was removed", 409);
      const attachments = await Promise.all(
        input.data.attachmentIds.map(async (id) => {
          const file = await this.files.get(owner, id);
          return {
            filename: file.name,
            contentType: file.mimeType,
            content: await this.files.bytes(owner, id),
          };
        }),
      );
      const receipt = await email.send(owner, accountId, {
        to: input.data.to,
        cc: input.data.cc,
        bcc: input.data.bcc,
        subject: input.data.subject,
        body: input.data.body,
        inReplyTo: input.data.replyToMessageId,
        attachments,
      });
      return `Sent via ${account.label} · ${receipt.messageId || "accepted"}`;
    }
    // Live mode without Google: calendar actions work against the local store.
    if (
      !tokens &&
      (input.kind === "calendar.create" ||
        input.kind === "calendar.update" ||
        input.kind === "calendar.delete")
    )
      return this.executeLocalCalendar(owner, input);
    if (!tokens) throw new AppError("Google is disconnected", 409);
    const capability = input.kind === "email.send" ? "gmail.send" : "calendar.events";
    if (!tokens.scopes.includes(`https://www.googleapis.com/auth/${capability}`))
      throw new AppError("Enable Google write access in Connections before approving", 403);
    if (tokens.connectionId !== connectionId)
      throw new AppError("Google account or connection changed. Prepare a new action.", 409);
    const google = this.google(owner, connectionId);
    // (workboard.dispatch and whatsapp.send were already rejected at the top
    // of this method; they never reach the calendar executor below.)
    if ((input.kind === "calendar.update" || input.kind === "calendar.delete") && !targetVersion)
      throw new AppError(
        "This calendar review predates target-version checks. Prepare a new review.",
        409,
      );
    if (input.kind === "email.send") {
      const attachments = await Promise.all(
        input.data.attachmentIds.map(async (id) => {
          const file = await this.files.get(owner, id);
          return {
            name: file.name,
            mimeType: file.mimeType,
            bytes: await this.files.bytes(owner, id),
          };
        }),
      );
      const receipt = await google.sendEmail(
        {
          ...input.data,
          // Work-email identity: mail from work@example.com is
          // signed "Work User", never "Owner". Enforced here so the Gmail
          // path carries the same signature as the IMAP path.
          body: applyWorkSignature(input.data.body, tokens.account),
        },
        attachments,
      );
      return `Gmail sent message · ${receipt.id}`;
    }
    if (input.kind === "calendar.delete") {
      await google.deleteEvent(input.data.calendarId, input.data.eventId, targetVersion);
      await this.db.remove(owner, "events", input.data.eventId);
      return `Deleted Google Calendar event · ${input.data.eventId}`;
    }
    const event =
      input.kind === "calendar.create"
        ? await google.createEvent(input.data)
        : await google.updateEvent(input.data.eventId, input.data, targetVersion);
    // Keep the per-event email account on the local copy (Google has no
    // equivalent field). Google notifies attendees natively on create/update,
    // so no extra invite email is sent here -- that would double-notify. The
    // local execution path sends the invite through the chosen account.
    const stored: CalendarEvent = { ...event, emailAccountId: input.data.emailAccountId };
    await this.db.put(owner, "events", stored);
    return `Google Calendar event · ${event.id}`;
  }
  /**
   * Local calendar execution: persists calendar.create/update/delete to the
   * DB store. Used in sample mode, and in live mode when Google is
   * disconnected. In live mode, a create/update with attendees and a chosen
   * email account also sends the invite through that account; sample mode
   * never sends — sample data is fake, so external effects stay off.
   */
  private async executeLocalCalendar(
    owner: string,
    input: Extract<
      ProposalInput,
      { kind: "calendar.create" } | { kind: "calendar.update" } | { kind: "calendar.delete" }
    >,
  ): Promise<string> {
    if (input.kind === "calendar.delete") {
      await this.db.remove(owner, "events", input.data.eventId);
      return "Removed from local calendar";
    }
    const id = input.kind === "calendar.update" ? input.data.eventId : randomUUID();
    const event: CalendarEvent = { ...input.data, id };
    await this.db.put(owner, "events", event);
    const invite = this.config.mode === "live" ? await this.sendEventInvite(owner, event) : "";
    return `Saved to local calendar · ${id}${invite}`;
  }
  /**
   * Sends an event invite email through the event's chosen account, when the
   * event names an account and has attendees. "imap:<uuid>" pins the account
   * the way the approved email.send flow does; a raw UUID is treated as an
   * email-account id; "google" routes through the connected Google account.
   * Fails closed (AppError) when the named account no longer exists. The
   * subject is stripped of CR/LF — the same single-line rule the reviewed
   * email.send flow enforces — so the title can never smuggle mail headers.
   */
  private async sendEventInvite(owner: string, event: CalendarEvent): Promise<string> {
    const accountId = event.emailAccountId;
    const attendees = event.attendees ?? [];
    if (!accountId || attendees.length === 0) return "";
    const subject = `Invitation: ${event.title}`.replace(/[\r\n]+/g, " ").trim();
    const body = [
      event.title,
      "",
      `When: ${event.start} → ${event.end} (${event.timeZone})`,
      ...(event.location ? [`Where: ${event.location}`] : []),
      ...(event.description ? [`Details: ${event.description}`] : []),
      "",
      "Sent from OpenMuse Calendar.",
    ].join("\n");
    if (accountId === "google") {
      const connection = await this.connection(owner);
      if (!connection) throw new AppError("Google is disconnected", 409);
      const receipt = await this.google(owner).sendEmail(
        {
          to: attendees,
          cc: [],
          bcc: [],
          subject,
          // Work-email identity rule applies to invites too when they go
          // out from the work address.
          body: applyWorkSignature(body, connection.account),
          attachmentIds: [],
        },
        [],
      );
      return ` · invite sent via Google (${receipt.id || "sent"})`;
    }
    const email = this.email;
    if (!email) throw new AppError("Email accounts are unavailable", 503);
    const id = accountId.startsWith("imap:") ? accountId.slice("imap:".length) : accountId;
    const account = (await email.listAccounts(owner)).find((item) => item.id === id);
    if (!account) throw new AppError("The event's email account was removed", 409);
    const receipt = await email.send(owner, id, {
      to: attendees,
      cc: [],
      bcc: [],
      subject,
      body,
    });
    return ` · invite sent via ${account.label} (${receipt.messageId || "accepted"})`;
  }
  async importAttachment(owner: string, reference: string): Promise<Artifact> {
    const connection = await this.connection(owner);
    if (!connection) throw new AppError("Google is disconnected", 409);
    const cached = await this.db.get<{ artifactId: string; connectionId?: string }>(
      owner,
      "imports",
      reference,
    );
    if (cached && cached.connectionId === connection.id)
      return this.files.signed(owner, await this.files.get(owner, cached.artifactId));
    const [messageId, attachmentId, filename] = reference.split(":");
    if (!messageId || !attachmentId || !filename)
      throw new AppError("Attachment reference is invalid");
    const message = await this.db.get<Mail & { connectionId?: string }>(owner, "mail", messageId);
    if (!message?.attachments.includes(reference) || message.connectionId !== connection.id)
      throw new AppError("Attachment not found. Refresh the current account's inbox.", 404);
    const file = await this.files.import(
      owner,
      decodeURIComponent(filename),
      await this.google(owner, connection.id).getAttachment(messageId, attachmentId),
      `Gmail · ${message.subject}`,
    );
    await this.db.put(owner, "imports", {
      id: reference,
      artifactId: file.id,
      connectionId: connection.id,
    });
    return file;
  }
}
