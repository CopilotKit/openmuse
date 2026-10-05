# Sync layer — decisions

Settled 2026-10-04. These are decided; do not re-open without a reason.

## The model: Telegram's

The reference is how Telegram handles one account on several devices. It does **not**
copy state between devices. It keeps an authoritative ordered log on the server and
gives each client a **cursor** into it. A device's local state is a rebuildable
projection of that log, disposable at any time.

Applied here:

- The server holds an append-only `changes` log with a monotonic `seq` per owner.
- A device stores the `seq` it has seen. Pull is `GET /sync?since=<seq>`.
- Device state is a cache. If it is lost, rebuild by pulling from `seq=0`.
- Nothing syncs *messages* or *tasks* directly. Both are derived from the log.

Why this rather than a CRDT or an operation log: single user, so conflicts are rare
and bounded, and a log is far easier to reason about than a merge type.

## Execution: the device pulls work

The device runs the agent loop and polls for tasks it can run. The server is a control
plane; it does not proxy tool calls to a device. This keeps device control local —
the phone controls the phone — which is the stated requirement.

A device may run a local LLM or an API model. The choice is per-device configuration,
not per-task.

**Shipped (server side, 2026-10-04).** Three endpoints make the pull real:

| Endpoint | Purpose |
|---|---|
| `POST /api/agent/device/claim` | Take the next eligible task. Returns `{task, lease}` or `{task: null, reason: "no-eligible-work"}`. |
| `POST /api/agent/device/heartbeat` | Extend the lease this device holds. |
| `POST /api/agent/device/report` | Close the task with `succeeded`/`failed` and a result. |

A claim is a **lease, not a status flip**, and that distinction is the whole design:

- The claim is a compare-and-swap on the task's prior status, so two devices racing
  for one task produce exactly one winner. The loser is told there is nothing rather
  than handed work another device already holds.
- Leases expire, and an expired lease **recovers** the task to `queued`. Without that,
  a phone that loses network mid-task leaves work `running` forever: every other
  device declines a dead lease, so the work is **lost, not delayed**. Recovery runs
  before each claim.
- The lease id is the **bearer capability** — CSPRNG-generated, returned only to the
  winner, and never sent to the server again by anyone else. Heartbeat and report
  match on it, so there is deliberately no second factor: possession of the lease is
  possession of the task.
- A malformed lease timestamp reads as **dead**, never live. Failing the other way
  would strand a task permanently behind an unparseable date.

Selection (`packages/domain/src/device-work.ts`) is deterministic by task id, so two
devices agree on which task is first and work does not migrate between identically
capable machines on clock skew. The `deviceId` on a task is a *preference*, not an
entitlement: work never sits idle waiting for a creator that is unpaired or gone.

### The client half (shipped 2026-10-04)

`apps/mobile/src/device-agent-loop.ts` holds the device side: claim, heartbeat, run,
report. The transport, executor, clock and timers are all injected, so the state
machine is tested with a hand-driven clock rather than a simulator — the behaviour
worth testing here is all timing.

The rules it enforces, and why each is a rule rather than a detail:

- **One task at a time.** A device-local role needs the screen, the files and the
  user's attention. Two concurrent runs on one phone is not more throughput, it is
  two half-attentions.
- **A lost lease aborts the work, not just the reporting.** `heartbeat` resolving
  `ok: false` means the server has handed the task to someone else. The executor is
  aborted and **nothing is reported**: a late report would overwrite the result of
  whoever took over.
- **A refused report is not a failed task.** The report is a CAS on a lease that may
  already have lapsed, and the server answers `409` in exactly that case. It is a
  clean handover, so it is neither counted as a completion nor shown as an error.
- **A network error does not abandon live work.** A failed heartbeat is not proof the
  lease is gone, so the beat is retried on the same schedule. Stopping the heartbeat
  on the first socket error is precisely the failure that loses the task.
- **The heartbeat interval is derived from the expiry the server last granted**, not
  from a constant and not from the window the claim returned. Measuring against the
  original window would shorten the interval on every pass, because that window only
  ever shrinks.
