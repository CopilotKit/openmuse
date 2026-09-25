import type { Mail } from "../../../../../packages/domain/src/index.ts";
import type { EmailMessage, EmailSummary } from "./service.ts";

/**
 * The email connector adds no new chat tools: the existing `search_mail`
 * and `read_mail_thread` tools route through `WorkspaceService`, which
 * falls back to the default IMAP account when Google is not connected.
 * Sending stays inside the reviewed action flow (`email.send` proposals),
 * so there is intentionally no direct-send tool.
 *
 * This module holds the shared mapping from IMAP shapes to the domain Mail
 * type used by the workspace.
 */
export function imapToMail(accountLabel: string, message: EmailSummary | EmailMessage): Mail {
  // v1 treats each IMAP message as its own thread; the id doubles as the
  // thread id so read_mail_thread can fetch it back directly.
  const id = `${message.folder}:${message.uid}`;
  return {
    id,
    threadId: id,
    from: message.from,
    sender: message.fromName ?? message.from,
    to: message.to,
    subject: message.subject,
    body: "body" in message ? message.body : message.snippet,
    ...("html" in message && message.html ? { bodyHtml: message.html } : {}),
    date: message.date ?? new Date(0).toISOString(),
    unread: message.unread,
    label: `${accountLabel} · ${message.folder}`,
    attachments: [],
  };
}
