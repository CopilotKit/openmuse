# Credentials connector

Encrypted website logins for the agent browser. The user saves a login once;
the agent can then sign the browser session in without ever seeing the
password.

## Setup

1. Set `TOKEN_ENCRYPTION_KEY` to a 32-byte base64 key (already required for
   Google OAuth — the same key is reused).
2. Save a credential: `POST /api/credentials` with
   `{ label, domain, username, password }`. `domain` is a bare hostname such
   as `accounts.example.com` (a full URL is tolerated; only its hostname is
   kept).
3. In chat, ask the agent to log in ("log in to my bank"). The agent calls
   the `browser_login` tool with the browser session id; the label is omitted
   so the session's site is auto-matched against saved logins by domain. The
   user's own words "log in / sign in / login" are the authorization — the
   agent must not refuse or re-ask when they said it.

## Capabilities

- `GET /api/credentials` — list saved logins (metadata only: id, label,
  domain, username hint, timestamps).
- `POST /api/credentials` — create. Returns metadata, never the secret.
- `PATCH /api/credentials/:id` — update label, domain, username, password.
- `DELETE /api/credentials/:id` — delete.
- `POST /api/credentials/:id/login` — `{ sessionId }`: decrypts the login,
  verifies the session's current page is on the credential's domain, and asks
  the browser worker to fill the username/password fields and submit.
  Returns `{ ok, label, domain }` or a safe error.
- `POST /api/credentials/login-auto` — `{ sessionId, label? }`: signs the
  session into whatever site it is on, auto-matching saved logins by domain.
  Returns `{ ok, label, domain, hostname }`, `409 { needsChoice: true,
  options: [{ label, usernameHint }] }` when several saved logins match, or
  `404` when none match. Only matching domains are ever considered, so a
  wrong-domain fill is impossible through this route.
- Agent tool `browser_login` (chat + delegated tasks): with a label, looks
  the credential up by label; without one, auto-matches the session's site
  by domain. The user's own "log in / sign in / login" words are the
  authorization — no refusal, no re-asking. Only ask first for a login the
  user never mentioned.

## Security

- The password is encrypted with the AES-256-GCM vault before storage
  (record kind `browser-credentials`, one record per credential id).
- **Domain lock (two layers):** the API service refuses the fill with 403
  unless the session's current hostname equals the credential's domain or is
  a subdomain of it, and the browser worker independently re-checks the live
  page URL against the expected domain before typing anything. A phishing or
  lookalike page can never trigger a fill.
- The decrypted password travels only over the authenticated server→worker
  channel and lives in memory for the duration of the fill; it is wiped in a
  `finally` block. It never enters the chat, tool results, logs, screenshots,
  or persisted evidence.
- Every login writes an audit entry to the owner's activity feed with the
  label, domain, and session id — never secret material.
- The worker finds the login form heuristically (visible password field plus
  a username/email-shaped field). If the page has no login form, the login
  fails with a safe error instead of typing anywhere.

## Lifecycle

Credentials are per-owner. Updating the password re-encrypts in place.
Deleting removes the record immediately. Changing `TOKEN_ENCRYPTION_KEY`
invalidates all stored credentials (they become undecryptable by design).
