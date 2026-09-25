# Beli upgrade inventory

Updated September 24, 2026.

Beli is a substantial OpenMuse derivative, not a cosmetic rename. The published fork keeps the upstream application while adding a connected personal-agent layer across the server, native client, browser worker, and plugin runtime.

## Upgrade scale

| Measure | Snapshot |
| --- | --- |
| Upstream comparison | 270+ changed files |
| Added source | 41,000+ lines |
| Repository size | 330+ tracked files |
| Verification | 615 passing tests |
| Server build | Passing |
| Web build | Passing |

[Open the complete file-by-file comparison](https://github.com/CopilotKit/openmuse/compare/main...onlinegill:main?expand=1).

## Major upgrades

### Agent runtime

- Plugin discovery, manifest validation, configuration schemas, lifecycle services, and route registration.
- Skill discovery, validation, prompt indexing, tool scoping, and script safety checks.
- Provider catalog and encrypted provider-key storage with OpenAI-compatible, Anthropic, Google, DeepSeek, and local provider support.
- Provider fallback cascade and model configuration.
- Durable memory candidates, recall, synthesis, approval, and per-owner context assembly.
- SOUL.md persona loading and prompt assembly.
- Subagent spawning, collection, depth limits, parallelism limits, and isolated worker prompts.
- Centralized tool policy with approval tokens, mutation checks, owner scoping, and connector hooks.

### Personal-agent workflows

- Durable automations and heartbeat scheduling.
- Workboard card lifecycle and task dispatch.
- Scheduled task execution with resumable receipts.
- Voice-note capture and transcription integration.
- MCP client and manager support.

### Connectors and identity

- Credential vault and browser login automation with strict domain matching.
- Email accounts, IMAP/SMTP mail access, mail mirroring, signatures, drafts, and reviewed sends.
- Telegram bot connector with encrypted configuration.
- WhatsApp pairing, allow-list routing, reviewed sends, and encrypted authentication state.
- User accounts, roles, password hashing, session management, and admin protections.

### Native experience

- Expanded navigation and settings.
- Model and provider settings.
- Connector configuration interfaces.
- Chat sidebars, thread controls, history clearing, and session persistence.
- Agent inspection, subagent activity, approvals, and workboard surfaces.
- Voice-note UI, mascot state, shortcuts, and responsive browser/file layouts.

## Verification

The current public snapshot was verified from the merged tree with:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build:server
pnpm build:web
```

Result: lint and typecheck passed, all 615 tests passed, and both server and web builds completed.
