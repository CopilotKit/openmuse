/**
 * Typed client for the two backend connectors.
 *
 * Backend route mapping (verified against
 * apps/server/src/connectors/{credentials,email}/routes.ts):
 *
 * Credentials (mounted at /api/credentials):
 *   GET    /api/credentials
 *     -> CredentialMeta[]                         (metadata only, never secrets)
 *   POST   /api/credentials  { label, domain, username, password }
 *     -> CredentialMeta (201)
 *   PATCH  /api/credentials/:id  { label?, domain?, username?, password? }
 *     -> CredentialMeta
 *   DELETE /api/credentials/:id
 *     -> { ok: true }
 *   POST   /api/credentials/:id/login  { sessionId }
 *     -> { ok: true, label, domain, hostname }  (403 if the session is not on
 *        the credential's domain; the session's page must be open on that
 *        domain before calling)
 *   POST   /api/credentials/login-auto  { sessionId, label? }
 *     -> { ok: true, label, domain, hostname }  (auto-matches the session's
 *        site against saved logins by domain; 409 { needsChoice: true,
 *        options } when several match; 404 when none match)
 *
 * Email (mounted at /api/email-accounts):
 *   GET    /api/email-accounts
 *     -> EmailAccountMeta[]
 *   POST   /api/email-accounts  { label, emailAddress, username, password,
 *            imapHost, imapPort?, imapSecure?, smtpHost, smtpPort?, smtpSecure? }
 *     -> EmailAccountMeta (201)
 *   PATCH  /api/email-accounts/:id  { label?, emailAddress?, username?,
 *            password?, imapHost?, imapPort?, imapSecure?, smtpHost?,
 *            smtpPort?, smtpSecure? }
 *     -> EmailAccountMeta
 *   DELETE /api/email-accounts/:id
 *     -> { ok: true }
 *   POST   /api/email-accounts/:id/test  {}
 *     -> { imap: boolean, smtp: boolean, imapDetail?: string, smtpDetail?: string }
 *        (per-protocol results with safe, redacted diagnostics)
 *   GET    /api/email-accounts/:id/folders
 *     -> string[]  (mailbox paths, e.g. INBOX, Sent)
 *   GET    /api/email-accounts/:id/messages?folder=&query=&page=&pageSize=
 *     -> EmailPage { total, page, pageSize, items: EmailSummary[] }
 *        (server-side search over the whole folder, newest first; page is 1-based)
 *   GET    /api/email-accounts/:id/messages/:uid?folder=
 *     -> EmailMessage (full body)
 *
 * Passwords are write-only everywhere: no mail endpoint returns them.
 *
 * WhatsApp (mounted at /api/whatsapp):
 *   GET    /api/whatsapp
 *     -> WhatsAppStatus (pairing status + ban-risk opt-in state)
 *   POST   /api/whatsapp/consent  { accepted }
 *     -> WhatsAppStatus
 *   POST   /api/whatsapp/pair/start  {}
 *     -> WhatsAppStatus (a QR becomes available at /pair/qr)
 *   GET    /api/whatsapp/pair/qr
 *     -> WhatsAppQr (raw QR string — rendered client-side, never logged;
 *        qr is null when no pairing is in progress)
 *   POST   /api/whatsapp/pair/stop  {}
 *     -> WhatsAppStatus
 *   POST   /api/whatsapp/logout  {}
 *     -> WhatsAppStatus (encrypted session wiped)
 *   DELETE /api/whatsapp
 *     -> { ok: true } (full reset; inbox history kept)
 *   GET    /api/whatsapp/rules -> WhatsAppRule[]
 *   POST   /api/whatsapp/rules  { jid, action, label? } -> WhatsAppRule (201)
 *   DELETE /api/whatsapp/rules/:id -> { ok: true }
 *
 * There is intentionally no send route: outbound WhatsApp messages go only
 * through the reviewed action flow (whatsapp.send proposals).
 *
 * Every call goes through MuseApi, which attaches the session Bearer token.
 * Secrets are only ever sent TO the server (create / password rotation);
 * nothing coming back contains a secret, and this module never stores one.
 */
import type { BrowserSession } from "../../../../packages/domain/src";
import type { MuseApi } from "../api";

export interface CredentialMeta {
  id: string;
  label: string;
  domain: string;
  /** Redacted by the server, e.g. "jo***@example.com". Safe to display. */
  usernameHint: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
}

export interface CredentialInput {
  label: string;
  domain: string;
  username: string;
  /** Write-only: sent on create / rotation, never read back. */
  password: string;
}

export interface LoginReceipt {
  ok: true;
  label: string;
  domain: string;
  hostname: string;
}

export interface EmailConnection {
  host: string;
  port: number;
  secure: boolean;
}

export interface EmailAccountMeta {
  id: string;
  label: string;
  emailAddress: string;
  username: string;
  imap: EmailConnection;
  smtp: EmailConnection;
  createdAt: string;
  updatedAt: string;
}

