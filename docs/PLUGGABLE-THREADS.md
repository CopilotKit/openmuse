# Pluggable thread persistence

OpenMuse keeps chat threads behind a provider boundary with two backends,
selected by `THREADS_BACKEND`:

| `THREADS_BACKEND` | `CPK_INTELLIGENCE_API_KEY` | Behavior |
|---|---|---|
| `intelligence` (default) | set | Current behavior, unchanged: CopilotKit Intelligence persists and replays threads. |
| `intelligence` | missing/blank | The API **refuses to start** with the Intelligence key message. There is never a silent downgrade to local storage. |
| `local` | set or missing | Threads persist in the server's own database (PGlite, or PostgreSQL with `DATABASE_URL`). No Intelligence requests are made; a set key is ignored with a one-line warning. |
| anything else | — | The API refuses to start: `THREADS_BACKEND must be intelligence or local`. |

## How the local backend works

`CopilotRuntime` dispatches on its options: with `intelligence` it builds the
Intelligence runtime; with `runner` (and no `intelligence`) it builds the SSE
runtime and serves thread endpoints from that runner. The local backend is a
`PersistentAgentRunner` (`apps/server/src/threads/local-runner.ts`) that
subclasses the runtime's own `InMemoryAgentRunner`:

- **Hydrate**: before `run`/`connect`, the thread's snapshot is loaded from the
  database (`chat-threads` records: message snapshot plus compacted events)
  into the runner's store, so history survives API restarts.
- **Durability boundary**: the terminal `RUN_FINISHED` event is held until the
  snapshot write completes. A client never sees a completed run that a restart
  would lose. A failed write surfaces as a visible `RUN_ERROR`, not a silent
  loss.
- **Owner scoping**: the agents factory records the owning user on each agent
  it builds; saved records carry that owner, and the thread list is served per
  owner from the database (the runtime's built-in local list fallback is
  process-global and cannot scope).

The only internal CopilotKit API this touches is the process-global in-memory
store used for hydration/snapshot (pinned in `THREADS_CONTRACT_REF`); a runtime
upgrade that moves it breaks compilation in that one module.

## Capability matrix

Local mode intentionally serves a subset. Unsupported operations are hidden in
the native UI rather than faked, and return the runtime's own `422` if called
directly.

| Capability | intelligence | local |
|---|---|---|
| Main conversation, side chats | ✓ | ✓ |
| Thread list, pagination | ✓ | ✓ (owner-scoped, database-backed) |
| Replay on open (`connect`) | ✓ | ✓ |
| Inspect messages/events/state | ✓ | ✓ |
| Clear threads | ✓ | ✓ |
| Rename | ✓ | hidden / `422` |
| Archive / restore | ✓ | hidden / `422` |
| Realtime thread metadata | ✓ | unavailable (the client SDK skips the subscription) |

## Operator notes

- Set `THREADS_BACKEND=local` to run fully self-hosted with no CopilotKit
  account and no Intelligence key. Chat history then lives (and dies) with the
  `DATA_DIR`/`DATABASE_URL` database — back it up like the rest of the data.
- Switching backends is not a migration: local threads start empty, and
  Intelligence threads stay in Intelligence. Import/export across backends is
  out of scope.
- The demo harness (`pnpm dev:demo`) follows the same setting: with a key it
  uses Intelligence, without one it runs keyless on the local backend.
- `POST /api/copilotkit/threads/clear` wipes local thread records as well as
  in-memory history.

See [RICH-THREADS.md](RICH-THREADS.md) for the Intelligence path and
[OPENBOT-INTEGRATION.md](OPENBOT-INTEGRATION.md) for the adapter seam pattern
this provider follows.
