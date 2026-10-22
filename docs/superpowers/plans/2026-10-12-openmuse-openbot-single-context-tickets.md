# OpenMuse on OpenBot Implementation Plan — single-context tickets

> Superseded by [revision 3](2026-10-12-openmuse-openbot-single-context-tickets-v3.md); retained for decision history.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Status:** revised draft for user approval. Ticket IDs below are provisional and are not GitHub Issue numbers. No Ticket is published or implemented by this document.

**Goal:** Make OpenMuse a three-platform frontend for OpenBot, preserving the existing product behavior for new multiuser data.

**Architecture:** OpenBot owns all business state and execution. OpenMuse is the canonical frontend repository mounted as an OpenBot Git submodule. OpenConnector owns Google provider credentials and actions; OpenBot exposes stable user-scoped Mail and Calendar contracts. Each ticket traverses the relevant UI or Bot tool, authenticated domain interface, persistence or provider, and visible result.

**Tech Stack:** Expo/React Native/Web and pnpm in OpenMuse; Bun/TypeScript, Hono, Better Auth, CopilotKit, PostgreSQL, WorkQueue and computer gateway in OpenBot; OpenConnector for Google OAuth and actions.

**Spec:** [openmuse#1](https://github.com/1123786563/openmuse/issues/1); OpenMuse `CONTEXT.md` and accepted ADRs 0004–0010; the 2026-10-12 integration design in the sibling OpenBot checkout.

## Global Constraints

- One Code Agent owns one ticket in one fresh context. A ticket has one primary behavior and its own focused verification; if investigation shows broader work, split it before implementation.
- Every user-facing ticket includes its narrow end-to-end path: OpenMuse screen or Bot tool → authenticated OpenBot contract → durable state or real connector → user-visible result. Existing shared React Native components serve Web/iOS/Android unless a platform-specific ticket says otherwise.
- OpenBot is the only business backend. The old OpenMuse server and TaskWorker are never deployed for acceptance. No legacy single-owner records or tokens are migrated.
- OpenBot derives user ownership from the session. Private Bot, computer, Google connection, Files, Tasks, Goals, Ideas and Memory cannot cross users. Personal tools are granted only to the private OpenMuse Bot.
- OpenConnector is the only Google connector path. Gmail and Calendar external writes use exact Reviewed actions; computer Policy approvals remain separate.
- The release targets approximately 1–20 concurrent active users. Two people with distinct real Google test accounts complete Web, iOS and Android acceptance.
- Account deletion stops access and work immediately, allows 30-day recovery, then purges. A provider outcome marked uncertain is never retried automatically.
- Each issue records its acceptance evidence and a reviewable checkpoint. Source layout or cross-repo changes require a committed OpenMuse revision before an OpenBot submodule pin can include them.

## Review Focus

- Expired native sessions and logout: no stale cached personal data or media URLs remain available; tickets 04–05 pin this.
- Concurrent first entry and changed Bot template: exactly one private Bot is created and managed fields update without overwriting user fields; tickets 03 and 06 pin this.
- Foreign user IDs, file IDs, connection aliases and computer stream URLs: OpenBot refuses them even if the client fabricates a request; tickets 03, 12, 14, 20–21 and 29 pin this.
- Google account or target changes after proposal, concurrent approval, and provider timeout: stale actions refuse and uncertain outcomes do not replay; tickets 25–28 pin this.
- Worker death during a lease, monitor observation, human wait or account deletion: durable state resumes safely and no external change is repeated; tickets 32–33, 36 and 46–48 pin this.

---

## Sizing and dependency rules

A ticket is complete when a fresh Code Agent can implement the stated behavior, run the focused check, and hand over a reviewable diff without opening another ticket's unfinished interface. It should normally touch one primary domain module and one client surface; shared schema or API edits are included only when required for that same path. The later platform acceptance tickets verify shared behavior and create new defect tickets if they expose work larger than a local fix.

`Blocked by` means a required interface or persisted state from the blocker must be integrated and reviewed. A ticket with no blocker may start immediately. IDs are topologically ordered; containment under Spec #1 is not a dependency. GitHub Issues will use native dependency links where available, with an explicit `Blocked by` list in each body as a readable fallback.

Every ticket below includes a user-visible delivery, direct blockers, Spec #1 story numbers, acceptance conditions, and the smallest verification evidence expected. The exact owned files, signatures and RED/GREEN commands belong in that ticket's file-level writing plan before implementation.

## Proposed tickets

### Ticket 01: Build the canonical Web client from a submodule

**Blocked by:** None. **Spec stories:** 41.

**What it delivers:** A clean OpenBot checkout builds the OpenMuse Web client from the canonical repository.

**Acceptance criteria:**
- [ ] Recursive checkout pins a committed OpenMuse revision
- [ ] Web install/build uses the submodule
- [ ] no copied client is used by the Web build.

**Verification:** Clean-checkout build log plus recorded submodule SHA.

### Ticket 02: Build native clients and retire the copied tree

**Blocked by:** 01. **Spec stories:** 41.

**What it delivers:** An operator builds iOS and Android bundles from the same submodule and has one frontend source.

**Acceptance criteria:**
- [ ] Compare and carry over useful copied-client adaptations before deletion
- [ ] native bundle commands use the submodule
- [ ] copied subtree is removed without losing source behavior.

**Verification:** iOS/Android bundle logs and reconciliation checklist.

### Ticket 03: Open a private Bot from Web login

**Blocked by:** 01. **Spec stories:** 1, 3, 6, 9.

**What it delivers:** A Web user signs in and enters an automatically provisioned private OpenMuse Bot.

**Acceptance criteria:**
- [ ] Concurrent first entries create exactly one Bot per user
- [ ] the two Bots have different computer profiles
- [ ] a foreign Bot ID is refused
- [ ] logout removes the Web session view.

**Verification:** Two-user authenticated Web/API flow and provisioning concurrency check.

### Ticket 04: Restore and clear an iOS session

**Blocked by:** 02, 03. **Spec stories:** 2, 4, 5.

**What it delivers:** An iOS user returns to their own Bot after app restart and loses private cache on logout.

**Acceptance criteria:**
- [ ] Native login returns to the same Bot
- [ ] expired session asks for login
- [ ] logout clears conversation cache, media access and credentials.

**Verification:** iOS simulator/device restart, expiry and logout flow.

### Ticket 05: Restore and clear an Android session

**Blocked by:** 02, 03. **Spec stories:** 2, 4, 5.

**What it delivers:** An Android user returns to their own Bot after app restart and loses private cache on logout.

**Acceptance criteria:**
- [ ] Native login returns to the same Bot
- [ ] expired session asks for login
- [ ] logout clears conversation cache, media access and credentials.

**Verification:** Android emulator/device restart, expiry and logout flow.

### Ticket 06: Roll out a private Bot template revision

**Blocked by:** 03. **Spec stories:** 7–8.

**What it delivers:** An administrator changes common grants while users keep their own Bot descriptions and preferences.

**Acceptance criteria:**
- [ ] Preview distinguishes managed and user fields
- [ ] applying twice is idempotent
- [ ] existing Bots receive new grants
- [ ] non-admin changes are refused.

**Verification:** Admin flow with two existing Bots and persisted-field comparison.

### Ticket 07: Send and receive one Channel conversation

**Blocked by:** 03. **Spec stories:** 10–12, 14.

**What it delivers:** A person opens a Channel with their private Bot, sends a message and receives a streamed answer.

**Acceptance criteria:**
- [ ] OpenBot returns explicit Bot/Channel/Thread IDs
- [ ] history survives reload
- [ ] baseline Bot behavior comes from OpenBot rather than the old OpenMuse server.

**Verification:** Authenticated client conversation and stored Thread check.

### Ticket 08: Manage multiple Channels

**Blocked by:** 07. **Spec stories:** 10–11.

**What it delivers:** A person creates, switches, renames and archives Channels without mixing Threads.

**Acceptance criteria:**
- [ ] Each Channel retains its own Thread
- [ ] archived Channel leaves active list but history remains accessible
- [ ] foreign Channel operations refuse.

**Verification:** Two-Channel UI flow and authorization checks.

### Ticket 09: Stop and reconnect a streamed run

**Blocked by:** 07. **Spec stories:** 12–13.

**What it delivers:** A person stops a reply or reconnects after network loss and sees one coherent conversation.

**Acceptance criteria:**
- [ ] Stop reaches the active OpenBot run
- [ ] reconnect replays existing events without duplicate messages
- [ ] a failed run shows its status.

**Verification:** Interrupted stream/reconnect behavior check.

### Ticket 10: Render tool cards and run failures

**Blocked by:** 09. **Spec stories:** 12, 14.

**What it delivers:** A person sees OpenMuse's rich tool cards and actionable failure states during Bot work.

**Acceptance criteria:**
- [ ] Known tool events map to existing cards
- [ ] unknown event has a safe readable fallback
- [ ] failed tool/run is not shown as success.

**Verification:** Representative tool-event fixtures and client rendering check.

### Ticket 11: Use shared chat behavior on native clients

**Blocked by:** 04, 05, 09, 10. **Spec stories:** 1–2, 10–14.

**What it delivers:** iOS and Android users can use the same Channel and Thread behavior as Web.

**Acceptance criteria:**
- [ ] Shared client state preserves Channel/Thread identity
- [ ] native stop/reconnect does not duplicate
- [ ] tool cards and errors remain readable on both platforms.

**Verification:** One native conversation/reconnect flow per platform.

### Ticket 12: View the private Bot computer

**Blocked by:** 03. **Spec stories:** 9, 38.

**What it delivers:** A person watches their own Bot computer from OpenMuse.

**Acceptance criteria:**
- [ ] Snapshot and live stream use OpenBot session authorization
- [ ] foreign Bot stream URLs refuse
- [ ] lost session closes the stream.

**Verification:** Two-user preview/stream isolation flow.

### Ticket 13: Take human control under computer policy

**Blocked by:** 12. **Spec stories:** 38.

**What it delivers:** A person takes and releases control of their Bot computer with visible policy decisions.

**Acceptance criteria:**
- [ ] Input is accepted only during authorized control
- [ ] policy refusal is shown
- [ ] control ends on logout or disconnect
- [ ] audit records the actor.

**Verification:** Control/refusal/reconnect flow and audit check.

### Ticket 14: Authorize Gmail through OpenConnector

**Blocked by:** 03. **Spec stories:** 15.

**What it delivers:** A person completes Gmail OAuth consent after OpenBot login and sees the connected account.

**Acceptance criteria:**
- [ ] OpenBot derives a user-specific connection alias
- [ ] callback binds to the initiating session
- [ ] tokens never reach the client
- [ ] a second user cannot select the alias.

**Verification:** Two real Google accounts and callback/foreign-alias checks.

### Ticket 15: Authorize Calendar and manage Google connection state

**Blocked by:** 14. **Spec stories:** 15–16.

**What it delivers:** A person grants Calendar access, sees connection status, refreshes an expired grant and disconnects.

**Acceptance criteria:**
- [ ] Gmail and Calendar grant status is explicit
- [ ] revoked/expired grants are visible
- [ ] disconnect prevents subsequent provider calls
- [ ] account identity stays user-scoped.

**Verification:** Real Calendar consent, refresh, revoke and reconnect flow.

### Ticket 16: Search and list Gmail messages

**Blocked by:** 15. **Spec stories:** 17.

**What it delivers:** A person searches their own Gmail and sees a paged or explicitly truncated result list.

**Acceptance criteria:**
- [ ] Query and pagination map to stable OpenBot Mail data
- [ ] disconnected accounts fail visibly
- [ ] another user cannot read the result.

**Verification:** Two-account search/list flow and contract check.

### Ticket 17: Read Gmail threads and attachments

**Blocked by:** 16. **Spec stories:** 17.

**What it delivers:** A person opens a mail thread and can inspect its attachment metadata.

**Acceptance criteria:**
- [ ] Thread order and message identity are preserved
- [ ] attachment access uses the current owner/connection
- [ ] provider errors do not expose another user's content.

**Verification:** Real thread with attachment and foreign-ID check.

### Ticket 18: Browse Calendar events

**Blocked by:** 15. **Spec stories:** 18.

**What it delivers:** A person views their own calendar and opens an event.

**Acceptance criteria:**
- [ ] Event IDs, calendar identity and paging are stable
- [ ] empty and disconnected states are visible
- [ ] another user cannot read an event by ID.

**Verification:** Two-account list/detail flow.

### Ticket 19: Show all-day and cross-time-zone events correctly

**Blocked by:** 18. **Spec stories:** 18.

**What it delivers:** A person sees Calendar dates and times correctly across local time zones.

**Acceptance criteria:**
- [ ] All-day events do not shift dates
- [ ] timed events preserve source zone and display local zone
- [ ] daylight-saving boundary is handled.

**Verification:** Known all-day/cross-zone event fixtures and platform view.

### Ticket 20: Upload and list personal Files

**Blocked by:** 03. **Spec stories:** 23.

**What it delivers:** A person uploads a file and sees it in a durable personal Files list.

**Acceptance criteria:**
- [ ] The record has owner, stable ID, MIME, size and hash
- [ ] it remains after restart and outside the originating Channel
- [ ] a foreign list request refuses.

**Verification:** Upload/list/restart two-user flow.

### Ticket 21: Open, download, rename and delete a File

**Blocked by:** 20. **Spec stories:** 23.

**What it delivers:** A person manages and downloads a private file from the Files page.

**Acceptance criteria:**
- [ ] Authenticated byte access enforces owner even with a copied URL
- [ ] rename persists
- [ ] deletion removes it from list and invalidates access
- [ ] version identity stays stable.

**Verification:** Download/rename/delete and foreign-URL check.

### Ticket 22: Inspect PDF fields

**Blocked by:** 21. **Spec stories:** 25.

**What it delivers:** A person opens a PDF and sees supported fields and unsupported-field reasons.

**Acceptance criteria:**
- [ ] Inspection runs on OpenBot
- [ ] malformed or encrypted PDF fails clearly
- [ ] original bytes remain unchanged
- [ ] field identity is stable for later fill.

**Verification:** Representative supported/unsupported/malformed PDF fixtures.

### Ticket 23: Fill and view a PDF copy

**Blocked by:** 22. **Spec stories:** 26–27.

**What it delivers:** A person submits values, receives a new PDF version and views it beside the original.

**Acceptance criteria:**
- [ ] Fill is deterministic for the same input
- [ ] missing/invalid values are reported
- [ ] original hash is unchanged
- [ ] Web/native viewers load authorized derived bytes.

**Verification:** Field-value fixture, hashes and three-platform viewer check.

### Ticket 24: Transfer a PDF artifact to the private workspace

**Blocked by:** 12, 23. **Spec stories:** 27.

**What it delivers:** A person moves an authorized PDF copy into their Bot computer workspace.

**Acceptance criteria:**
- [ ] OpenBot resolves the private computer
- [ ] only owner files transfer
- [ ] workspace result references the correct file version
- [ ] failures remain visible.

**Verification:** Two-user workspace transfer and copied-file check.

### Ticket 25: Approve and send an exact Gmail proposal

**Blocked by:** 17. **Spec stories:** 19, 21.

**What it delivers:** A person approves or denies an exact email/reply proposal and sees a receipt.

**Acceptance criteria:**
- [ ] Proposal binds recipients, content, account, connection generation and expiry
- [ ] approval claims once
- [ ] denial/expiry sends nothing
- [ ] receipt links the actual provider result.

**Verification:** Real test-account send and concurrent approval check.

### Ticket 26: Reconcile changed or uncertain Gmail sends

**Blocked by:** 25. **Spec stories:** 21.

**What it delivers:** A person sees stale or uncertain send outcomes without silent replay.

**Acceptance criteria:**
- [ ] Changed account/recipient/target invalidates proposal
- [ ] provider timeout after submission becomes outcome_unknown
- [ ] retry requires reconciliation rather than automatic resend.

**Verification:** Fault-injected timeout and changed-account checks.

### Ticket 27: Create a reviewed Calendar event

**Blocked by:** 19, 25. **Spec stories:** 20–21.

**What it delivers:** A person reviews and approves a new event before it appears in Calendar.

**Acceptance criteria:**
- [ ] Proposal binds calendar, account, time zone, attendees and details
- [ ] denial/expiry creates nothing
- [ ] approval creates once with receipt.

**Verification:** Real Google Calendar create/deny flow and concurrent approval check.

### Ticket 28: Review Calendar update and deletion

**Blocked by:** 27. **Spec stories:** 20–21.

**What it delivers:** A person reviews the exact change or deletion of an existing event.

**Acceptance criteria:**
- [ ] Proposal binds target event version
- [ ] changed/deleted target refuses
- [ ] uncertain provider response does not auto-repeat
- [ ] receipt reflects create/update/delete outcome.

**Verification:** Real update/delete and stale-target/timeout checks.

### Ticket 29: Start a one-off Task with the private Bot

**Blocked by:** 07, 12. **Spec stories:** 28.

**What it delivers:** A person starts an agent Task, closes the app and later sees its final state.

**Acceptance criteria:**
- [ ] OpenBot stores owner, Bot, Task and run identity
- [ ] headless runner uses the private Bot
- [ ] task continues with client closed
- [ ] foreign Task ID refuses.

**Verification:** Offline run and two-user authorization check.

### Ticket 30: Show Task steps and typed evidence

**Blocked by:** 29. **Spec stories:** 28.

**What it delivers:** A person opens Task detail and understands each step, event, artifact and failure.

**Acceptance criteria:**
- [ ] Step/run/evidence IDs remain stable across reload
- [ ] evidence types render distinctly
- [ ] a failed step has a visible cause and does not appear complete.

**Verification:** Task detail flow with success and failure runs.

### Ticket 31: Cancel, pause, resume and retry a Task

**Blocked by:** 30. **Spec stories:** 33.

**What it delivers:** A person controls an eligible Task from the UI.

**Acceptance criteria:**
- [ ] Only legal transitions appear
- [ ] cancellation prevents new work
- [ ] retry creates a new attempt while preserving prior evidence
- [ ] foreign actor cannot transition Task.

**Verification:** Transition matrix and client control flow.

### Ticket 32: Recover a Task after worker lease loss

**Blocked by:** 29. **Spec stories:** 34.

**What it delivers:** A person sees a Task continue or fail safely after a worker restart.

**Acceptance criteria:**
- [ ] Expired lease is reclaimed once
- [ ] completed step is not re-executed
- [ ] running step resumes from a durable checkpoint or records a clear failure.

**Verification:** Kill/restart worker at a controlled step and inspect durable run state.

### Ticket 33: Resume a Task waiting for human input

**Blocked by:** 30, 32. **Spec stories:** 34.

**What it delivers:** A person supplies missing task input after closing and reopening the app.

**Acceptance criteria:**
- [ ] Waiting payload and owner survive restart
- [ ] only the owner may answer
- [ ] answer is consumed once
- [ ] Task moves to the next state without duplicate execution.

**Verification:** Restart at wait state, submit once, repeat-submit refusal.

### Ticket 34: Run a multi-step Plan Task

**Blocked by:** 30, 32. **Spec stories:** 31.

**What it delivers:** A person sees a plan's ordered steps, outcomes and final result.

**Acceptance criteria:**
- [ ] Plan steps persist before execution
- [ ] completed steps are not repeated after restart
- [ ] failure identifies the step and retained evidence.

**Verification:** Three-step plan with controlled restart and failed step.

### Ticket 35: Schedule a recurring Monitor

**Blocked by:** 29. **Spec stories:** 32.

**What it delivers:** A person creates, views and stops a Monitor that performs periodic observations.

**Acceptance criteria:**
- [ ] Schedule, condition and owner persist
- [ ] next due time is visible
- [ ] stopping prevents future runs
- [ ] only private Bot tools execute it.

**Verification:** Clock-controlled due/stop flow.

### Ticket 36: Deduplicate Monitor observations and back off failures

**Blocked by:** 35, 32. **Spec stories:** 35.

**What it delivers:** A person receives only new Monitor outcomes and sees a recoverable failure state.

**Acceptance criteria:**
- [ ] Observation cursor survives restart
- [ ] same event is not emitted twice
- [ ] repeated failures back off
- [ ] recovery resumes from saved cursor.

**Verification:** Repeated observation/restart/failure schedule check.

### Ticket 37: Receive and mark Task notifications

**Blocked by:** 30. **Spec stories:** 37.

**What it delivers:** A person receives Task status notifications and marks them read.

**Acceptance criteria:**
- [ ] Each relevant Task state emits one owner-scoped notification
- [ ] unread count survives restart
- [ ] marking one user's item does not affect another.

**Verification:** Two-user notification/read-state flow.

### Ticket 38: Produce a finance Task from CSV

**Blocked by:** 21, 30. **Spec stories:** 30.

**What it delivers:** A person submits a spending CSV and receives a private summary artifact.

**Acceptance criteria:**
- [ ] Invalid rows report line and reason
- [ ] valid totals match known fixtures
- [ ] Task links the derived artifact
- [ ] restarting does not duplicate artifact.

**Verification:** Known-result CSV, malformed-row and artifact access checks.

### Ticket 39: Import a Gmail PDF attachment into Files

**Blocked by:** 17, 21. **Spec stories:** 24.

**What it delivers:** A person selects a mail PDF attachment and finds an owned File in the Files library.

**Acceptance criteria:**
- [ ] Import reads only the connected user's attachment
- [ ] MIME and hash are recorded
- [ ] duplicate retry does not create unrelated copies
- [ ] foreign attachment refuses.

**Verification:** Real test-message attachment and two-user import flow.

### Ticket 40: Fill a document Task after requesting missing values

**Blocked by:** 23, 33, 39. **Spec stories:** 29.

**What it delivers:** A person starts a document Task, supplies missing values and gets a filled PDF artifact.

**Acceptance criteria:**
- [ ] Task links original and derived versions
- [ ] wait survives restart
- [ ] unsupported fields are shown
- [ ] filling does not overwrite source.

**Verification:** PDF attachment task with missing-value/restart flow.

### Ticket 41: Send the document Task's reviewed reply

**Blocked by:** 26, 40. **Spec stories:** 29.

**What it delivers:** A person reviews a prepared reply with the filled PDF and reaches a recorded Task outcome.

**Acceptance criteria:**
- [ ] Reply proposal binds exact attachment version and account
- [ ] denial retains artifacts and sends nothing
- [ ] uncertainty does not auto-resend
- [ ] receipt links Task.

**Verification:** Real test-account approval/denial/timeout document flow.

### Ticket 42: Create Goals usable by the private Bot

**Blocked by:** 03, 07. **Spec stories:** 36.

**What it delivers:** A person creates and edits a Goal that their private Bot can reference.

**Acceptance criteria:**
- [ ] Goal is owner-scoped and durable
- [ ] private Bot tool can read it
- [ ] another user or Bot without grant cannot
- [ ] deleted Goal stops appearing.

**Verification:** Goal UI plus two-Bot conversation/permission flow.

### Ticket 43: Capture Ideas usable by the private Bot

**Blocked by:** 03, 07. **Spec stories:** 36.

**What it delivers:** A person captures, views and updates an Idea that their private Bot can use.

**Acceptance criteria:**
- [ ] Idea remains private and durable
- [ ] Bot can cite the correct Idea
- [ ] another user or ungranted Bot cannot read it.

**Verification:** Idea UI plus two-Bot permission flow.

### Ticket 44: Keep private Bot Memory isolated

**Blocked by:** 03, 07. **Spec stories:** 36.

**What it delivers:** A person sees useful private memory in later conversations without sharing it to another Bot.

**Acceptance criteria:**
- [ ] Memory write/read is scoped to user and private Bot
- [ ] revoke or delete removes access
- [ ] another Bot cannot retrieve it even for the same user without grant.

**Verification:** Two-Bot memory recall and isolation flow.

### Ticket 45: Show one typed Activity feed

**Blocked by:** 13, 25, 27, 37. **Spec stories:** 22, 37.

**What it delivers:** A person sees Policy approvals, Reviewed actions and Task notifications together and acts through the correct decision path.

**Acceptance criteria:**
- [ ] Feed items have type/source and stable ordering
- [ ] Policy approval cannot execute a Reviewed action
- [ ] stale items show their real state
- [ ] notification read state is independent.

**Verification:** Mixed-item Activity UI and wrong-decision-type refusal.

### Ticket 46: Stop access immediately when an account is deleted

**Blocked by:** 03, 15, 21, 31, 44. **Spec stories:** 39.

**What it delivers:** A deleted person immediately loses sessions, Bot, Task execution, Google access and file access.

**Acceptance criteria:**
- [ ] Deletion marker is atomic/idempotent
- [ ] running and queued work stop
- [ ] OAuth callback and signed file access cannot revive access
- [ ] another user is unaffected.

**Verification:** Deletion race with run, callback and download checks.

### Ticket 47: Restore recoverable data within 30 days

**Blocked by:** 46. **Spec stories:** 40.

**What it delivers:** An administrator can restore an accidentally deleted person's permitted data during the grace period.

**Acceptance criteria:**
- [ ] Restore requires administrator authority
- [ ] private Bot and files return with correct owner
- [ ] cancelled external writes do not restart
- [ ] after 30 days restore refuses.

**Verification:** Clock-controlled restore at day 29 and refusal at day 31.

### Ticket 48: Purge expired personal data and report retries

**Blocked by:** 24, 28, 34, 36, 38, 41, 42, 43, 45, 47. **Spec stories:** 40, 43.

**What it delivers:** After the 30-day grace period, an operator sees complete or retryable cleanup across personal stores.

**Acceptance criteria:**
- [ ] Task, Files, derived PDF, goals, ideas, memory, notifications and connector data purge by owner
- [ ] partial failure is recorded and retried
- [ ] backup retention respects the boundary.

**Verification:** Clock-controlled purge with injected storage/provider failure and retry.

### Ticket 49: Deploy one bounded self-hosted stack

**Blocked by:** 02, 13, 15, 36. **Spec stories:** 41–43.

**What it delivers:** An operator deploys OpenBot, PostgreSQL, OpenConnector and per-Bot computers without the old OpenMuse backend.

**Acceptance criteria:**
- [ ] OAuth callback is reachable and admin connector UI restricted
- [ ] per-Bot computer/worker limits suit 1–20 active users
- [ ] health and failure signals identify connector/queue/computer faults.

**Verification:** Clean environment deployment, capacity and observability smoke.

### Ticket 50: Prove the two-user Web cutover

**Blocked by:** 24, 28, 34, 36, 38, 41, 44, 45, 48, 49. **Spec stories:** 1–43.

**What it delivers:** Two real users finish the accepted OpenMuse flows on Web with OpenBot as the only backend.

**Acceptance criteria:**
- [ ] Both Google accounts and all five Task kinds work
- [ ] cross-user isolation and reviewed writes pass
- [ ] no old server/worker is running
- [ ] deviations become defect tickets, not waivers.

**Verification:** Recorded Web acceptance matrix and backend process inventory.

### Ticket 51: Prove the iOS cutover

**Blocked by:** 04, 11, 50. **Spec stories:** 1–43.

**What it delivers:** Two real users finish the same accepted flows on iOS.

**Acceptance criteria:**
- [ ] Native auth/session, computer, file/PDF, Activity and all Task flows work
- [ ] Google callback returns to app
- [ ] no platform-only data leak or stuck wait remains.

**Verification:** Recorded iOS device/simulator acceptance matrix.

### Ticket 52: Prove the Android cutover

**Blocked by:** 05, 11, 50. **Spec stories:** 1–43.

**What it delivers:** Two real users finish the same accepted flows on Android.

**Acceptance criteria:**
- [ ] Native auth/session, computer, file/PDF, Activity and all Task flows work
- [ ] Google callback returns to app
- [ ] no platform-only data leak or stuck wait remains.

**Verification:** Recorded Android device/emulator acceptance matrix.
## Coverage and publication gate

Spec story coverage: 1–8 (01–06), 9–14 (03, 07–13), 15–22 (14–19, 25–28, 45), 23–27 (20–24, 39), 28–35 (29–36, 38, 40–41), 36–38 (37, 42–45), 39–43 (46–52). Tickets 50–52 aggregate acceptance; they do not replace delivery by earlier Tickets.

Before publication, confirm granularity, the direct blocker edges and any merge/split changes with the user. Then create one `ready-for-agent` GitHub Issue per approved Ticket under Spec #1, in topological order, and add native dependency edges where supported. Do not edit or close Spec #1. Each issue must copy its own acceptance and verification text, refer to the parent, and list its direct blockers. Before any implementation, write that issue's exact file-level plan and integrate its reviewed checkpoint before starting downstream work.