export interface EmailAccountInput {
  label: string;
  emailAddress: string;
  username: string;
  /** Write-only: sent on create / rotation, never read back. */
  password: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

export interface ConnectionTest {
  imap: boolean;
  smtp: boolean;
  /** Safe, redacted server-side failure reasons. */
  imapDetail?: string;
  smtpDetail?: string;
}

/** One message row in a paginated mailbox listing. Never carries a secret. */
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
}

/** One page of a mailbox listing. `total` is the full match count. */
export interface EmailPage {
  total: number;
  page: number;
  pageSize: number;
  items: EmailSummary[];
}

export interface EmailMessagesQuery {
  folder?: string;
  query?: string;
  page?: number;
  pageSize?: number;
}

/** One row of GET /api/plugins (verified against apps/server/src/plugins/routes.ts). */

/**
 * WhatsApp (personal, Baileys) — mounted at /api/whatsapp. Verified against
 * apps/server/src/connectors/whatsapp/routes.ts. The QR is a raw string
 * rendered client-side; nothing coming back contains session credentials.
 */
export type WhatsAppPairingStatus =
  | "not_paired"
  | "pairing"
  | "connected"
  | "needs_repair"
  | "disabled";

export interface WhatsAppStatus {
  status: WhatsAppPairingStatus;
  jid?: string;
  /** True only after the explicit ban-risk opt-in. */
  consented: boolean;
  lastSeenAt?: string;
  updatedAt: string;
}

export interface WhatsAppQr {
  qr: string | null;
  status: WhatsAppPairingStatus;
  /** ISO time the QR stops working, if a QR is pending. */
  expiresAt: string | null;
}

export interface WhatsAppRule {
  id: string;
  jid: string;
  action: "allow" | "deny";
  label?: string;
  createdAt: string;
}
export interface PluginSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  categories: string[];
  enabled: boolean;
  status: "active" | "error";
  mountPath: string;
  tools: string[];
  writeOnly: string[];
  configGroups: string[];
  hasConfig: boolean;
}

export interface PluginProblem {
  pluginId: string;
  dir: string;
  message: string;
}