- **Backgrounding stops claiming, not the run in hand.** Work this device started keeps
  running and keeps heartbeating; only new claims wait for the app to come back.

The loop is **off until the user turns it on** (`Apps → This device`). A phone that
started claiming tasks the moment the app opened would drain the queue for a user who
never asked.

A device-claimed task runs through **the same agent the chat screen uses**, in its own
thread. That is deliberate: if device work ran some other way, "resumable on another
device" would be a claim about a second private executor rather than about the agent.

Evidence: `apps/mobile/test/device-agent-loop.test.ts` (11 tests, fake clock) and
`tests/device-loop-e2e.test.ts` (the same client code against a real `createApp`, so
the paths, payload shapes, pairing gate, lease CAS and the `409` are all proven to
agree). `scripts/mutation-device-loop.sh` removes each control in turn and requires
the suite to fail.

### Pairing, from the user's side (shipped 2026-10-04)

The protocol was asymmetric and unusable: a device may not pair itself, so a code is
minted on a machine already in the operator's hands and typed into the new one — but
only the server half existed, so an unpaired phone was told to pair and then given
nothing to do about it.

Two things made it work:

- **`GET /api/agent/devices` now reports `paired` per device.** Without it the
  approving device has no way to know *which* device is waiting, and
  `POST /pairing/request` needs a `deviceId` — so it would have to know a UUID the
  phone never displays. This is the change that makes approval possible at all, and
  it is a read, not a gate: an unpaired device may still list them.
- **The Apps card renders both halves.** An unpaired device gets a code field; a
  paired one is told what is waiting and can mint a code for it. The minted code is
  shown once and not persisted, because the server stores only a hash — that response
  is the sole chance to read it aloud.

Three decisions in that flow, each avoiding an action whose only outcome is an error:

- The work-loop toggle is **not offered while unpaired**. Claiming is behind the
  pairing gate, so every press would fail.
- An unpaired device is never offered approval, and a paired device is never offered
  itself as a target (`/pairing/request` answers 409 for that).
- A **stale** unpaired device is not offered either: it is most likely a switched-off
  phone, and telling the operator to approve something that will not respond wastes a
  five-minute OTP.

The code field submits only at the OTP length. The attempt budget is five, so sending
a half-typed code to learn it was too short would spend a real attempt on a typo.
Spaces and dashes are stripped, because a code read aloud is often typed with one.

Still not built: background continuation when the app is **killed** (only backgrounding
is handled), and on-device model execution.

## Placement: a running task stays put

If a task is running on a device, it **continues on that device**. Handoff is never
implicit mid-run.

A **new step** is placed by configuration: on the device, or on the server. Placement
is decided at step boundaries only, because that is the only point where the execution
state is serialised and no work is in flight.

This is why the capability contract matters: the server cannot choose a device for a
step without knowing what that device can actually do.

## Conflict resolution: last write wins, by the server's clock

You will not be on two devices at once while offline, so concurrent divergence is a
corner case. LWW is sufficient and honest.

Two details that make LWW safe rather than merely simple:

- **The server stamps the time.** Devices never supply an authoritative timestamp. A
  client with a skewed or malicious clock cannot rewrite history by claiming a later
  `updatedAt`.
- **A late push never wins over newer server state** simply by arriving later. Arrival
  order is not write order; `updated_at` on the server row is.

Consequence to accept: offline edits made on two devices genuinely cannot both survive.
That is the deal, and it is the right one at this scale.

## Trust: a device must be paired before it executes

Deferring to my judgement, as offered. A paired device may **claim and execute
tasks**. An unpaired device may only read.

Rationale: claiming a task means running tools on a machine with the user's files,
logins and screen. That is a materially different grant from reading a board. If the
phone is stolen or a session token leaks, read access is a disclosure problem;
execute access is an action problem.

The pairing gate is cntrl's `desktop/lib/pairing-gate.ts` (OTP, 5-minute TTL, 5
attempts). Lift that rather than writing a new one.

