# Workboard

A Kanban board of agent-work cards backed by the task worker. Watch subagent
fan-outs as cards move instead of reading logs.

## Columns

`backlog → todo → doing → review → done`, plus `failed`.

## Files

- `schemas.ts` — zod input schemas (title ≤160, description ≤4000 plain text,
  priority/labels, goalId validated against the owner's goals).
- `service.ts` — `WorkboardService`: card CRUD over the generic store (kind
  `workboard-cards`, owner-scoped), `stats()`, `dispatch()`, settle sync.
- `routes.ts` — `GET /api/workboard` returns `{ cards, stats }`, the
  `workboard.cards.list/stats` binding shape: one call renders the board.
- `tools.ts` — `workboard_create_card`, `workboard_move_card`,
  `workboard_dispatch` (chat/worker tools, policy-wrapped like the other chat
  tools).

## Dispatch

- **Task mode** (`mode: "task"`): `agent.createTask` with idempotency key =
  the card id (the real task id is hashed internally by `AgentService` as
  `hash("task:" + cardId)`); the card flips `todo → doing`. Re-dispatch is
  idempotent: if the card already links a task, the existing linkage is
  returned without spending another run.
- **Fan-out mode** (`mode: "fanout"`): `agent.spawnSubagents` with
  `{ depth: 0, idempotencyKey: "${card.id}:fanout" }` (children land at depth
  1, capped at the existing 5-subagent limit and the 100-active-task cap —
  each child goes through `createTask`, so the cap is enforced per child) plus
  one child card per subagent (child ids derive deterministically as
  `wbchild:` + the first 32 hex chars of `hash("task:" + fanoutId + ":" +
  label)`, so a retried dispatch never duplicates cards). The parent flips
  `todo → doing`.

Fan-out dispatch from chat does **not** run directly: the tool proposes a
`workboard.dispatch` reviewed action via `ActionService.propose/decide`, and
approval executes it through `WorkboardService.executeApprovedDispatch`. The
proposal idempotency key hashes the card id, mode, and parameters, so
re-proposing identical parameters returns the same review instead of a
duplicate.

**Depth guard:** task-mode dispatch from a depth-1 subagent (a `workboard_dispatch`
tool call inside a worker run whose `taskId` resolves to a depth ≥1 task) is
denied with 403 — subagents cannot launder delegation through the workboard.

## Settle sync

`AgentService.publishOutcome` invokes the optional `onTaskSettled` hook (no
worker lease changes). The mapping is:

- `succeeded → done`, `failed → failed`, `cancelled → failed` (deliberate: a
  cancelled run never completes the card, keeping fan-out parent completion
  unblocked), `waiting_approval`/`waiting_input → review`.

Task outcomes drive the worker-managed columns (`doing`, `review`) only: once
the user moves a card elsewhere they own it and the worker stops moving it. A
fan-out parent completes (`done`, or `failed` if any child failed) when all of
its children are terminal.

## Concurrency

Card moves are optimistic concurrency on `updatedAt`: the client sends the
`updatedAt` it rendered, and a mismatch is rejected with 409 so a stale
writer learns the card changed instead of silently overwriting. Dispatch
claims the card the same way (expected status + `updatedAt`). The check is
read-then-write against the store (no atomic CAS primitive exists), so two
truly concurrent writers can still race — but the dispatch claim narrows the
window to: second writer finds status already `doing` and returns the existing
linkage instead of spawning a duplicate task. Settle sync only touches cards
in the worker-managed columns, so a user move always wins the last word.

## Security notes

- Card content is plain text only (zod length caps); the mobile board renders
  it with `Text`, never HTML/WebView.
- Agent-created card text is untrusted for prompts: `dispatch` wraps it as
  data with an explicit boundary (`cardPrompt`), never as instructions.
- All reads/writes are owner-scoped; settle matches `taskId` within the owner
  only.
- No model calls, no new dependencies, no CopilotKit cloud dependency.
