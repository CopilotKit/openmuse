# OpenFuse roadmap

The release is a personal-agent alpha: delegate a job, inspect its plan, supply missing information, review an action, and return to a saved result. The [reference inventory](docs/FEATURES.md) is broader than this release.

## Shipped locally

- CopilotKit React Native chat and rich task/artifact cards on iOS, Android, and web.
- Server-owned jobs, plans, checkpoints, leases, retries, cancellation, and action receipts.
- Ideas with evidence, Goals, milestones, public-page tracking, and an in-app notification inbox.
- Persistent Chromium sessions, public-page reading, screenshots, manual interaction, and PDF downloads.
- A private Docker Linux computer with bounded terminal commands, persistent workspace files, a text editor, PDF import/export, command receipts, and stop/restart recovery. Terminal networking is disabled.
- PDF viewing and supported form filling, reviewed Gmail/Calendar adapters, CSV spending artifacts, identity, and editable memory.

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
