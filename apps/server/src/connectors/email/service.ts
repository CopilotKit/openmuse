import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { type AddressObject, simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { messageIdSchema } from "../../../../../packages/domain/src/index.ts";
import { decryptSecret, encryptSecret } from "../../../../../packages/integrations/src/vault.ts";
import type { Config } from "../../config.ts";
import type { Store } from "../../db.ts";
import { AppError } from "../../errors.ts";
import { addressOf, displayName, type MailAddress } from "./addresses.ts";
import { type MirrorMessage, MirrorStore } from "./mirror.ts";
import type { EmailAccountCreate, EmailAccountUpdate } from "./schemas.ts";
import { applyWorkSignature } from "./signature.ts";
import { MIRROR_FOLDERS, type MirrorSyncReport, syncFolderMirror } from "./sync.ts";

const KIND = "email-accounts";
const OPERATION_TIMEOUT_MS = 15000;

interface StoredEmailAccount {
  id: string;
  label: string;
  emailAddress: string;
  username: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  /** Vault envelope of the account password. Never leaves this file decrypted. */
  secret: string;
  createdAt: string;
  updatedAt: string;
}

export interface EmailAccountMeta {
  id: string;
  label: string;
  emailAddress: string;
  username: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface EmailSummary {
  uid: number;
  folder: string;
  messageId?: string;
  from: string;
  fromName?: string;
  to: string[];
  subject: string;
  date?: string;
  snippet: string;
  unread: boolean;
}

export interface EmailMessage extends EmailSummary {
  cc: string[];
  body: string;
  html?: string;
}

export interface EmailAttachment {
  filename: string;
  contentType?: string;
  content: Buffer;
}

/** One page of message summaries. `total` is the full match count. */
export interface EmailPage {
  total: number;
  page: number;
  pageSize: number;
  items: EmailSummary[];
  /** Max mirrored_at for the folder (ISO), from the local mirror. Null when served live. */
  syncedAt?: string | null;
}

/** Hard bounds for mailbox pagination. The route schema enforces the same. */
export const MAX_PAGE_SIZE = 50;

export interface EmailSendInput {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  attachments?: EmailAttachment[];
}

/** Decrypted account. Created, used, and wiped inside a single operation. */
export interface ResolvedEmailAccount extends StoredEmailAccount {
  password: string;
}

export interface FetchedMessage {
  uid: number;
  flags: string[];
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  date?: string;
  messageId?: string;
  text: string;
  html?: string;
}

/** Narrow protocol surface so tests can substitute fakes. */
/** One page of messages from a folder search, newest first. */
export interface MessagePage {
  total: number;
  messages: FetchedMessage[];
}

/**
 * nodemailer options for one SMTP account. Split out so tests can assert the
 * TLS policy without opening a socket.
 */
export function smtpOptions(account: {
  smtp: { host: string; port: number; secure: boolean };
  username: string;
  password: string;
}) {
  return {
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    // When the port is not implicit TLS (465), STARTTLS must be mandatory:
    // nodemailer otherwise proceeds unencrypted when the server does not
    // advertise the capability, silently downgrading password + body on the
    // wire. requireTLS turns an opportunistic upgrade into a hard requirement.
    requireTLS: !account.smtp.secure,
    auth: { user: account.username, pass: account.password },
    connectionTimeout: OPERATION_TIMEOUT_MS,
    greetingTimeout: OPERATION_TIMEOUT_MS,
    socketTimeout: OPERATION_TIMEOUT_MS * 2,
  };
}

/** Narrow protocol surface so tests can substitute fakes. */
export interface ImapConnection {
  listMailboxes(): Promise<string[]>;
  /**
   * Server-side search + pagination over the whole folder. `page` is
   * 1-based; the returned messages are newest-first and contain at most
   * `pageSize` entries. `total` is the full match count.
   */
  pageMessages(folder: string, query: string, page: number, pageSize: number): Promise<MessagePage>;
  message(folder: string, uid: number): Promise<FetchedMessage | null>;
  close(): Promise<void>;
}

export interface SmtpTransport {
  verify(): Promise<void>;
  send(options: {
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    text: string;
    inReplyTo?: string;
    attachments: { filename: string; contentType?: string; content: Buffer }[];
  }): Promise<string>;
  close(): Promise<void>;
}

/**
 * Sync-oriented IMAP session over one selected folder. The mirror engine
 * never uses SEARCH — some providers serve it from a lagging index — so
 * enumeration runs on UID ranges and a UID-only `1:*` fetch instead.
 */
export interface ImapSyncSession {
  readonly uidValidity: number;
  /** UIDNEXT of the selected folder. */
  readonly uidNext: number;
  /** Live message count (EXISTS). */
  readonly exists: number;
  /** Fetch full messages by UID range (inclusive); returns them UID-ascending. */
  fetchRange(startUid: number, endUid: number): Promise<FetchedMessage[]>;
  /** All server UIDs, ascending. */
  listUids(): Promise<number[]>;
  /** Flags for the UID range (inclusive), ascending. */
  fetchFlags(startUid: number, endUid: number): Promise<{ uid: number; flags: string[] }[]>;
  release(): Promise<void>;
}

export interface ImapSyncConnection {
  openFolder(folder: string): Promise<ImapSyncSession>;
  close(): Promise<void>;
}

export interface EmailFactories {
  imap(account: ResolvedEmailAccount): Promise<ImapConnection>;
  smtp(account: ResolvedEmailAccount): SmtpTransport;
  /**
   * Sync-oriented connection for the local mirror. Optional so existing
   * fake factories keep working; sync callers must check availability and
   * throw a clear error when a factory does not provide it.
   */
  imapSync?(account: ResolvedEmailAccount): Promise<ImapSyncConnection>;
}

/** Per-message parse cap. A raw source larger than this is never fed to simpleParser. */
export const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

export async function toFetched(
  uid: number,
  flags: Set<string> | string[] | undefined,
  source?: Buffer,
  // "stub" keeps list views working when one message is oversized; "throw"
  // fails the single-message fetch with a clear error instead.
  onOversized: "stub" | "throw" = "stub",
): Promise<FetchedMessage> {
  const flagList = flags ? [...flags] : [];
  if (!source) return { uid, flags: flagList, subject: "", from: [], to: [], cc: [], text: "" };
  if (source.byteLength > MAX_MESSAGE_BYTES) {
    if (onOversized === "throw")
      throw new AppError("Message exceeds the 5 MiB size limit and was not fetched", 413);
    return {
      uid,
      flags: flagList,
      subject: "",
      from: [],
      to: [],
      cc: [],
      text: "Message skipped: it exceeds the 5 MiB size limit.",
    };
  }
  const parsed = await simpleParser(source);
  // HTML-only messages (no text/plain part) can come back with empty text
  // when mailparser's html-to-text conversion yields nothing. Fall back to
  // stripping tags from the raw HTML so the body isn't blank.
  let text = parsed.text ?? "";
  if (!text.trim() && parsed.html) {
    text = parsed.html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n\s*\n+/g, "\n\n")
      .trim();
  }
  const addresses = (value: AddressObject | AddressObject[] | undefined) => {
    const objects = Array.isArray(value) ? value : value ? [value] : [];
    return objects
      .flatMap((object) => object.value ?? [])
      .filter((entry) => entry.address)
      .map((entry) => ({ name: entry.name, address: entry.address as string }));
  };
  return {
    uid,
    flags: flagList,
    subject: parsed.subject ?? "",
    from: addresses(parsed.from),
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    date: parsed.date?.toISOString(),
    messageId: parsed.messageId,
    text,
    html: parsed.html ? parsed.html.slice(0, 200_000) : undefined,
  };
}

const defaultFactories: EmailFactories = {
  imap: async (account) => {
    const client = new ImapFlow({
      host: account.imap.host,
      port: account.imap.port,
      secure: account.imap.secure,
      auth: { user: account.username, pass: account.password },
      logger: false,
      connectionTimeout: OPERATION_TIMEOUT_MS,
      greetingTimeout: OPERATION_TIMEOUT_MS,
      socketTimeout: OPERATION_TIMEOUT_MS * 2,
    });
    await client.connect();
    return {
      listMailboxes: async () => (await client.list()).map((mailbox) => mailbox.path),
      pageMessages: async (folder, query, page, pageSize) => {
        const lock = await client.getMailboxLock(folder);
        try {
          const trimmed = query.trim();
          if (!trimmed) {
            // Plain listing (no search terms): page by sequence number from
            // the mailbox message count instead of SEARCH. Some providers
            // serve SEARCH from a lagging index that omits recent mail,
            // which made plain inbox/Sent views look weeks stale. Sequence
            // numbers are stable while we hold the mailbox lock.
            const selected = client.mailbox;
            const exists = selected ? selected.exists : 0;
            const total = exists;
            const endSeq = exists - (page - 1) * pageSize;
            const startSeq = Math.max(1, endSeq - pageSize + 1);
            if (endSeq < 1 || startSeq > endSeq) return { total, messages: [] };
            const messages: FetchedMessage[] = [];
            for await (const item of client.fetch(`${startSeq}:${endSeq}`, {
              uid: true,
              flags: true,
              source: true,
            })) {
              // Oversized messages are stubbed (default "stub" mode) so one
              // giant message cannot nuke the whole list.
              messages.push(await toFetched(item.uid ?? 0, item.flags, item.source));
            }
            return { total, messages: messages.reverse() };
          }
          // IMAP SEARCH runs server-side over the whole folder (the mailbox
          // lock above selected it), so matches are no longer limited to the
          // most recent 50 messages. A `false` result means the search
          // failed — treat it as no matches rather than crashing.
          const found = await client.search({ text: trimmed });
          const uids = found || [];
          const total = uids.length;
          if (total === 0) return { total, messages: [] };
          const sorted = [...uids].sort((a, b) => a - b);
          const end = Math.max(0, total - (page - 1) * pageSize);
          const start = Math.max(0, end - pageSize);
          if (start >= end) return { total, messages: [] };
          const window = sorted.slice(start, end);
          const messages: FetchedMessage[] = [];
          // The third argument { uid: true } makes imapflow interpret the
          // list as UIDs rather than sequence numbers.
          for await (const item of client.fetch(
            window.join(","),
            { uid: true, flags: true, source: true },
            { uid: true },
          )) {
            // Oversized messages are stubbed (default "stub" mode) so one giant
            // message cannot nuke the whole list.
            messages.push(await toFetched(item.uid ?? 0, item.flags, item.source));
          }
          return { total, messages: messages.reverse() };
        } finally {
          lock.release();
        }
      },
      message: async (folder, uid) => {
        const lock = await client.getMailboxLock(folder);
        try {
          // The third argument { uid: true } makes imapflow interpret the
          // range as UIDs. Without it the range is read as sequence numbers,
          // so fetching UID 9810 would silently fetch sequence 9810 instead.
          for await (const item of client.fetch(
            String(uid),
            {
              uid: true,
              flags: true,
              source: true,
            },
            { uid: true },
          )) {
            return await toFetched(item.uid ?? uid, item.flags, item.source, "throw");
          }
          return null;
        } finally {
          lock.release();
        }
      },
      close: async () => {
        await client.logout().catch(() => undefined);
      },
    };
  },
  imapSync: async (account) => {
    const client = new ImapFlow({
      host: account.imap.host,
      port: account.imap.port,
      secure: account.imap.secure,
      logger: false,
      auth: { user: account.username, pass: account.password },
      connectionTimeout: OPERATION_TIMEOUT_MS,
      greetingTimeout: OPERATION_TIMEOUT_MS,
      socketTimeout: OPERATION_TIMEOUT_MS * 2,
    });
    await client.connect();
    return {
      openFolder: async (folder) => {
        const lock = await client.getMailboxLock(folder);
        const mailbox = client.mailbox;
        if (!mailbox) {
          lock.release();
          throw new AppError(`Mailbox ${folder} not found`, 404);
        }
        const uidValidity = Number(mailbox.uidValidity);
        const uidNext = mailbox.uidNext;
        const exists = mailbox.exists;
        return {
          uidValidity,
          uidNext,
          exists,
          fetchRange: async (startUid, endUid) => {
            const messages: FetchedMessage[] = [];
            for await (const item of client.fetch(
              `${startUid}:${endUid}`,
              { uid: true, flags: true, source: true },
              { uid: true },
            )) {
              messages.push(await toFetched(item.uid ?? 0, item.flags, item.source));
            }
            return messages;
          },
          listUids: async () => {
            const uids: number[] = [];
            // UID-only fetch of the whole folder; never SEARCH (the
            // provider's search index can lag behind recent mail).
            for await (const item of client.fetch("1:*", { uid: true }, { uid: true })) {
              if (item.uid) uids.push(item.uid);
            }
            return uids;
          },
          fetchFlags: async (startUid, endUid) => {
            const rows: { uid: number; flags: string[] }[] = [];
            for await (const item of client.fetch(
              `${startUid}:${endUid}`,
              { uid: true, flags: true },
              { uid: true },
            )) {
              rows.push({ uid: item.uid ?? 0, flags: item.flags ? [...item.flags] : [] });
            }
            return rows;
          },
          release: async () => {
            lock.release();
          },
        };
      },
      close: async () => {
        await client.logout().catch(() => undefined);
      },
    };
  },
  smtp: (account) => {
    const transport = nodemailer.createTransport(smtpOptions(account));
    return {
      verify: async () => {
        await transport.verify();
      },
      send: async (options) => {
        const info = await transport.sendMail({
          from: account.emailAddress,
          to: options.to,
          cc: options.cc.length ? options.cc : undefined,
          bcc: options.bcc.length ? options.bcc : undefined,
          subject: options.subject,
          text: options.text,
          inReplyTo: options.inReplyTo,
          attachments: options.attachments.map((attachment) => ({
            filename: attachment.filename,
            contentType: attachment.contentType,
            content: attachment.content,
          })),
        });
        return String(info.messageId ?? "");
      },
      close: async () => {
        transport.close();
      },
    };
  },
};

export class EmailService {
  private readonly db: Store;
  private readonly config: Config;
  private readonly factories: EmailFactories;
  private readonly mirror: MirrorStore;

  constructor(
    db: Store,
    config: Config,
    factories: EmailFactories = defaultFactories,
    mirror?: MirrorStore,
  ) {
    this.db = db;
    this.config = config;
    this.factories = factories;
    this.mirror = mirror ?? new MirrorStore(db);
  }
  private requireKey(): string {
    if (!this.config.encryptionKey)
      throw new AppError("TOKEN_ENCRYPTION_KEY is not configured", 503);
    return this.config.encryptionKey;
  }
  private meta(stored: StoredEmailAccount): EmailAccountMeta {
    return {
      id: stored.id,
      label: stored.label,
      emailAddress: stored.emailAddress,
      username: stored.username,
      imap: stored.imap,
      smtp: stored.smtp,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  }
  private stored(owner: string, id: string): Promise<StoredEmailAccount> {
    return this.db.get<StoredEmailAccount>(owner, KIND, id).then((account) => {
      if (!account) throw new AppError("Email account not found", 404);
      return account;
    });
  }
  /**
   * Run an operation with the decrypted password, wiping it afterwards.
   * The resolved account never escapes this method.
   */
  private async withAccount<T>(
    owner: string,
    id: string,
    operation: (account: ResolvedEmailAccount) => Promise<T>,
  ): Promise<T> {
    const stored = await this.stored(owner, id);
    const resolved: ResolvedEmailAccount = { ...stored, password: "" };
    try {
      resolved.password = decryptSecret(stored.secret, this.requireKey());
      return await operation(resolved);
    } finally {
      resolved.password = "";
    }
  }
  async listAccounts(owner: string): Promise<EmailAccountMeta[]> {
    const accounts = await this.db.list<StoredEmailAccount>(owner, KIND);
    return accounts
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((account) => this.meta(account));
  }
  async defaultAccount(owner: string): Promise<EmailAccountMeta | null> {
    return (await this.listAccounts(owner))[0] ?? null;
  }
  async createAccount(owner: string, input: EmailAccountCreate): Promise<EmailAccountMeta> {
    const now = new Date().toISOString();
    const stored: StoredEmailAccount = {
      id: randomUUID(),
      label: input.label,
      emailAddress: input.emailAddress,
      username: input.username,
      imap: { host: input.imapHost, port: input.imapPort ?? 993, secure: input.imapSecure ?? true },
      smtp: { host: input.smtpHost, port: input.smtpPort ?? 465, secure: input.smtpSecure ?? true },
      secret: encryptSecret(input.password, this.requireKey()),
      createdAt: now,
      updatedAt: now,
    };
    await this.db.put(owner, KIND, stored);
    return this.meta(stored);
  }
  async updateAccount(
    owner: string,
    id: string,
    patch: EmailAccountUpdate,
  ): Promise<EmailAccountMeta> {
    const stored = await this.stored(owner, id);
    const next: StoredEmailAccount = {
      ...stored,
      label: patch.label ?? stored.label,
      emailAddress: patch.emailAddress ?? stored.emailAddress,
      username: patch.username ?? stored.username,
      imap: {
        host: patch.imapHost ?? stored.imap.host,
        port: patch.imapPort ?? stored.imap.port,
        secure: patch.imapSecure ?? stored.imap.secure,
      },
      smtp: {
        host: patch.smtpHost ?? stored.smtp.host,
        port: patch.smtpPort ?? stored.smtp.port,
        secure: patch.smtpSecure ?? stored.smtp.secure,
      },
      secret: patch.password ? encryptSecret(patch.password, this.requireKey()) : stored.secret,
      updatedAt: new Date().toISOString(),
    };
    await this.db.put(owner, KIND, next);
    return this.meta(next);
  }
  async deleteAccount(owner: string, id: string): Promise<void> {
    await this.stored(owner, id);
    await this.db.remove(owner, KIND, id);
  }
  private safeError(error: unknown, protocol: "IMAP" | "SMTP"): AppError {
    const message = error instanceof Error ? error.message : "Connection failed";
    // Server responses never contain the password; surface the reason safely.
    return new AppError(`${protocol}: ${message}`.slice(0, 500), 502);
  }
  async testConnection(
    owner: string,
    id: string,
  ): Promise<{ imap: boolean; smtp: boolean; imapDetail?: string; smtpDetail?: string }> {
    const result: { imap: boolean; smtp: boolean; imapDetail?: string; smtpDetail?: string } = {
      imap: false,
      smtp: false,
    };
    await this.withAccount(owner, id, async (account) => {
      try {
        const connection = await this.factories.imap(account);
        try {
          await connection.listMailboxes();
          result.imap = true;
        } finally {
          await connection.close();
        }
      } catch (error) {
        result.imapDetail = this.safeError(error, "IMAP").message;
      }
      try {
        const transport = this.factories.smtp(account);
        try {
          await transport.verify();
          result.smtp = true;
        } finally {
          await transport.close();
        }
      } catch (error) {
        result.smtpDetail = this.safeError(error, "SMTP").message;
      }
    });
    return result;
  }
  async folders(owner: string, id: string): Promise<string[]> {
    return this.withAccount(owner, id, async (account) => {
      try {
        const connection = await this.factories.imap(account);
        try {
          return await connection.listMailboxes();
        } finally {
          await connection.close();
        }
      } catch (error) {
        throw this.safeError(error, "IMAP");
      }
    });
  }
  private toSummary(folder: string, message: FetchedMessage): EmailSummary {
    return {
      uid: message.uid,
      folder,
      messageId: message.messageId,
      from: addressOf(message.from[0] ?? {}),
      fromName: displayName(message.from[0]) || undefined,
      to: message.to.map(addressOf).filter(Boolean),
      subject: message.subject,
      date: message.date,
      snippet: message.text.replace(/\s+/g, " ").trim().slice(0, 240),
      unread: !message.flags.includes("\\Seen"),
    };
  }
  private mirrorSummary(folder: string, message: MirrorMessage): EmailSummary {
    return {
      uid: message.uid,
      folder,
      messageId: message.messageId,
      from: message.from,
      fromName: message.fromName,
      to: message.to,
      subject: message.subject,
      date: message.date,
      snippet: message.snippet,
      unread: message.unread,
    };
  }
  /** Folders the local mirror keeps (INBOX, Sent); everything else stays live. */
  private isMirrored(folder: string): boolean {
    return (MIRROR_FOLDERS as readonly string[]).includes(folder);
  }
  /**
   * Paginated mailbox listing/search. Mirrored folders (INBOX, Sent) are
   * served from the local mirror — newest-first, with local full-text
   * search — so listings never depend on the provider's lagging SEARCH
   * index. Falls back to live IMAP only when the mirror has never synced
   * the folder. Non-mirrored folders always go live.
   */
  async page(
    owner: string,
    id: string,
    options: { folder: string; query: string; page: number; pageSize: number },
  ): Promise<EmailPage> {
    const page = Math.max(1, Math.floor(options.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(options.pageSize) || 20));
    if (this.isMirrored(options.folder)) {
      const mirrored = await this.mirror.listPage(owner, id, options.folder, {
        query: options.query,
        page,
        pageSize,
      });
      if (mirrored.syncedAt) {
        return {
          total: mirrored.total,
          page,
          pageSize,
          items: mirrored.items.map((message) => this.mirrorSummary(options.folder, message)),
          syncedAt: mirrored.syncedAt,
        };
      }
      // Mirror is empty for this folder (never synced) — serve live once.
    }
    return this.withAccount(owner, id, async (account) => {
      try {
        const connection = await this.factories.imap(account);
        try {
          const result = await connection.pageMessages(
            options.folder,
            options.query,
            page,
            pageSize,
          );
          return {
            total: result.total,
            page,
            pageSize,
            items: result.messages.map((message) => this.toSummary(options.folder, message)),
            syncedAt: null,
          };
        } finally {
          await connection.close();
        }
      } catch (error) {
        throw this.safeError(error, "IMAP");
      }
    });
  }
  async read(owner: string, id: string, folder: string, uid: number): Promise<EmailMessage> {
    if (this.isMirrored(folder)) {
      const hit = await this.mirror.get(owner, id, folder, uid);
      if (hit) {
        const summary = this.mirrorSummary(folder, hit);
        return { ...summary, cc: hit.cc, body: hit.body.slice(0, 12000), html: hit.bodyHtml };
      }
      // Not mirrored yet (sync hasn't reached it) — fall through to live.
    }
    return this.withAccount(owner, id, async (account) => {
      try {
        const connection = await this.factories.imap(account);
        try {
          const message = await connection.message(folder, uid);
          if (!message) throw new AppError("Message not found", 404);
          const summary = this.toSummary(folder, message);
          return {
            ...summary,
            cc: message.cc.map(addressOf).filter(Boolean),
            body: message.text.slice(0, 12000),
            html: message.html ? message.html.slice(0, 200_000) : undefined,
          };
        } finally {
          await connection.close();
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw this.safeError(error, "IMAP");
      }
    });
  }
  async send(owner: string, id: string, input: EmailSendInput): Promise<{ messageId: string }> {
    // inReplyTo is spliced raw into the In-Reply-To header by nodemailer, so it
    // must be a strict Message-ID. This rejects CR/LF header-injection payloads
    // with a clear zod error before the password is decrypted or any transport
    // is touched.
    if (input.inReplyTo !== undefined) messageIdSchema.parse(input.inReplyTo);
    // The subject is spliced into the Subject header the same way: reject
    // CR/LF here too, before any credential is decrypted or any transport is
    // touched.
    if (/[\r\n]/.test(input.subject)) throw new AppError("Subject must be a single line", 400);
    return this.withAccount(owner, id, async (account) => {
      try {
        const transport = this.factories.smtp(account);
        try {
          const messageId = await transport.send({
            to: input.to,
            cc: input.cc,
            bcc: input.bcc,
            subject: input.subject,
            // Work-email identity: mail from work@example.com is
            // signed "Work User", never "Owner". Enforced here so every
            // sender — the agent's email.send tool, the reviewed action flow,
            // calendar invites — carries the right signature.
            text: applyWorkSignature(input.body, account.emailAddress),
            inReplyTo: input.inReplyTo,
            attachments: input.attachments ?? [],
          });
          return { messageId };
        } finally {
          await transport.close();
        }
      } catch (error) {
        throw this.safeError(error, "SMTP");
      }
    });
  }
  /**
   * Owners that have at least one email account — the scheduler's fan-out
   * list. Derived from the account records, not from plugin state.
   */
  async listOwnersWithAccounts(): Promise<string[]> {
    const rows = await this.db.scan<StoredEmailAccount>(KIND);
    return [...new Set(rows.map((row) => row.owner))];
  }
  /**
   * Sync mirrored folders (INBOX, Sent) for one owner's accounts into the
   * local mirror. When `accountId` is given, only that account syncs.
   * Account passwords are decrypted inside withAccount and wiped after;
   * per-folder failures are logged (counts only) without aborting the rest.
   */
  async syncMirrors(owner: string, accountId?: string): Promise<MirrorSyncReport[]> {
    const accounts = await this.listAccounts(owner);
    const targets =
      accountId === undefined ? accounts : accounts.filter((account) => account.id === accountId);
    if (accountId !== undefined && targets.length === 0)
      throw new AppError("Email account not found", 404);
    const imapSyncFactory = this.factories.imapSync;
    if (!imapSyncFactory) throw new AppError("IMAP sync is not supported by this factory", 503);
    const reports: MirrorSyncReport[] = [];
    for (const target of targets) {
      await this.withAccount(owner, target.id, async (account) => {
        for (const folder of MIRROR_FOLDERS) {
          try {
            reports.push(
              await syncFolderMirror({
                owner,
                accountId: target.id,
                folder,
                account,
                factories: { imapSync: imapSyncFactory },
                store: this.db,
                mirror: this.mirror,
              }),
            );
          } catch (error) {
            // One bad folder (renamed server-side, transient error) must not
            // abort the remaining folders or accounts. Counts only — never
            // subjects or bodies.
            console.log(
              `[email-mirror] folder sync failed (${folder}): ${
                error instanceof Error ? error.message : String(error)
              }`.slice(0, 300),
            );
          }
        }
      });
    }
    return reports;
  }
}
