# OpenMuse Research & Documentation

This directory consolidates all OpenMuse research notes, reference docs, and
deployment patterns. The authoritative source for each topic is listed below.

## Contents

| File | Topic |
|------|-------|
| `mobile-routing.md` | Per-device model routing: domain types, server endpoints, mobile hooks/ui, chatToolAllowlist overrides, step budget validation |
| `container-deployment.md` | Docker + Apple Containers deployment: compose services, platform differences, env vars, computer container setup |
| `typescript-strictness.md` | Maximum strictness compiler flags, fix patterns for noUncheckedIndexedAccess, Biome integration |
| `notunchecked-access-fixes.md` | Detailed fix patterns for noUncheckedIndexedAccess: index access, destructuring, compound assignment |

## Related Hermes Skills

- `openmuse-local-llm-setup` (software-development) — primary skill for configuring OpenMuse with local LLMs, Docker deployment, and cross-device sync. Reference docs in this directory are mirrored in the skill and kept in sync.
- `maximum-strictness-typescript` — TypeScript/Biome strictness workflow
- `biome-lint-workflow` — Biome lint/format workflow with fix patterns

## Git State

- Working directory: `/home/ubuntu/OpenMuse`
- Git remote push URL: blocked (`never://blocked`) — one-way sync only
- Weekly cron: Sundays 03:00 UTC, checks upstream via `scripts/check-upstream.sh`
- PostgreSQL: `openmuse_test` on localhost:5432, user `openmuse`

## Verification Status

- tsc: 0 errors (main, worker, mobile configs)
- Biome: 0 errors, 0 warnings (125 files)
- Tests: 230/230 pass (4 pre-existing Postgres test failures in device-streaming.test.ts)
