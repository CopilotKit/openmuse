# Part B: Product extensions — scaffold & credential-blocked manifest

**Status:** Not started. All seven projects in `ROADMAP.md` § *Product extensions*
are individually blocked on credentials, hardware, or an auth/deployment decision.

Per the open-muse skill and `references/background-continuation-and-extensions.md`,
**do not start these without first resolving the blocking credential.** Each item is
its own sub-project with its own auth/capability boundaries and E2E evidence
requirements. This document is the scaffold: it records what each would look like
and what blocks it, so a future session that holds the credential can start
immediately without rediscovering the gate.

---

## B1 — Terminal sessions, desktop apps, per-person VMs, network policy, disk quotas

**Current state:** `docs/COMPUTER.md` — Docker-based Linux computer. Networking
disabled in the sandbox. One owner per deployment.

**Credential / infra needed:**
- Docker access (already available in dev) **or** an E2B API key for production VMs.
- Network policy engine: `nftables` (Docker) or E2B network configs (E2B).

**Planned structure (scaffold only):**

```
apps/server/src/computer/
  computer-runtime.ts     ← extend ComputerBackend with session management
  network-policy.ts       ← allowlist/denylist host:port pairs
  quota.ts                ← disk quota enforcement (statvfs or volume limits)
```

**Interfaces that can be written now (no credential dependency):**

```ts
// apps/server/src/computer/network-policy.ts
export interface NetworkPolicy {
  canReach(host: string, port: number): boolean;
}
export class DenyAllNetworkPolicy implements NetworkPolicy {
  canReach(): boolean { return false; }
}

// apps/server/src/computer/quota.ts
export interface DiskQuota {
  bytesUsed(): number;
  limitBytes: number;
  wouldExceed(additional: number): boolean;
}
export function checkQuota(quota: DiskQuota, additional: number): boolean {
  return !quota.wouldExceed(additional);
}
```

**Capability boundary:** Destructive terminal commands need user confirmation
(reuse the existing `hostExecGate` pattern from `apps/server/src/security/`).

**E2E evidence needed:** Multi-user session isolation, blocked-host failure,
quota enforcement. **Blocked on:** E2B API key (if moving beyond Docker) or a
multi-user deployment decision.

---

## B2 — Agent-operated websites, reservations, customer service, purchase handoff

**Current state:** Persistent Chromium sessions, screenshots, PDF downloads.
The HTTP adapter is contract-tested but not a live connection.

**Credential needed:** Per-site OAuth client IDs/secrets for each connector
(booking.com, retail sites, etc.). CAPTCHA handling likely needs human-in-the-loop.

**Planned structure:**

```
apps/server/src/computer/browser-connectors/
  BaseConnector.ts       ← abstract: login(), navigate(), fill(), click()
  BookingConnector.ts    ← booking.com specific
  RetailConnector.ts     ← generic retail site
  PaymentConnector.ts    ← cart → payment with user review
```

**Interfaces that can be written now:**

```ts
export interface BrowserConnector {
  readonly site: string;
  loginUrl: string | null;
  isLoggedIn: boolean;
  fillForm(fields: Record<string, string>): Promise<void>;
  submit(): Promise<void>;
}
```

**Capability boundary:** Payment tokens server-side only, never sent to client.
Agent suggests actions; user confirms purchases.

**E2E evidence needed:** Book a reservation, complete a purchase with review,
handle a CAPTCHA prompt. **Blocked on:** Per-site OAuth credentials, CAPTCHA
bypass strategy.

---

## B3 — Google Drive/Docs and validated social, bank, health connectors

**Current state:** Gmail/Calendar OAuth plumbing reviewed
(`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`).

**Credential needed:** Per-connector OAuth app registration (Google Cloud Console
for Drive; developer portals for Twitter/X, LinkedIn, Plaid/GoCardless, Apple
Health, Google Fit).

**Planned structure:**

```
apps/server/src/connectors/
  base.ts              ← abstract Connector with OAuth lifecycle
  google-drive.ts      ← Drive read/write, Docs create/edit
  twitter.ts           ← posting + reading
  plaid.ts             ← read-only transaction data
  apple-health.ts      ← read/write health data (device-side, not server)
```

**Interfaces that can be written now:**

```ts
export interface DataConnector {
  readonly name: string;
  readonly requiredScopes: string[];
  authenticate(): Promise<void>;
  disconnect(): Promise<void>;
}
```

**Capability boundary:** Bank data never leaves the user's workspace.
Scope validation: request only needed scopes per connector.

**E2E evidence needed:** Connect each service, perform a representative action,
verify data isolation. **Blocked on:** OAuth credentials per connector.

---

## B4 — Push notifications, voice input/replies, image generation

**Current state:** No push, voice, or image generation on the device.

**Credential needed:**
- FCM server key + Firebase project (`apps/server/src/engine/localai-routes.ts`
  already has `isReachable`; push needs a separate FCM path).
- Image generation API key (OpenAI/DALL-E or Stable Diffusion API).
- STT/TTS are available via Expo AV + Speech (no new server key needed, but
  Whisper API or Google STT would need a key for cloud processing).

**Planned structure:**

```
apps/server/src/
  fcm.ts                 ← POST /fcm/send, device token registration
apps/mobile/src/
  voice-input.tsx        ← Speech → prompt via Expo Speech.Recognition
  voice-output.tsx       ← TTS via Expo Speech.speak
  image-gen.ts           ← calls server /image/generate
```

**Interfaces that can be written now (device-side):**

```ts
// apps/mobile/src/voice-input.ts
export interface VoiceInput {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onResult: (text: string) => void;
}
// Expo Speech.Recognition provides this without server credentials.
```