This also keeps a **role** distinct from a **device**: a role says what work it wants
done, a device says what it can do here, and pairing says whether it is trusted to
act at all.

**Shipped (2026-10-04)** as `packages/domain/src/pairing.ts`. The lifted state machine
is intact; the server-specific adaptation adds three rules the lift did not have:

- **A device cannot pair itself.** Minting a code requires an already-paired caller,
  so approval authority never sits with the device asking to be approved.
- **The first device bootstraps with the account access key**
  (`POST /pairing/bootstrap`), and only the first — after that it returns 409.
  Otherwise holding the access key would silently add devices forever, and the OTP
  path would be optional. `Auth.verifyAccessKey` is deliberately separate from
  `Auth.session`: this checks a key without minting another session for it.
- **`deviceId` always comes from the session, never the request body**, so one device
  cannot redeem a code minted for another.

Pairing is **account-wide**, which is a real constraint on tests: a suite sharing one
owner can bootstrap exactly one device, and later devices must redeem a code the
first one minted.

The gate covers **every write** in the device loop, not just claiming — an unpaired
device may not heartbeat or report either. A gate on `/device/claim` alone would still
let an unpaired device keep a lease alive and close a task it was never allowed to
start.

## Devices: a phone never takes destructive work

Decided 2026-10-04. A task requiring `destructive` (send, delete, pay) is **never**
claimed by a handheld — a phone or tablet — *even when the device advertises the
capability*.

Rationale: the approval gate is the only thing between an irreversible action and the
world, and the realistic failure is a phone left face up on a desk. "The user approved
this earlier" does not survive the task being queued, migrated, and run minutes later
on a device they are not looking at. One thumb on an unattended phone is a far weaker
consent check than one click on a laptop the user is sitting at.

This is why **form factor is a field on the device, not a capability**. A phone that
declares `screen` is still a phone; a client that can claim a capability can also claim
a form factor, and only one of those two claims is worth believing. So the restriction
follows the device.

Enforcement lives in one function, `formFactorAllows` in
`packages/domain/src/capabilities.ts`, applied at all three decision points —
`claimEligibility`, `selectDeviceForTask`, and `checkMigration`. It has to be in the
capability contract rather than in each route, because a rule applied per-route is one
omission away from not existing. (`runnable-on` consults `checkMigration` too; without
it the UI would keep offering a phone for work it can never claim.)

The whole rule fails **closed**:

- An undeclared form factor is `handheld`. Rows written before the column existed
  cannot claim destructive work by omission.
- An unrecognised form factor degrades to `handheld` rather than being rejected. A 422
  would be friendlier, but the route is the only caller, so validating there would
  leave the normalisation in `Store.registerDevice` as dead code — asserted directly
  at the store layer instead.
- The refusal **outranks the capability gap** in the reported reason: a phone that is
  missing nothing must never be told it lacks something, or the operator chases the
  wrong problem.

Note the boundary: the form-factor rule *removes* a restriction, it never grants a
capability. A desktop still has to offer `destructive` to take destructive work.

## Platform: Android primary, iOS deferred

Decided 2026-10-04. **Android is the primary target; iOS is a deferred sprint.**

This settles the background-execution question that motivated it. A phone agent
loop cannot rely on a suspended iOS app, so "foreground-only" was the honest
constraint — on Android the same constraint is much weaker (foreground services
and a background service survive suspension), so execution can be continuous
rather than only while the app is open.

Deferred means deferred: do not add iOS-specific workarounds, and do not let an
iOS constraint drive a design decision.

**Refined 2026-10-04.** The execution model is now explicit, and it is narrower than
"continuous":

- **Foreground while the app is open.** The agent loop claims and runs work whenever
  the app is in the foreground. This is the default and the only guaranteed path.
- **Background only for work the user started on that device.** A task the user
  explicitly launches on a phone may continue while the app is backgrounded.

