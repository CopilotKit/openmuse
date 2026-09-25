# WhatsApp (personal) — Baileys connector

> ⚠️ **BAN RISK — READ FIRST.** This connector drives WhatsApp through
> Baileys, an **unofficial** client. Meta detects unofficial clients and bans
> the number — usually a temporary ban first, then a permanent one. Use a
> **secondary number**, never your main business number. Pairing requires an
> explicit in-app opt-in that states this risk. The Cloud-API business inbox
> remains the safe primary path; this connector is the opt-in personal path.

Agent presence in the user's own WhatsApp chats: QR pairing, default-deny
inbound routing into agent tasks, and outbound sends only through the
reviewed-action flow.

## Architecture

Baileys needs a persistent WebSocket; the API process cannot hold it (two
sockets would kick each other off WhatsApp). So the connector is split:

- **Sidecar** (`apps/server/src/whatsapp-entry.ts`, `dev:whatsapp`): holds
  the single `BaileysBridge` socket, serves a localhost-only admin API
  (bearer `WHATSAPP_SIDECAR_TOKEN`, no CORS), and forwards stripped inbound
  messages to the API for routing. Single-instance enforced by a DB lease
  (`whatsapp-lease`); a second sidecar exits.
- **API process**: `WhatsAppService` + `HttpSidecarBridge` (thin HTTP client
  to the sidecar) + routes at `/api/whatsapp` + agent tools. Internal
  sidecar callbacks arrive at `POST /internal/whatsapp/inbound`
  (sidecar-bearer authenticated).

```
phone ──WhatsApp── BaileysBridge (sidecar) ──HTTP── WhatsAppService (API)
                                                      ├─ allow/deny filter
                                                      ├─ record (whatsapp-inbox)
                                                      └─ AgentService.createTask
```

## Pairing

1. The Connectors UI shows the ban-risk consent banner; pairing is refused
   (403) until the user opts in (`POST /api/whatsapp/consent`).
2. `POST /api/whatsapp/pair/start` → the sidecar opens a Baileys socket with
   a fresh encrypted auth state and emits a QR.
3. The QR is stored as a **raw string** in the pairing record and served at
   `GET /api/whatsapp/pair/qr`; the mobile client renders it (no server
   image dependencies, secret out of logs).
4. On `connection.open` the pairing is marked connected; on logout/401 the
   status becomes `needs_repair`, the auth envelope is wiped, and the user
   is notified. Re-pairing needs a fresh QR scan; the one-time explicit
   opt-in stays in force (revoke it with `POST /api/whatsapp/logout`).

## Inbound

`messages.upsert` → strip to
`{fromJid, chatJid, text, hasMedia, messageId, timestamp}` (push/display
names dropped; status broadcasts and newsletters ignored) → allow/deny
filter **before** the agent touches anything (default-deny unknown senders;
deny wins) → recorded under kind `whatsapp-inbox` → allowed messages route
via `AgentService.createTask` (same path as `delegate_task`), framed as
untrusted third-party content. The sidecar marks the message read only
after the API acknowledges handling.

## Outbound

There is **no direct send route and no direct-send tool**. `whatsapp_send`
only proposes a `whatsapp.send` reviewed action; the owner approves in the
app; execution (`WhatsAppService.executeApprovedSend`, wired in app.ts)
additionally requires the recipient to be on the allow-list (403 otherwise)
and the session to be connected.

## Storage (all owner-scoped)

- `whatsapp-pairing` — pairing status, QR (while pairing), JID, consent.
- `whatsapp-auth` / `whatsapp-auth-keys` — Baileys auth state as
  AES-256-GCM envelopes (`TOKEN_ENCRYPTION_KEY`). Never plaintext, never
  files (`useMultiFileAuthState` is not used). Wiped on logout/delete.
- `whatsapp-rules` — allow/deny rules per JID.
- `whatsapp-inbox` — stripped inbound records (metadata only).
- `whatsapp-lease` — sidecar single-instance lease.

## Limits

- Media is metadata-only in v1: inbound messages record only a `hasMedia`
  flag. Raw media is never downloaded, stored, or sent to the model.
- Inbound text is capped (8192 chars at strip, 4000 stored) and is
  untrusted data — never instructions.
- JIDs are the only identity and are validated server-side with
  `^\d+@(s\.whatsapp\.net|g\.us)$`.

## What is NOT verified

The pairing step itself was built and tested with a fake bridge only — no
real Baileys socket connection was ever opened (by design, pending the
user's opt-in). First real pairing must be watched live.

## Deploy notes

- `pnpm add @whiskeysockets/baileys@7.0.0-rc14` (declared in root
  package.json; install on the deployment host — the sandbox could not run
  pnpm).
- Env: `WHATSAPP_SIDECAR_TOKEN` (required by the sidecar),
  `WHATSAPP_SIDECAR_URL` (API → sidecar, default
  `http://127.0.0.1:8791`), `WHATSAPP_SIDECAR_PORT` (default 8791),
  `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`.
- The plugin is `enabledByDefault: false` — enable it per owner in
  Connectors after the opt-in.
