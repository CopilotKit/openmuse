# Email connector

IMAP/SMTP email accounts with encrypted passwords. IMAP is used for reading
(folders, search, messages); SMTP is used for sending — but only through the
existing reviewed action flow (`email.send`), never as a direct chat tool.

## Setup

1. Set `TOKEN_ENCRYPTION_KEY` (same 32-byte base64 key as the other
   connectors).
2. Save an account: `POST /api/email-accounts` with
   ```json
   {
     "label": "Work",
     "emailAddress": "you@example.com",
     "username": "you@example.com",
     "password": "…",
     "imapHost": "imap.example.com",
     "smtpHost": "smtp.example.com"
   }
   ```
   Ports default to 993 (IMAP, implicit TLS) and 465 (SMTP, implicit TLS);
   `imapSecure`/`smtpSecure` can be set to `false` for STARTTLS on ports
   143/587.
3. Verify with `POST /api/email-accounts/:id/test` — it tries an IMAP login
   and an SMTP handshake and reports each result without leaking anything.

## Capabilities

- `GET /api/email-accounts` — list accounts (metadata only).
- `POST /api/email-accounts` — create (201). Returns metadata, never the
  password.
- `PATCH /api/email-accounts/:id` — update settings or rotate the password.
- `DELETE /api/email-accounts/:id` — delete.
- `POST /api/email-accounts/:id/test` — `{ imap: true, smtp: false, ... }`
  connection check with safe per-protocol messages.
- `GET /api/email-accounts/:id/folders` — mailbox list.
- `GET /api/email-accounts/:id/messages?folder=INBOX&query=&page=1&pageSize=20` —
  paginated message summaries, newest first. The search runs server-side
  (IMAP SEARCH) over the whole folder, so paging reaches every match —
  not just the most recent messages. Returns
  `{ total, page, pageSize, items }`; `pageSize` is capped at 50 and bad
  input fails closed with 422.
- `GET /api/email-accounts/:id/messages/:uid?folder=INBOX` — one message
  with a bounded text body.
- Chat tools `search_mail` / `read_mail_thread` automatically use the first
  IMAP account when Google is not connected.
- Sending: the agent prepares `email.send` proposals exactly as before; the
  user approves in the app; execution sends through the account's SMTP
  server. The proposal is pinned to the approving account — if the account
  changes before approval, execution is refused.

## Security

- The password is encrypted with the AES-256-GCM vault (record kind
  `email-accounts`). It is decrypted only for the duration of a single
  IMAP/SMTP operation and wiped in a `finally` block.
- API responses, tool results, logs, and error messages never contain the
  password. Connection-test failures report the protocol and a safe reason.
- Email content is untrusted source data, never instructions. The agent
  tools search and read only; they cannot send.
- Bodies are truncated (summaries 240 chars, full reads 12,000 chars) before
  reaching the model, matching the existing Gmail tools.

## Limitations (v1)

- One connection per operation (no pooling); fine for personal use.
- Attachments are not fetched over IMAP yet — summaries report none.
- Search scans the most recent 50 messages per folder and filters
  client-side, so very old messages may not match.