What this buys, stated honestly: the lease and heartbeat protocol already tolerate a
device going away — an expired lease requeues the task rather than stranding it — so
background execution is an *optimisation*, never a correctness requirement. There is no
work that can only ever be done on a device that will be backgrounded, and nothing in
the server assumes a device stays awake. A phone that is suspended mid-task simply
loses its lease and the task returns to the queue for another device.

## On-device AI: `meaty` is the reference, not yet a provider

`Wiltermoodj/meaty` is the model for on-device AI and is in this ecosystem.
**Revised 2026-10-04: the endpoint this section hoped for now exists.**
`meaty` @ `3e95e5ac` ships `src/services/localAiServer.ts` — `GET /health`,
`GET /v1/models`, `POST /v1/chat/completions` with SSE, plus audio, vision and
embeddings — behind a bearer token and `X-Ecosystem-App` / `X-Priority` headers.
It is a native daemon (Kotlin `NanoHTTPD`, Swift `NWListener`) bridged into JS,
so its listener is invisible to a grep of `src/`.

**It does not serve tool-calling.** `chatCompletionHandler.ts` reads `body.stream`
and nothing else — no `tools`, no `tool_choice` — and streams only
`delta: { content }`. Meaty has a tool loop for its own UI, not reachable over
HTTP. Since OpenMuse's agent *is* a tool loop, this is a second blocker
independent of reachability.

**The open problem is reachability, and it is ours, not meaty's.** The daemon
binds `127.0.0.1` only on both platforms, on port `11435`. OpenMuse runs every
inference in `apps/server`, on a machine that is not the phone — device work is a
client of the server API, never a local model call — so the phone's loopback
endpoint is unreachable from the process that needs it.

**Decided 2026-10-04: the phone proxies.** The server keeps orchestrating; the
phone relays to its own loopback endpoint, over a relay route rather than a
changed bind. The server then decides **per request** whether to route through the
phone, falling back to remote-then-API when the phone is asleep — never
unconditionally. And if meaty's endpoint gains tool-calling, it will use
**standard OpenAI semantics**: the caller's tools, `tool_calls` returned, executed
by the caller. Meaty will not expose its own device-touching registry to remote
callers.

The meaty-side tool-calling plan is written and proposed as
[PR #378](https://github.com/Wiltermoodj/meaty/pull/378) (`knowledge/planning/agent-tool-calling-local-ai-plan.md`,
written to apply to any consumer rather than to OpenMuse specifically). Nothing
is implemented yet, and nothing in OpenMuse should be built against it until it
lands.

This supersedes nothing above; it completes it. Sequencing, the consequences, what
meaty is and where it lives, and what the proposal needs:
[ON-DEVICE-INFERENCE.md](ON-DEVICE-INFERENCE.md).

Note how this claim got wrong twice: first "meaty hosts no listener at all"
(false — the sync subsystem binds a TCP port), then "meaty serves no inference
endpoint" (true of a checkout 286 commits stale, and the missing daemon was
native, so even a fresh `src/` grep would have missed it). **Full assessment,
the three architectures, nine open questions, and what already exists:
[ON-DEVICE-INFERENCE.md](ON-DEVICE-INFERENCE.md).**

So the served-LLM capability is a **thing to build**, not an integration to
configure. OpenMuse needs an OpenAI-compatible endpoint on the device.

**Where it lives: meaty hosts it, OpenMuse calls it.** Decided 2026-10-04. Meaty
already owns on-device inference (`llama.rn`/LiteRT/ExecuTorch) and the
OpenAI-compatible client plumbing, so hosting the endpoint there keeps the model
lifecycle and the server in one place instead of splitting them across two apps.

Consequence to be honest about: this creates a hard dependency on an external
repository, and OpenMuse cannot serve on-device inference until that work lands
there. OpenMuse should treat meaty as **optional** — when the endpoint is absent,
fall back per the model policy (remote LAN server, then API). Do not gate core
agent functionality on meaty being present or updated.

Contract OpenMuse needs from meaty: an OpenAI-compatible endpoint
(`/v1/chat/completions`, SSE) reachable over the LAN, advertised so a device can
discover it, with tool-calling support. `react-native-zeroconf` discovery and
`networkDiscovery.ts`'s gateway/Ollama probes are the existing patterns to follow.