**Capability boundary:** Image gen API key server-side. Voice on-device uses
Expo's APIs (no new deps).

**E2E evidence needed:** Push arrives when app is killed, voice message produces
a chat reply, image generation produces a viewable result. **Blocked on:** FCM
server key, image generation API key.

---

## B5 — OCR/scanned PDFs, more form types, calendar recurrence editing

**Current state:** PDF viewing + supported form filling (contract-tested).

**Credential needed:**
- OCR engine: Tesseract in the Linux container (local, no key) **or** ML Kit
  (no key but needs native module). Google Vision API would need a key.
- Calendar recurrence: reuses Google Calendar OAuth if the user has connected it.

**Planned structure:**

```
apps/mobile/src/
  ocr-scanner.ts          ← Expo ML Kit or Tesseract wrapper
  form-types.ts           ← additional field types
apps/server/src/
  calendar-rrule.ts       ← RRULE create/edit logic
```

**Interfaces that can be written now:**

```ts
export interface OcrEngine {
  recognize(document: Uint8Array): Promise<string>;
}
```

**Capability boundary:** OCR on-device uses ML Kit (no server auth needed).
Calendar edits reuse the Google Calendar connector from B3.

**E2E evidence needed:** Scan a document, search extracted text, fill a new
form type, edit a recurring event. **Blocked on:** OCR engine integration
(native module or API key for cloud OCR).

---

## B6 — Adaptive long-term plans, broader source-backed ideas, tool registry

**Current state:** Ideas with evidence, Goals, milestones, notification inbox.
Notes promote to tasks.

**Credential needed:** Per-API auth for additional RSS/structured sources
(e.g., Jira API token, Notion integration token).

**Planned structure:**

```
packages/domain/src/
  plan.ts          ← adaptive replanning engine
  sources/         ← RSS, API, web feed connectors
apps/server/src/
  tools/           ← sandboxed tool execution + registry
```

**Interfaces that can be written now:**

```ts
// packages/domain/src/plan.ts
export interface PlanAdaptor {
  onProgress(planId: string, milestone: string, result: unknown): void;
  replan(planId: string, feedback: string): Promise<void>;
}
```

**Capability boundary:** Tools need capability declarations + sandbox execution.
Sources need per-API auth.

**E2E evidence needed:** A 7-day plan that adapts, a new source produces an
idea, a generated tool runs safely in a sandbox. **Blocked on:** Planning engine
design, source API credentials, tool sandbox infrastructure.

---

## B7 — Multi-user authentication, deployment hardening, retention/export controls

**Current state:** Single-user workspace, access key auth, sample mode.

**Credential needed:** Auth provider (Auth0/Clerk/Firebase Auth) or self-hosted
OIDC. This is the largest architectural change.

**Planned structure:**

```
apps/server/src/auth/
  multi-user.ts     ← session model upgrade, team/org management
  roles.ts          ← RBAC: member vs admin
apps/server/src/
  audit-log.ts      ← append-only audit trail
  gdpr.ts           ← data export + right-to-delete
  backup.ts         ← backup/restore + migration
```

**Interfaces that can be written now (stub only):**

```ts
// apps/server/src/auth/roles.ts
export type Role = "owner" | "admin" | "member";
export interface UserSession {
  userId: string;
  orgId: string;
  role: Role;
}
```

**Capability boundary:** Form-factor rules (handheld → no destructive) must
apply per-user. Single-user session model must scale to multi-user.

**E2E evidence needed:** 5 users in one org, role enforcement, data export
produces valid archive, restore from backup succeeds. **Blocked on:** Auth
provider choice (decision + credentials), multi-user deployment decision.

---

## Summary table

| Item | Track | Effort | Credential block | Post-MVP |
|---|---|---|---|---|
| B1 Terminal/VM/container | B-ext | 5–8 days | E2B API key (or Docker-multi-user decision) | Yes |
| B2 Agent-operated websites | B-ext | 8–12 days/connector | Per-site OAuth + CAPTCHA | Yes |
| B3 Google Drive/connectors | B-ext | 3–4 days | Per-connector OAuth | Yes |
| B4 Push/voice/image | B-ext | 2–3 days | FCM server key, image-gen API key | Yes |
| B5 OCR/forms/calendar | B-ext | 3–4 days | OCR API key (or native module) | Yes |
| B6 Adaptive plans | B-ext | 5–7 days | Source API tokens, tool sandbox | Yes |
| B7 Multi-user auth | B-ext | 8–12 days | Auth provider (Auth0/Clerk/Firebase/OIDC) | Yes |

## Credential-blocked items (cannot scaffold further)

| Item | Credential needed | Source |
|---|---|---|
| CopilotKit Intelligence | `CPK_INTELLIGENCE_API_KEY` | `npx copilotkit@latest login` → `project select` |
| Google OAuth live | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `TOKEN_ENCRYPTION_KEY` + `OPENMUSE_ACCESS_KEY` | Google Cloud Console + `openssl` |
| Live model | `OPENAI_API_KEY` (or equivalent) + `MODEL` | Model provider account |
| Android smoke tests | Android device/emulator | Physical device or AVD |
| OpenBot bridge | `AGENT_URL` + agent token | OpenBot running |
| FCM push | Firebase project + server key | Firebase Console |
| E2B containers | E2B API key | E2B account |
| Multi-user auth | Auth provider SDK credentials | Auth0/Clerk/Firebase/Auth0 |

**Do not burn a session rediscovering that the remaining list is externally blocked.**
Ask which credential to target before starting any Part B item.