export interface PluginConfigProperty {
  type?: string;
  title?: string;
  description?: string;
  /** "password" | "switch" | "textarea" | "select" … */
  widget?: string;
  group?: string;
  enum?: string[];
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

/** GET /api/plugins/:id/config. writeOnly values are ALWAYS "" — never secrets. */
export interface PluginConfigView {
  id: string;
  enabled: boolean;
  config: Record<string, unknown>;
  configSchema: {
    properties?: Record<string, PluginConfigProperty>;
    required?: string[];
  };
  configGroups: string[];
  writeOnly: string[];
}

export interface ConnectorsApi {
  credentials: {
    list(): Promise<CredentialMeta[]>;
    create(input: CredentialInput): Promise<CredentialMeta>;
    update(id: string, patch: Partial<CredentialInput>): Promise<CredentialMeta>;
    remove(id: string): Promise<{ ok: true }>;
    login(id: string, sessionId: string): Promise<LoginReceipt>;
  };
  email: {
    list(): Promise<EmailAccountMeta[]>;
    create(input: EmailAccountInput): Promise<EmailAccountMeta>;
    update(id: string, patch: Partial<EmailAccountInput>): Promise<EmailAccountMeta>;
    remove(id: string): Promise<{ ok: true }>;
    test(id: string): Promise<ConnectionTest>;
    /** Mailbox paths for the account (INBOX, Sent, ...). */
    folders(id: string): Promise<string[]>;
    /**
     * Paginated message listing/search for one folder. `total` drives the
     * "load more" UI; `page` is 1-based.
     */
    messages(id: string, query?: EmailMessagesQuery): Promise<EmailPage>;
    /** Full body of one message. */
    read(id: string, uid: number, folder?: string): Promise<EmailMessage>;
  };
  browsers: {
    /** Open a fresh browser session on the given URL (for "log in" flows). */
    open(url: string): Promise<BrowserSession>;
  };
  whatsapp: {
    /** Pairing status (ban-risk opt-in included). */
    status(): Promise<WhatsAppStatus>;
    /** Explicit opt-in to the unofficial-client ban risk. Required to pair. */
    consent(accepted: boolean): Promise<WhatsAppStatus>;
    /** Start pairing; returns the updated status (a QR becomes available). */
    startPairing(): Promise<WhatsAppStatus>;
    /** Raw QR string for client-side rendering (never logged). */
    qr(): Promise<WhatsAppQr>;
    /** Cancel a pairing attempt without wiping anything. */
    stopPairing(): Promise<WhatsAppStatus>;
    /** Log out of WhatsApp; the encrypted session is wiped. */
    logout(): Promise<WhatsAppStatus>;
    /** Full reset: session + rules + pairing state. Inbox history is kept. */
    reset(): Promise<{ ok: true }>;
    rules: {
      list(): Promise<WhatsAppRule[]>;
      create(input: {
        jid: string;
        action: "allow" | "deny";
        label?: string;
      }): Promise<WhatsAppRule>;
      remove(id: string): Promise<{ ok: true }>;
    };
  };
  plugins: {
    /** Plugin summaries for this owner (drives the Connectors tabs). */
    list(): Promise<PluginSummary[]>;
    /** Discovery/load/doctor problems (surfaced in plugin settings). */
    errors(): Promise<PluginProblem[]>;
    /** Enabled flag + redacted config + schema. writeOnly values are "". */
    getConfig(id: string): Promise<PluginConfigView>;
    /**
     * PATCH config. writeOnly "" means "leave the stored secret unchanged" —
     * the server never returns a secret, so the form never has one to send.
     */
    updateConfig(
      id: string,
      patch: { enabled?: boolean; config?: Record<string, unknown> },
    ): Promise<PluginConfigView>;
    /** Owner-scoped, metadata-only dataBinding RPC. */
    invoke(id: string, binding: string, params?: unknown): Promise<unknown>;
  };
}

export function createConnectorsApi(api: MuseApi): ConnectorsApi {
  const path = (base: string, id: string, suffix = "") =>
    `${base}/${encodeURIComponent(id)}${suffix}`;
  return {
    credentials: {
      list: () => api.request<CredentialMeta[]>("/api/credentials"),
      create: (input) => api.request<CredentialMeta>("/api/credentials", input),
      update: (id, patch) =>
        api.request<CredentialMeta>(path("/api/credentials", id), patch, "PATCH"),
      remove: (id) => api.request<{ ok: true }>(path("/api/credentials", id), undefined, "DELETE"),
      login: (id, sessionId) =>
        api.request<LoginReceipt>(path("/api/credentials", id, "/login"), { sessionId }),
    },
    email: {
      list: () => api.request<EmailAccountMeta[]>("/api/email-accounts"),
      create: (input) => api.request<EmailAccountMeta>("/api/email-accounts", input),
      update: (id, patch) =>
        api.request<EmailAccountMeta>(path("/api/email-accounts", id), patch, "PATCH"),
      remove: (id) =>
        api.request<{ ok: true }>(path("/api/email-accounts", id), undefined, "DELETE"),
      test: (id) => api.request<ConnectionTest>(path("/api/email-accounts", id, "/test"), {}),
      folders: (id) => api.request<string[]>(path("/api/email-accounts", id, "/folders")),
      messages: (id, query = {}) => {
        const params = new URLSearchParams();
        if (query.folder) params.set("folder", query.folder);
        if (query.query) params.set("query", query.query);
        if (query.page !== undefined) params.set("page", String(query.page));
        if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
        const suffix = `/messages?${params.toString()}`;
        return api.request<EmailPage>(path("/api/email-accounts", id, suffix));
      },
      read: (id, uid, folder = "INBOX") =>
        api.request<EmailMessage>(
          `${path("/api/email-accounts", id, "/messages")}/${uid}?folder=${encodeURIComponent(folder)}`,
        ),
    },
    browsers: {
      open: (url) => api.request<BrowserSession>("/api/browsers", { url }),
    },
    whatsapp: {
      status: () => api.request<WhatsAppStatus>("/api/whatsapp"),
      consent: (accepted) => api.request<WhatsAppStatus>("/api/whatsapp/consent", { accepted }),
      startPairing: () => api.request<WhatsAppStatus>("/api/whatsapp/pair/start", {}),
      qr: () => api.request<WhatsAppQr>("/api/whatsapp/pair/qr"),
      stopPairing: () => api.request<WhatsAppStatus>("/api/whatsapp/pair/stop", {}),
      logout: () => api.request<WhatsAppStatus>("/api/whatsapp/logout", {}),
      reset: () => api.request<{ ok: true }>("/api/whatsapp", undefined, "DELETE"),
      rules: {
        list: () => api.request<WhatsAppRule[]>("/api/whatsapp/rules"),
        create: (input) => api.request<WhatsAppRule>("/api/whatsapp/rules", input),
        remove: (id) =>
          api.request<{ ok: true }>(path("/api/whatsapp/rules", id), undefined, "DELETE"),
      },
    },
    plugins: {
      list: () => api.request<PluginSummary[]>("/api/plugins"),
      errors: () =>
        api.request<{ errors: PluginProblem[] }>("/api/plugins/errors").then((body) => body.errors),
      getConfig: (id) =>
        api.request<PluginConfigView>(`/api/plugins/${encodeURIComponent(id)}/config`),
      updateConfig: (id, patch) =>
        api.request<PluginConfigView>(
          `/api/plugins/${encodeURIComponent(id)}/config`,
          patch,
          "PATCH",
        ),
      invoke: (id, binding, params) =>
        api.request<unknown>(`/api/plugins/${encodeURIComponent(id)}/invoke`, {
          binding,
          params,
        }),
    },
  };
}

/** Client-side domain check, mirroring the server's domainMatches for UI filtering only. */
export function sessionMatchesDomain(sessionUrl: string, domain: string): boolean {
  let host: string;
  try {
    host = new URL(sessionUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const expected = domain.toLowerCase();
  return host === expected || host.endsWith(`.${expected}`);
}

export function requestMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
