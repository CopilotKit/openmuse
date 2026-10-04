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

## What this does not solve

Stated plainly so it is not mistaken for more than it is:

- No **offline queueing of execution**. A task can be *recorded* offline; it will not
  run without a reachable server.
- No **multi-writer CRDT**. Divergent offline edits lose to the server copy.
- No **remote screen control**. Deliberate: cross-device control is ruled out.
- Handoff is **manual**, at step boundaries. Automatic migration would pay a cold
  model and a re-authenticated session on every device change for no benefit.