# OpenMuse on OpenBot Implementation Plan

> Superseded by the [single-context revision 3 plan](2026-10-12-openmuse-openbot-single-context-tickets-v3.md); retained for decision history.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Status:** proposed Ticket breakdown for user review. Do not publish child Issues or implement from this draft before the breakdown is approved. Each approved Ticket receives its own file-level writing plan before implementation.

**Goal:** Deliver the full existing OpenMuse experience for new multiuser data on OpenBot as the sole backend, with the existing OpenMuse repository as its frontend submodule.

**Architecture:** OpenBot owns identity, private Bots, Channels, Threads, Google access through OpenConnector, files, tasks, personal context, approvals, reviewed external actions, and computers. OpenMuse renders these capabilities on iOS, Android, and Web through one authenticated OpenBot transport. Vertical Tickets add complete user paths and reuse OpenBot's queue, headless runner, policy, and computer gateway.

**Tech Stack:** OpenMuse React Native/Expo/Web and pnpm; OpenBot TypeScript, Bun, PostgreSQL, Better Auth, CopilotKit, WorkQueue and computer gateway; OpenConnector for Google OAuth and provider actions.

**Spec:** [openmuse#1](https://github.com/1123786563/openmuse/issues/1), the OpenBot integration design dated 2026-10-12, OpenMuse `CONTEXT.md` and accepted ADRs 0004–0010. The design currently resides in the sibling OpenBot checkout and must be preserved with the execution records before work starts.

## Global Constraints

- OpenBot is the only business backend; no OpenMuse server, TaskWorker, OAuth store, or file store runs in the integrated deployment.
- The canonical frontend is the full existing OpenMuse repository, referenced as an OpenBot Git submodule; reconcile copied-client changes before removing the copy.
- First cutover preserves all named experiences for **new users and new data** on iOS, Android, and Web. Historical single-owner records are not migrated.
- Private OpenMuse Bots, computers, Google connections, files, tasks, and personal context must be isolated between users.
- OpenConnector is the Google provider path; OpenBot derives connection identity from the authenticated user and does not expose provider credentials.
- Gmail and Calendar external writes use exact Reviewed actions; computer Policy approvals remain distinct.
- The initial self-hosted capacity target is approximately 1–20 concurrently active users.
- Deletion stops access and work immediately, preserves recoverable data for 30 days, then purges it.
- Existing user edits in both checkouts are baselines to preserve. A submodule pin includes only committed OpenMuse content.

## Review Focus

1. Two users switch devices or sessions: private Bot, Google account, file URL, computer stream, and task data must never cross ownership boundaries. Pin this in Tickets 02, 05, 06, 09, and 13.
2. Google consent expires, is revoked, or changes account between proposal and execution: the UI must show disconnection or stale proposal; no write may execute under the wrong account. Pin this in Tickets 06, 11, and 12.
3. A provider times out after a send or calendar mutation: the Reviewed action must remain `outcome_unknown` until reconciled; no automatic replay. Pin this in Tickets 11 and 12.
4. A worker restarts while a task waits for input or approval, holds a lease, or schedules a monitor: state and deduplication must survive without duplicate external effects. Pin this in Tickets 14, 16, and 18.
5. Account deletion races with a running task, signed download, OAuth callback, or restoration: access must stop immediately and restoration must not resume a cancelled external write. Pin this in Ticket 21.

---

## Shared interfaces and execution rules

Each user-facing Ticket is a complete route from the relevant OpenMuse screen or Bot tool to an authenticated OpenBot domain contract, durable state, and user-visible result. Tests assert observable responses and persistent transitions, not internal call counts. The client sends no authoritative user ID. OpenBot resolves owner, private Bot, and connection from the session. Screens consume stable domain responses rather than OpenConnector action schemas.

The proposed domain contracts are: private Bot provisioning and template revision; Channel/Thread runtime; connected Google account; Mail; Calendar; user File/Artifact; Reviewed action; Task/Run/Step/Evidence; personal context; and Activity. Their exact request/response types and file ownership are fixed in the file-level plan for the first Ticket that produces each contract. Later Tickets consume those frozen types or explicitly version them.

For each Ticket, the implementer writes an observable failing behavior check, confirms it fails for the intended reason, implements the smallest complete path, checks the targeted behavior and relevant platform build, then records a reviewable checkpoint. Integration and independent review follow the global engineering rules before downstream Tickets start. No phase is accepted on a stub UI or mocked provider response alone.

## Proposed Ticket DAG

The numbers below are provisional Ticket IDs, not GitHub Issue numbers. A listed blocker is a genuine interface or data prerequisite; unrelated branches can progress independently after their common foundation. Story numbers refer to Spec #1.

### Ticket 01: Build the canonical OpenMuse frontend from a Git submodule

**Blocked by:** None. **Stories:** 41. **Owner:** source/build integration.

**Delivers:** An operator checks out OpenBot recursively and builds the existing OpenMuse client from its canonical repository. The copied client is reconciled and removed without losing useful adaptations.

**Interface and steps:** Record both repository baselines and compare the copied client with the current OpenMuse source; reconcile differences; pin a committed OpenMuse revision as a submodule; update dependency installation, CI and build entry points; prove the integrated runtime does not launch the old OpenMuse backend. Preserve unrelated local edits.

**Acceptance:** Recursive checkout builds Web and native client artifacts; the copied subtree is gone; a clean checkout reproduces the pin. **Evidence:** CI/build logs, submodule SHA, source reconciliation record.

### Ticket 02: Sign in and enter a private OpenMuse Bot

**Blocked by:** 01. **Stories:** 1–6, 9. **Owner:** identity and client session.

**Delivers:** A new user signs in, gets exactly one private Bot, reopens the app, and sees only that Bot on iOS, Android, and Web.

**Interface and steps:** Reuse Better Auth and OpenBot session guards; add idempotent first-entry provisioning; bind the private Bot to a distinct computer profile; replace old local-user/session bootstrap with one OpenBot transport; clear client caches and media on logout.

**Acceptance:** Two simultaneous users receive different Bots and computers; repeat entry creates no duplicates; invalid sessions and cross-user IDs fail; native and Web session restore works. **Evidence:** authenticated API checks and platform UI flows.

### Ticket 03: Roll out private Bot template revisions

**Blocked by:** 02. **Stories:** 7–8. **Owner:** Bot administration.

**Delivers:** An administrator updates common grants and security settings while a person's Bot description and preferences survive.

**Interface and steps:** Version the template, distinguish managed fields from user fields, preview changes, apply idempotent updates, and expose outcome to the administrator.

**Acceptance:** Existing Bots receive changed grants; user fields remain; rerunning the revision is harmless; unauthorized people cannot alter grants. **Evidence:** admin flow and persisted Bot comparison.

### Ticket 04: Converse through Channels and Threads

**Blocked by:** 02. **Stories:** 10–14. **Owner:** conversation and client runtime.

**Delivers:** A person creates and switches Channels, resumes Threads, receives streaming replies and tool cards, and can stop and reconnect without duplicate messages.

**Interface and steps:** Map Bot, Channel, runtime agent and Thread IDs explicitly; port baseline OpenMuse Bot behavior; replace fixed runtime identity; adapt existing screens and replay/stop handling to OpenBot's CopilotKit runtime.

**Acceptance:** Multiple Channels remain distinct across restart; rename/archive/replay work; stopped/reconnected runs show one coherent history and visible failures. **Evidence:** client flows and Channel/Thread contract checks.

### Ticket 05: View and control the private Bot computer

**Blocked by:** 02. **Stories:** 9, 38. **Owner:** computer and client stream.

**Delivers:** A person sees their own Bot computer and can take human control under OpenBot policy from the existing OpenMuse UI.

**Interface and steps:** Route snapshots, stream, input and workspace actions through authenticated OpenBot computer APIs; preserve Policy approval, audit and refusal states; bound per-Bot capacity.

**Acceptance:** Cross-user stream/input attempts fail; approved control works; refusal is visible; disconnected clients cannot keep sending input. **Evidence:** two-user computer flows and policy audit.

### Ticket 06: Connect an individual Google account through OpenConnector

**Blocked by:** 02. **Stories:** 15–16. **Owner:** connector and connected-account UI.

**Delivers:** A person authorizes Gmail and Calendar separately from OpenBot login, sees the account, reconnects, and disconnects it.

**Interface and steps:** Extend OpenBot's OpenConnector adapter for OAuth configuration, start, callback, status, refresh and revocation; derive a server-side per-user connection alias; expose a stable connection view to OpenMuse.

**Acceptance:** Two real Google test accounts stay isolated; callback, refresh, expiry and disconnect have visible states; neither client nor another user can select a foreign alias. **Evidence:** live consent flow and authenticated contract checks.

### Ticket 07: Read Gmail in OpenMuse

**Blocked by:** 06. **Stories:** 17. **Owner:** Mail domain and client.

**Delivers:** A person searches mail, opens a thread, and reads its attachments through their connected account.

**Interface and steps:** Map OpenConnector Gmail actions to stable Mail search/read/thread/attachment contracts; enforce owner, Bot grant and connection status; render loading, truncation and provider errors.

**Acceptance:** Real account data appears under the correct user; pagination or truncation is explicit; disconnect blocks subsequent reads. **Evidence:** two-account read flows.

### Ticket 08: Read Calendar in OpenMuse

**Blocked by:** 06. **Stories:** 18. **Owner:** Calendar domain and client.

**Delivers:** A person browses events from their own Google Calendar with correct date and time-zone display.

**Interface and steps:** Map OpenConnector Calendar actions to stable list/read contracts; preserve event IDs, time zones, all-day semantics and paging; render empty and provider-failure states.

**Acceptance:** Two users see only their calendars; all-day and cross-time-zone events display correctly; disconnect blocks reads. **Evidence:** live calendar accounts and platform views.

### Ticket 09: Keep a durable personal Files library

**Blocked by:** 02. **Stories:** 23. **Owner:** File domain and client.

**Delivers:** A person uploads, lists, opens and downloads a file beyond any one Channel or Craft session.

**Interface and steps:** Add user-owned file/artifact records, version identity, byte storage, authenticated content delivery and deletion state; connect the existing Files UI. Do not treat conversation attachments as the personal library.

**Acceptance:** Files survive restart and are visible across the user's Channels; rename and deletion update the library; another user cannot list or fetch bytes, including by a previously issued URL. **Evidence:** upload/read/download/manage and isolation checks.

### Ticket 10: Inspect, fill and view PDF copies

**Blocked by:** 09. **Stories:** 25–27. **Owner:** document domain and client viewer.

**Delivers:** A person inspects a PDF's fillable fields, enters values, and views a new filled copy beside the unchanged original on Web and mobile.

**Interface and steps:** Port field inspection, unsupported-field reporting and deterministic fill-copy production into OpenBot; store derived version and workspace transfer reference; keep the client as viewer and form.

**Acceptance:** Supported fields fill correctly; unsupported fields are reported; original hash stays unchanged; derived copy is authorized and viewable on every client. **Evidence:** representative PDFs and version records.

### Ticket 11: Send a reviewed Gmail change

**Blocked by:** 07. **Stories:** 19, 21. **Owner:** Reviewed action and Mail.

**Delivers:** A person sees an exact proposed email or reply, approves or denies it, and receives a trustworthy receipt.

**Interface and steps:** Establish the shared Reviewed action state model; bind proposal hash, recipient, content, account, connection generation, expiry and target; atomically claim approval; execute once through OpenConnector; reconcile `outcome_unknown` without automatic retry.

**Acceptance:** Approval sends once; denial/expiry/change blocks send; concurrent approvals claim once; provider timeout leaves an uncertain state, not a replay. **Evidence:** live test account and fault-injected provider outcomes.

### Ticket 12: Review Calendar mutations

**Blocked by:** 08, 11. **Stories:** 20–21. **Owner:** Reviewed action and Calendar.

**Delivers:** A person reviews exact event create, update and delete proposals before Calendar changes occur.

**Interface and steps:** Reuse the Reviewed action lifecycle; bind event version, calendar, time zone and account; execute provider action once; present receipt or uncertainty.

**Acceptance:** Changed or deleted target invalidates a proposal; create/update/delete honor approval and denial; timeout never causes blind replay. **Evidence:** real calendar workflows and stale-target checks.

### Ticket 13: Run a one-off agent Task in the background

**Blocked by:** 04, 05. **Stories:** 28. **Owner:** Task domain and client.

**Delivers:** A person starts an agent Task, closes the client, and later sees steps, run events, typed evidence and a result.

**Interface and steps:** Create a dedicated Task/Run/Step store and stable API; bind owner and private Bot; reuse WorkQueue and headless runner; expose task list and detail in OpenMuse.

**Acceptance:** Work continues after client exit; run evidence and failure are durable; another user cannot read or execute the task; computer actions use the private Bot gateway. **Evidence:** offline run and two-user checks.

### Ticket 14: Control and recover Tasks

**Blocked by:** 13. **Stories:** 33–34. **Owner:** Task lifecycle.

**Delivers:** A person pauses, resumes, cancels or retries eligible work; waits for input or review remain actionable after restart.

**Interface and steps:** Define legal transitions, lease and retry ownership, waiting payloads and resume token; connect controls to the UI; recover leases and pending waits after worker restart.

**Acceptance:** Illegal transitions refuse clearly; cancellation stops new work; restart does not lose or duplicate a waiting step; retries preserve prior evidence. **Evidence:** persisted-state and restart flows.

### Ticket 15: Execute a visible Plan Task

**Blocked by:** 13. **Stories:** 31. **Owner:** Task planning.

**Delivers:** A person starts a multi-step plan and sees each step's status, evidence and final outcome.

**Interface and steps:** Reuse Task/Run/Step contracts for ordered or dependent plan steps; persist progress and failures; render plan details in OpenMuse.

**Acceptance:** Steps resume from durable state and do not repeat completed external effects after restart; failed steps show cause. **Evidence:** a real multi-step plan flow.

### Ticket 16: Run a deduplicated Monitor and notify its owner

**Blocked by:** 13. **Stories:** 32, 35, 37. **Owner:** Task monitoring and notifications.

**Delivers:** A person creates a recurring monitor, sees observations and receives a notification when its condition changes. Task status notifications from all task kinds also have per-user read state.

**Interface and steps:** Persist schedule, condition, cursor, deduplication key and backoff; run through the existing queue; store per-user notifications and read state; render monitor and notification result.

**Acceptance:** Restart preserves cursor; repeated observations do not spam; failures back off; all task kinds emit applicable status notifications; owner can read and mark only own notifications. **Evidence:** clock-controlled monitor and client notification flow.

### Ticket 17: Produce a finance Task artifact

**Blocked by:** 09, 13. **Stories:** 30. **Owner:** finance Task.

**Delivers:** A person uploads a spending CSV, starts a finance Task, and gets a saved tracker or summary artifact.

**Interface and steps:** Port CSV validation and calculation to OpenBot; run through Task lifecycle; store output in Files with task reference; render invalid-row diagnostics and result.

**Acceptance:** Invalid CSV is rejected with usable errors; valid inputs yield reproducible totals; artifact survives restart and is private. **Evidence:** known-result CSVs and UI flow.

### Ticket 18: Complete a document Task from mail to reviewed reply

**Blocked by:** 07, 10, 11, 14. **Stories:** 24, 29. **Owner:** document Task.

**Delivers:** A person selects a mail PDF attachment, fills a copy with Bot help, supplies missing values, reviews a reply and reaches a recorded outcome.

**Interface and steps:** Import attachment into user Files; inspect fields; create task waits for missing data; fill a copy; prepare a Reviewed action for the reply; execute once and link receipt and artifacts to the Task.

**Acceptance:** Client can close during waits; denial keeps artifacts without sending; uncertain send is not retried; complete workflow is recoverable after restart. **Evidence:** real mail/PDF flow with restart and denial cases.

### Ticket 19: Use private Goals, Ideas and memories

**Blocked by:** 02, 04. **Stories:** 36. **Owner:** personal context and Bot tools.

**Delivers:** A person creates and views Goals and Ideas; their private Bot can use them and private memories in conversation.

**Interface and steps:** Port durable ownership and UI contracts to OpenBot; grant tools only to the private OpenMuse Bot; preserve creation/update/delete and task references; expose clear permission failures.

**Acceptance:** Person and private Bot see their own context; another user and another Bot cannot; data survives restart. **Evidence:** cross-Bot and cross-user conversation/UI checks.

### Ticket 20: Unify Activity without merging decision rules

**Blocked by:** 11, 12, 16. **Stories:** 22, 37. **Owner:** Activity and client.

**Delivers:** A person sees Policy approvals, Reviewed actions and task notifications in one ordered Activity view and can act on each correctly.

**Interface and steps:** Add a typed OpenBot Activity read contract; render source, decision details and read state; route each decision to its owning module; keep notification read state independent.

**Acceptance:** Mixed Activity remains ordered and private; a Policy approval cannot execute a Reviewed action and vice versa; stale decisions show their actual state. **Evidence:** mixed-event UI and contract checks.

### Ticket 21: Delete and recover a user with bounded retention

**Blocked by:** 03, 06, 10, 14, 15, 16, 17, 18, 19, 20. **Stories:** 39–40. **Owner:** account lifecycle.

**Delivers:** Account deletion immediately stops sessions, Bot, Tasks and Google access, permits administrator restoration for 30 days, then cleans personal data.

**Interface and steps:** Create a durable deletion record; revoke sessions and connection, disable Bot and queue work, invalidate file access, and schedule retryable cleanup of domain stores and backups; restoration does not resume cancelled external writes.

**Acceptance:** Deletion races cannot reopen access; recovery within 30 days restores permissible data; after expiry purge is complete or visibly retrying; a second user's data remains untouched. **Evidence:** deletion/recovery clock and fault flows.

### Ticket 22: Cut over and prove full three-platform parity

**Blocked by:** 03, 05, 07, 08, 10, 12, 14, 15, 16, 17, 18, 19, 20, 21. **Stories:** 1–43. **Owner:** release integration.

**Delivers:** An operator deploys one OpenBot backend and the OpenMuse client, and two users complete all accepted experiences on iOS, Android and Web.

**Interface and steps:** Build from a committed submodule pin; provision PostgreSQL, OpenConnector and bounded computers; wire OAuth callback and secrets; run full two-user live acceptance; document roll-forward and rollback that does not replay uncertain writes.

**Acceptance:** All named screens and Task kinds use OpenBot durable state; no OpenMuse server or TaskWorker runs; isolation and recovery pass; CI/build and platform checks pass; remaining deviations are recorded rather than called parity. **Evidence:** release manifest, platform matrix, live Google receipts and acceptance record.

## Coverage and next planning layer

Every Spec #1 story appears in at least one proposed Ticket; Ticket 22 aggregates release acceptance and does not reimplement child behavior. Ticket 01 is a narrow, independently verifiable source/build slice rather than a broad client rewrite. Tickets 11 and 12 deliberately sequence Calendar writes after the first complete Reviewed action path, so the shared decision contract is exercised before reuse.

After the user approves this breakdown, publish one GitHub Issue per Ticket in dependency order, link each to parent Spec #1, and create native blocking links where GitHub supports them. Before implementing each Issue, produce its own file-level writing plan with exact owned files, signatures, failing behavior checks, commands and expected results. That plan is the executable unit; this document is the program-level DAG and acceptance map.
