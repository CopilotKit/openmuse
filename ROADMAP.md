# OpenMuse roadmap

The release is a personal-agent alpha: delegate a job, inspect its plan, supply missing information, review an action, and return to a saved result. The [reference inventory](docs/FEATURES.md) is broader than this release.

## Shipped locally

- CopilotKit React Native chat and rich task/artifact cards on iOS, Android, and web.
- Server-owned jobs, plans, checkpoints, leases, retries, cancellation, and action receipts.
- Ideas with evidence, Goals, milestones, public-page tracking, and an in-app notification inbox.
- Persistent Chromium sessions, public-page reading, screenshots, manual interaction, and PDF downloads.
- A private Docker Linux computer with bounded terminal commands, persistent workspace files, a text editor, PDF import/export, command receipts, and stop/restart recovery. Terminal networking is disabled.
- PDF viewing and supported form filling, reviewed Gmail/Calendar adapters, CSV spending artifacts, identity, and editable memory.
- Outbound URL guard and a host-execution gate keyed by surface, with DNS re-validated per request.
- Device pairing: a device may read without pairing, but claiming, heartbeating, or reporting work all require it. A device cannot pair itself; the first device bootstraps with the account access key, once only.
- Device work loop (server side): `claim`/`heartbeat`/`report` with compare-and-swap leases, so a lost lease returns the task to the queue instead of stranding it. Two devices racing for one task produce exactly one winner.
- Form factor as a capability-contract rule: a handheld never takes `destructive` work, even when it declares the capability, and an undeclared or unrecognised form factor is treated as a handheld.
- Notes in the same store as tasks, promotable deliberately and exactly once, capturable from the phone or from chat. Saving a note starts no work.

## Notes: capture and promotion

- [x] **Notes, with deliberate promotion into tasks, capturable from chat** (shipped
  2026-10-04). Vision
  requirement 1 asks for notes and tasks in one store, not two systems, so a note
  is a row in the same `records` table as a task and syncs through the existing
  change log. Saving a note starts no work; promotion is an explicit request, the
  task id is derived from the note id so a repeated or concurrent promotion yields
  one task, and a promoted note cannot be deleted while its task is live. Mobile
  screen in `apps/mobile/src/notes.tsx`, rules in `notes-model.ts`. Chat can
  capture with `capture_note` but cannot promote — promotion stays the user's
  explicit act, enforced by the tool the model is offered. See
  [docs/SYNC.md](docs/SYNC.md).

## Device plane: the remaining half

- [x] **Mobile client for the device work loop** (shipped 2026-10-04). `apps/mobile/src/device-agent-loop.ts` drives claim/heartbeat/report, aborts and stays silent when it loses a lease, retries through a network blip instead of abandoning live work, and keeps the run in hand going when the app is backgrounded. Off by default; turned on from Apps. Device work runs through the same agent as chat. See [docs/SYNC.md](docs/SYNC.md).
- [x] **Background continuation when the app is killed, not just backgrounded** (shipped 2026-10-06). The device work loop now persists its active claim to `AgentWorkStorage`
  (SharedPreferences on Android via a foreground service, fire-and-forget SecureStore elsewhere)
  and restores it on restart through a headless task (`apps/mobile/src/device-agent-loop.ts`:
  `AgentWorkState`/`recoverAgentState()`/`AgentWorkStorage` + `restoreSavedState()`;
  `apps/mobile/src/modules/headless-recovery.ts` + `AgentWorkService.ts`; Kotlin service in
  `apps/mobile/plugins/agent-work-service/`; Expo plugin `withAgentWorkService.ts`). On process
  restart the recovery banner offers Resume (restart the heartbeat to hold the lease) or Cancel
  (clear saved state). A lapsed lease still requeues via the server side, so this is the
  optimisation the lease-recovery path made safe. 19 new tests; suite 577/577. `recoverAgentState`
  treats a malformed lease timestamp as dead, never live — consistent with `device-work.ts`.
- [x] **Device-side pairing UX** (shipped 2026-10-04). An already-paired device lists what is waiting and mints a code; an unpaired one shows a code field to redeem it with. `GET /devices` now reports `paired` per device, without which the approving device has no target to mint for and a second phone could never be paired. See [docs/SYNC.md](docs/SYNC.md).
- [x] **On-device model provider** (shipped 2026-10-06). tool-calling is implemented
  and merged in meaty (non-streaming [PR #380](https://github.com/Wiltermoodj/meaty/pull/380),
  streaming [PR #383](https://github.com/Wiltermoodj/meaty/pull/383)). `meaty` serves
  `/v1/chat/completions` (SSE + non-streaming), `/v1/models`, audio, vision and
  embeddings, with full OpenAI-compatible tool-calling — but binds `127.0.0.1` on
  port 11435 only, and OpenMuse runs all inference in `apps/server`, which cannot
  reach a phone's loopback — closed by the phone-proxy sequence below.
  Decided 2026-10-04: the phone proxies to its own loopback endpoint, the server
  routes per request with a remote-then-API fallback, and meaty's endpoint uses
  standard OpenAI tool semantics (`tool_choice: "auto"` or omitted; `"required"`/named
  is refused). Sequence (meaty-side complete; OpenMuse-side complete): provider
  wiring → server relay → phone streaming client. Meaty is
  `Wiltermoodj/meaty` — a separate on-device AI app serving an HTTP contract,
  never a library OpenMuse imports. Detail in
  [docs/ON-DEVICE-INFERENCE.md](docs/ON-DEVICE-INFERENCE.md). Decision 2026-10-04:
  treat the endpoint as optional, never gate core agent work on it. `meaty` is a
  **separate project** providing on-device LLMs to other applications; OpenMuse
  consumes it as one optional model source and must fall back cleanly when its
  endpoint is absent. Not a code-level dependency.

## Integration acceptance next

- [ ] Live Google OAuth, mail, attachment, and calendar acceptance on real test accounts.
- [ ] CopilotKit Intelligence Rich Threads persistence/replay and cross-device acceptance with a project key.
- [ ] Live model acceptance for open-ended delegated jobs and source-based research.
- [ ] Installed Android emulator/device smoke tests. Android bundles already export; iPhone simulator has been exercised.
- [ ] OpenBot user/session bridge, routines, and computer backend. The disabled HTTP adapter is contract-tested; it is not a live connection.

## Product extensions

- [ ] Interactive terminal sessions, desktop applications, per-person VM orchestration, controlled network access, and workspace disk quotas. The current [Linux computer](docs/COMPUTER.md) supports one owner per deployment.
- [ ] Agent-operated interactive websites, reservations, customer service, and carefully scoped purchase handoff.
- [ ] Google Drive/Docs and individually validated social, bank, and health connectors.
- [ ] Device push notifications, voice input/replies, and image generation.
- [ ] OCR/scanned PDFs, more form types, and calendar recurrence editing.
- [ ] Adaptive long-term plans, broader source-backed ideas, and a managed registry for generated tools.
- [ ] Multi-user authentication, deployment hardening, retention/export controls, and operational recovery.

Each item needs its own authentication, capability boundaries, failure behavior, and end-to-end evidence before it becomes a supported feature. No dates or third-party API access are promised.
