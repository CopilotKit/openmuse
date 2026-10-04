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

## Platform: Android primary, iOS deferred

Decided 2026-10-04. **Android is the primary target; iOS is a deferred sprint.**

This settles the background-execution question that motivated it. A phone agent
loop cannot rely on a suspended iOS app, so "foreground-only" was the honest
constraint — on Android the same constraint is much weaker (foreground services
and a background service survive suspension), so execution can be continuous
rather than only while the app is open.

Deferred means deferred: do not add iOS-specific workarounds, and do not let an
iOS constraint drive a design decision.

## On-device AI: `meaty` is the reference, not yet a provider

`Wiltermoodj/meaty` is the model for on-device AI and is in this ecosystem, so
OpenMuse can eventually rely on it as its served LLM. **Verified current state: it
does not host an inference endpoint.** It *consumes* OpenAI-compatible servers
(Ollama, LM Studio, LocalAI) via `OpenAICompatibleProvider`, discovers them over
the LAN, and runs on-device models in-process through `llama.rn`/LiteRT. There is
no `.listen()` in its `src/`, so nothing outside the app can call its inference.

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