## Model policy

Local when the device has a capable model, otherwise API, with a per-task
override. Matches the existing per-device model routing in
`agent-settings:device-models:{deviceId}`, which already establishes the pattern.

## Promotion from notes to tasks

The agent **suggests**; the user **confirms**. Not automatic. A note promoted
without asking is work the user never asked for, and on a single-user agent that
is the difference between a tool and a nuisance.

**Shipped 2026-10-04.** `packages/domain/src/note.ts` holds the rules (pure, no
I/O, like `board.ts`); `Note` is a record in `agent.ts` beside `Idea`.

Vision requirement 1 asks for notes and tasks in **one** store with deliberate
promotion, not two systems. That is literal here: a note is a row in the same
owner-scoped `records` table as a task, so it syncs and deletes through the
existing `changes` log with no new transport. Promotion is an ordinary
`createTask` call that also records where the note went.

Four decisions, each avoiding work the user did not ask for:

- **Saving a note starts nothing.** There is no path from `POST /notes` to the
  worker. Promotion is a separate, explicit request.
- **The promoted task id is derived from the note id**, so a repeated or
  concurrent promotion converges on one task. This is the note plane's version of
  the claim CAS, and it is why promotion is safe to retry from two devices.
- **The note is claimed before the task is created, and the task id is recorded
  after.** So exactly one caller wins, and a failure between the two leaves the
  note `open` for a retry rather than `promoted` pointing at work that does not
  exist.
- **A promoted note cannot be deleted** while its task is live (409). Deleting
  the note would not delete the task, so the board would keep a card whose origin
  the user can no longer see. Cancelling the task is the honest way to retire it.

`promotable` is resolved on the server and shipped to the client, so the phone
never offers a promotion the API would refuse — and the client does not keep a
second copy of the rule to drift.

**From chat too (2026-10-04).** Requirement 1 says *from any device*, and the
phone was the only place a note could be captured. `capture_note` is now a chat
tool, so a thought can be spoken in conversation and promoted on the device
later.

The tool's shape is the enforcement. It **captures and cannot promote**:
`promoteNote` is reachable only from the HTTP route, never from a tool, so the
agent can suggest and the user can confirm — the rule above, enforced by what
the model is offered rather than by asking it well. `delegate_task` remains the
tool that starts work; the distinction is which one the model picks, not that
one is hidden.

Captures are idempotent, because tool calls get replayed when a provider stream
drops: the tool passes a request-scoped key and `createNote` uses
`insertIfAbsent`. That is not only about duplicate rows — `put` appends a change
unconditionally, so a replay would announce a note that did not change and send
every device re-fetching it. A note-count assertion cannot catch that; only the
change log can, which is why `tests/conversation-notes.test.ts` counts changes.

Note `capture_note` had to be added to the default `CHAT_TOOL_ALLOWLIST` in
`docker-compose.yml` and `.env.example` — an allowlist that omits it means chat
can never capture anything on a default deployment, and nothing errors.

## Security lift order

SSRF guard and host-exec gate first: they protect execution paths that already
exist. Pairing comes with the device work it gates.

## Surface: chat-first, board stays a tab

Decided 2026-10-04. **Chat is the home surface** — it opens first and holds the
majority of the layout. The board remains a top-level tab rather than being
demoted or removed, because goal #4 (multiple specialist roles doing concurrent
work on a kanban) needs it visible.

Reconciling the two goals: chat is how you *direct* the work, the board is how you
*watch* it. Chat owns capture and conversation; the board owns state.

## What this does not solve

Stated plainly so it is not mistaken for more than it is:

- No **offline queueing of execution**. A task can be *recorded* offline; it will not
  run without a reachable server.
- No **multi-writer CRDT**. Divergent offline edits lose to the server copy.
- No **remote screen control**. Deliberate: cross-device control is ruled out.
- Handoff is **manual**, at step boundaries. Automatic migration would pay a cold
  model and a re-authenticated session on every device change for no benefit.