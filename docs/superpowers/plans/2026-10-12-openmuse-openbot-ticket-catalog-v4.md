# OpenMuse on OpenBot — v4 Ticket catalog (planning, not agent-ready)

> **Status:** approved and published as 92 planning Issues under [Spec #1](https://github.com/1123786563/openmuse/issues/1); see the [publication index](2026-10-12-openmuse-openbot-published-v4.md). This catalog and [contracts](2026-10-12-openmuse-openbot-contracts-v4.md) are the authoritative v4 planning pair. The 65-ticket revision 3 is superseded. **No item is ready for a Code Agent or labelled `ready-for-agent` until its own file-level writing plan identifies owned files, Consumes/Produces signatures, RED/GREEN commands and expected outputs.**
>
> Parent Spec: [openmuse#1](https://github.com/1123786563/openmuse/issues/1). Source decisions: OpenMuse CONTEXT.md and accepted ADRs 0004–0010.

## How to read and approve

Each ID is stable within this draft. `Blocked by` lists only direct code/interface prerequisites; a listed parent is not an implied dependency. An item has one primary behavior and one focused verification cycle. At most one shared contract and one screen/tool path are introduced in a Ticket. If its file-level plan needs a second independent behavior or cannot fit one fresh Agent context, split it before changing code. **B01** is a read-only source reconciliation task and **R01** is an explicit prefactoring exception; both have independently reviewable evidence. The release acceptance matrix is a separate gate, not a large Code Agent implementation Ticket.

Each Ticket below inherits exact fields, values and failure states from the named section of the [v4 contracts](2026-10-12-openmuse-openbot-contracts-v4.md). Its acceptance is a concrete observable check; the later file-level plan supplies test file names and commands.

Every state-owning Ticket also implements and checks its narrow lifecycle hook from contract §9. D04–D09 coordinate those hooks, so deletion and restoration do not become one enormous cross-module implementation Ticket.

## Source and identity

### B01 — Inventory copied-client differences

**Blocked by:** None. **Produces/Consumes:** source path/hash list.

**Acceptance:** Read-only reconciliation table covers every copied client path, vendored domain, Metro config, tests, assets and lockfiles; each difference has intent, owner Ticket and resolution; no unresolved row is silently discarded.

**Evidence:** Reviewed diff manifest, both HEADs and content hashes.

### B02 — Build canonical Web from submodule

**Blocked by:** B01. **Produces/Consumes:** pinned source layout.

**Acceptance:** OpenBot pins the full OpenMuse repository at apps/openmuse; a clean recursive checkout runs the exact pnpm Web export and OpenBot Bun build from contract §1; current user edits are not mistaken for pinned content.

**Evidence:** Clean checkout log, SHA and Web artifact.

### B03 — Build iOS and Android exports from submodule

**Blocked by:** B02. **Produces/Consumes:** native build entry.

**Acceptance:** Clean checkout runs the exact OpenMuse root iOS and Android export commands; the Bun workspace does not absorb the pnpm workspace; both artifacts record the same submodule SHA.

**Evidence:** Two native export logs and SHA.

### I01 — Sign in on Web and read an existing Bot

**Blocked by:** B02. **Produces/Consumes:** session transport.

**Acceptance:** Web uses Better Auth session and existing mobile workspace read; 401 shows sign-in; a foreign Bot ID returns 404; no old /api/session Bearer token is created.

**Evidence:** Web session/401/foreign-ID route checks.

### I02 — Provision exactly one private OpenMuse Bot

**Blocked by:** I01. **Produces/Consumes:** first-entry endpoint.

**Acceptance:** POST without user ID returns one Bot and computer profile per user; concurrent calls satisfy unique(owner_user_id, template_key); two users get distinct profiles; foreign actor cannot request another owner.

**Evidence:** Concurrent provisioning/unique-constraint check.

### I03 — Enter the provisioned Bot on Web

**Blocked by:** I02. **Produces/Consumes:** first-entry UI.

**Acceptance:** First Web entry calls provisioning then workspace read and opens returned private Bot; repeat entry reuses ID; no fixed default runtime identity remains.

**Evidence:** Web first/repeat entry and persisted Bot ID.

### I04 — Restore an iOS Better Auth session

**Blocked by:** B03, I03. **Produces/Consumes:** native session.

**Acceptance:** iOS returns to the same Bot after process restart; getSession 401 clears private view and asks sign-in; no old OpenMuse access key is used.

**Evidence:** iOS restart/expiry flow.

### I05 — Restore an Android Better Auth session

**Blocked by:** B03, I03. **Produces/Consumes:** native session.

**Acceptance:** Android returns to the same Bot after process restart; getSession 401 clears private view and asks sign-in; no old OpenMuse access key is used.

**Evidence:** Android restart/expiry flow.

### I06 — Clear Web private state on logout

**Blocked by:** I03. **Produces/Consumes:** logout cache contract.

**Acceptance:** Logout revokes Web cookie and clears CopilotKit, Channel/Thread, drafts, preview URLs and viewer state listed in contract §2; user B on the same browser sees none of user A's data.

**Evidence:** Shared-browser A logout/B login check.

### I07 — Clear iOS private state on logout

**Blocked by:** I04. **Produces/Consumes:** logout cache contract.

**Acceptance:** Logout revokes native session, closes streams and deletes cached PDF bytes and drafts listed in contract §2; A logout/B login on the same device cannot open A's File URL.

**Evidence:** iOS shared-device cache and old-URL check.

### I08 — Clear Android private state on logout

**Blocked by:** I05. **Produces/Consumes:** logout cache contract.

**Acceptance:** Logout revokes native session, closes streams and deletes cached PDF bytes and drafts listed in contract §2; A logout/B login on the same device cannot open A's File URL.

**Evidence:** Android shared-device cache and old-URL check.

### I09 — Preview and apply a Bot template revision

**Blocked by:** I02. **Produces/Consumes:** template version.

**Acceptance:** Managed/user field table in contract §2 drives a preview; v1 mail.read→v2 calendar.read changes grants once while title Research helper remains; concurrent apply leaves one final version.

**Evidence:** Preview diff and two concurrent update check.
## Conversation and computer

### C01 — Send one Channel message

**Blocked by:** I03. **Produces/Consumes:** Channel/Thread identity.

**Acceptance:** Client opens one permitted Bot through existing mobile conversation seam; distinct botId/channelId/threadId are retained; one reply and persisted Thread history appear after reload.

**Evidence:** Web send/reload and foreign Channel check.

### C02 — Create and switch Channels

**Blocked by:** C01. **Produces/Consumes:** Channel list.

**Acceptance:** Two Channels have different Thread IDs; switching restores each history; OpenBot's pinned/recency/ID cursor remains stable.

**Evidence:** Two-Channel Web flow.

### C03 — Rename, archive and reopen a Channel

**Blocked by:** C02. **Produces/Consumes:** archive access.

**Acceptance:** Archived filter lists archived Channel; reopening keeps the same Thread ID and history; foreign rename/archive returns 404.

**Evidence:** Archive/reopen and foreign-ID flow.

### C04 — Stop a streamed Bot run

**Blocked by:** C01. **Produces/Consumes:** run terminal state.

**Acceptance:** Stop is idempotent; racing completion produces one stopped/completed terminal state and no permanent spinner.

**Evidence:** Stop/completion race fixture.

### C05 — Resume a stream without duplicate events

**Blocked by:** C01. **Produces/Consumes:** event cursor.

**Acceptance:** Resume after event e2 replays e2/e3 but renders e2 once; unavailable cursor reloads persisted Thread with interruption indicator.

**Evidence:** e1/e2/e3 replay fixture from contract §3.

### C06 — Render named tool events and failures

**Blocked by:** C01. **Produces/Consumes:** tool event view.

**Acceptance:** Every event class enumerated in contract §3 has an asserted card/fallback; unknown event is neutral; tool error is not shown as success. This does not depend on stream resume.

**Evidence:** One fixture per event class and UI snapshot.

### C07 — Port observable assistant delegation behavior

**Blocked by:** C01, T02. **Produces/Consumes:** Bot prompt/tool intent.

**Acceptance:** Given the fixed prompt 'summarize this task and delegate it', private Bot invokes a durable Task tool after that tool exists; until then this Ticket remains blocked by T02; no response claims completion before Task status/receipt.

**Evidence:** Recorded tool call and final reply against task status.

### C08 — Use Channels on iOS

**Blocked by:** I04, C02, C03, C04, C05, C06. **Produces/Consumes:** native chat.

**Acceptance:** iOS creates/switches/archives Channels, stops and resumes one run and renders named events using shared client state; a platform-specific defect stays in this Ticket.

**Evidence:** iOS device flow with two Threads.

### C09 — Use Channels on Android

**Blocked by:** I05, C02, C03, C04, C05, C06. **Produces/Consumes:** native chat.

**Acceptance:** Android creates/switches/archives Channels, stops and resumes one run and renders named events using shared client state; a platform-specific defect stays in this Ticket.

**Evidence:** Android device flow with two Threads.

### K01 — Authorize a private computer stream

**Blocked by:** I02. **Produces/Consumes:** stream auth.

**Acceptance:** OpenBot stream authorization binds session and private botId; foreign stream URL and expired session refuse; disconnect closes the stream.

**Evidence:** Two-user stream URL and 401/404 checks.

### K02 — Show computer preview

**Blocked by:** K01. **Produces/Consumes:** preview UI.

**Acceptance:** OpenMuse shows own Bot snapshot and live state; stream closure changes UI to disconnected without retaining an accessible preview URL.

**Evidence:** Web preview/disconnect flow.

### K03 — Claim and revoke a human-control lease

**Blocked by:** K01. **Produces/Consumes:** control state machine.

**Acceptance:** Contract §3 viewing/requesting/controlling/released/refused/expired transitions hold; competing claim has one winner; stale sequence or revoked lease delivers zero input; Policy audit names actor/lease.

**Evidence:** Concurrent claims, late input and Policy refusal check.

### K04 — Control the computer from OpenMuse

**Blocked by:** K02, K03. **Produces/Consumes:** human-control UI.

**Acceptance:** Request, refusal, active control and release are visible; logout or disconnect ends control; late keyboard/mouse UI input is refused.

**Evidence:** Take-control/release/race UI flow.
## Google, Mail and Calendar

### G01 — Connect Gmail with an OAuth callback

**Blocked by:** I03. **Produces/Consumes:** Gmail connection.

**Acceptance:** State is one-use, session-bound and 10-minute TTL as contract §4; successful consent shows accountEmail/generation; foreign alias and wrong state create no connection.

**Evidence:** Real Gmail account plus wrong-state callback.

### G02 — Handle expired, repeated and abandoned Gmail callbacks

**Blocked by:** G01. **Produces/Consumes:** callback result.

**Acceptance:** Expired state and signed-out callback fail; completed callback replay returns stored result without duplicate alias; nonce/return URI mismatch refuses.

**Evidence:** OAuth fault matrix with fake callback clock.

### G03 — Grant Calendar access separately

**Blocked by:** G01. **Produces/Consumes:** Calendar scope.

**Acceptance:** Same user can grant Calendar after Gmail; Calendar scope and account identity are explicit; Gmail-only grant does not authorize Calendar calls.

**Evidence:** Real Calendar consent and Gmail-only refusal.

### G04 — Refresh an expired Google grant

**Blocked by:** G01, G03. **Produces/Consumes:** refresh status.

**Acceptance:** refresh_required is visible; one successful refresh restores provider calls and increments generation when credential identity changes; failed refresh never calls Mail/Calendar.

**Evidence:** Expired-grant/refresh flow.

### G05 — Disconnect and reconnect Google

**Blocked by:** G01, G03. **Produces/Consumes:** connection generation.

**Acceptance:** Disconnect blocks provider calls before OpenConnector; reconnect creates a new generation; an action bound to an old generation remains stale.

**Evidence:** Disconnect/reconnect with two generations.

### G06 — Show Google account status in OpenMuse

**Blocked by:** G03, G04, G05. **Produces/Consumes:** connected-account UI.

**Acceptance:** UI shows accountEmail, scopes, connected/refresh_required/disconnected/revoked; each action's failure appears without exposing tokens.

**Evidence:** Web connection-state fixture grid.

### M01 — List and search Gmail

**Blocked by:** G01. **Produces/Consumes:** Mail DTO.

**Acceptance:** Contract §4 fields and newest-time/ID order are returned for the authenticated account; disconnected account refuses; other user's message ID does not resolve.

**Evidence:** Two-account search/list fixture.

### M02 — Page Gmail without gaps

**Blocked by:** M01. **Produces/Consumes:** Mail cursor.

**Acceptance:** Page size 2 over equal-timestamp three-message fixture returns each ID once; malformed/foreign cursor returns 400; truncation is visible.

**Evidence:** Boundary page fixture and cursor rejection.

### M03 — Read a Gmail thread

**Blocked by:** M01. **Produces/Consumes:** thread DTO.

**Acceptance:** Messages are oldest-time/ID order with normalized body and headers; direct foreign thread ID refuses; missing provider thread is a visible not-found state.

**Evidence:** Three-message thread fixture.

### M04 — Read attachment metadata and bytes

**Blocked by:** M03. **Produces/Consumes:** attachment DTO.

**Acceptance:** Attachment name/MIME/size are shown; authenticated owner can fetch bytes within existing Google size limit; copied foreign attachment ID refuses.

**Evidence:** Real PDF attachment and foreign-ID check.

### A01 — List and open Calendar events

**Blocked by:** G03. **Produces/Consumes:** event DTO.

**Acceptance:** Contract §4 event fields and start/ID ordering are returned for a half-open range ≤366 days; Gmail-only grant refuses; foreign event ID refuses.

**Evidence:** Two-account list/detail range fixture.

### A02 — Page Calendar without gaps

**Blocked by:** A01. **Produces/Consumes:** event cursor.

**Acceptance:** Page size 2 over equal-start three-event fixture returns every ID once; bad/foreign cursor returns 400; provider truncation is explicit.

**Evidence:** Boundary page fixture.

### A03 — Render Calendar time zones and all-day dates

**Blocked by:** A01. **Produces/Consumes:** date presentation.

**Acceptance:** Contract §4 LA DST timed fixture shows 01:30–03:30 for a one-hour event; all-day March 8 remains March 8 across device zones.

**Evidence:** LA/New York/device-zone fixture outputs.
## Files and PDF

### F01 — Upload and list one personal File

**Blocked by:** I03. **Produces/Consumes:** File metadata/store.

**Acceptance:** Owner uploads ≤20 MiB non-PDF or ≤10 MiB PDF; list shows stable ID, size and SHA-256 after restart; same idempotency key does not duplicate.

**Evidence:** Upload/list/restart and over-limit checks.

### F02 — Download a private File

**Blocked by:** F01. **Produces/Consumes:** content access.

**Acceptance:** Authenticated current owner downloads exact hash; copied URL after logout or foreign ID fails; path input cannot select server storage location.

**Evidence:** Hash/foreign/old-URL checks.

### F03 — Rename and delete a File

**Blocked by:** F02. **Produces/Consumes:** File mutation.

**Acceptance:** Rename changes metadata only; delete tombstones and hides item immediately; old content URL fails; a new upload key creates a new version.

**Evidence:** Rename/delete/reupload flow.

### F04 — Use Files on iOS

**Blocked by:** F02, I04. **Produces/Consumes:** iOS Files.

**Acceptance:** iOS uses authenticated bytes and owner-scoped cache; list/download works; logout clears cached content and old URL access.

**Evidence:** iOS cache/download flow.

### F10 — Use Files on Android

**Blocked by:** F02, I05. **Produces/Consumes:** Android Files.

**Acceptance:** Android uses authenticated bytes and owner-scoped cache; list/download works; logout clears cached content and old URL access.

**Evidence:** Android cache/download flow.

### F05 — Inspect supported PDF fields

**Blocked by:** F02. **Produces/Consumes:** inspection DTO.

**Acceptance:** Text and checkbox appear with exact names; dropdown/radio/list report unsupported reason; encrypted/XFA/malformed and >500-page PDFs refuse with distinct error.

**Evidence:** PDF fixture table in contract §5.

### F06 — Generate a filled PDF copy

**Blocked by:** F05. **Produces/Consumes:** immutable version.

**Acceptance:** Ava/consent fixture fills text and checkbox; unsupported/unknown/wrong-type input refuses; original SHA remains unchanged; derived version records parent and values; Web viewer opens both versions.

**Evidence:** Original/derived hash and field-value check.

### F07 — View original and filled PDF on iOS

**Blocked by:** F06, F04. **Produces/Consumes:** native viewer.

**Acceptance:** iOS opens both authorized versions; expired session and deleted File fail without displaying stale cached bytes.

**Evidence:** iOS original/copy/session flow.

### F08 — View original and filled PDF on Android

**Blocked by:** F06, F10. **Produces/Consumes:** native viewer.

**Acceptance:** Android opens both authorized versions; expired session and deleted File fail without displaying stale cached bytes.

**Evidence:** Android original/copy/session flow.

### F09 — Transfer a PDF version to Bot workspace

**Blocked by:** F06, K01. **Produces/Consumes:** workspace artifact.

**Acceptance:** Server derives destination from fileId/versionId; same-name file is not overwritten; retry key returns same artifact; partial transfer is not marked complete.

**Evidence:** Collision/retry/failure fixture.

## Reviewed actions

### R01 — Establish a Reviewed action seam with a fake executor

**Blocked by:** G01. **Produces/Consumes:** proposal/claim/receipt contract.

**Acceptance:** A fixture proposal is shown, denied or atomically claimed; two approvals yield one fake-executor call; status/receipt follow contract §6. This prefactor owns no Gmail/Calendar provider behavior.

**Evidence:** State-table and concurrent-claim checks.

### R02 — Approve and send one Gmail message

**Blocked by:** R01, M03. **Produces/Consumes:** Gmail execution.

**Acceptance:** Exact recipient/subject/body/account are shown; approve sends once with provider message ID; deny and 30-minute expiry send nothing.

**Evidence:** Real test-account send/deny/expiry receipts.

### R03 — Reject stale Gmail proposals

**Blocked by:** R02, G05. **Produces/Consumes:** staleness guard.

**Acceptance:** Changed payload hash, account generation or reply target returns 409 and zero provider sends; UI asks for a new proposal.

**Evidence:** Changed-account/recipient/thread fixture.

### R04 — Reconcile an uncertain Gmail send

**Blocked by:** R02. **Produces/Consumes:** outcome_unknown.

**Acceptance:** Timeout after accepted request records attemptId and outcome_unknown; no queue replay; operator records confirmed-succeeded/not-sent/unresolved with evidence.

**Evidence:** Fault-injected timeout and manual reconciliation matrix.

### R05 — Create a reviewed Calendar event

**Blocked by:** R01, A03. **Produces/Consumes:** Calendar create execution.

**Acceptance:** Exact calendar/timezone/attendees are shown; approve creates once with event ID; deny/expiry creates none.

**Evidence:** Real Calendar create/deny receipts.

### R06 — Update a reviewed Calendar event

**Blocked by:** R05. **Produces/Consumes:** Calendar update execution.

**Acceptance:** Proposal binds event ID and etag; matching version updates once; changed etag returns 409 with zero writes.

**Evidence:** Real update and stale-etag fixture.

### R07 — Delete a reviewed Calendar event

**Blocked by:** R05. **Produces/Consumes:** Calendar delete execution.

**Acceptance:** Proposal binds event ID and etag; approve deletes once; deny or missing target leaves calendar unchanged.

**Evidence:** Real delete/deny/missing-target fixture.

### R08 — Reconcile uncertain Calendar mutations

**Blocked by:** R06, R07, R04. **Produces/Consumes:** Calendar uncertainty.

**Acceptance:** Provider timeout after create/update/delete leaves outcome_unknown with attempt fingerprint; no automatic retry; reconciler records provider evidence.

**Evidence:** Fault-injected Calendar timeout and reconciliation matrix.
## Tasks, monitoring and document work

### T01 — Create and list a queued Task

**Blocked by:** I03. **Produces/Consumes:** Task identity/state.

**Acceptance:** UI creates one owner-scoped agent Task with queued state and stable ID; repeated idempotency key returns same Task; foreign ID returns 404. No runner is introduced here.

**Evidence:** Create/list/restart and two-user checks.

### T02 — Execute one Task with the existing headless runner

**Blocked by:** T01, C01. **Produces/Consumes:** one-step run.

**Acceptance:** WorkQueue offers/claims Task once; a one-step private Bot turn reaches succeeded/failed within configured deadline; client may close; no second lease table is added.

**Evidence:** Offline success/failure/timeout flow.

### T03 — Show Task steps and evidence

**Blocked by:** T02. **Produces/Consumes:** Task detail.

**Acceptance:** Step/run/evidence kinds from contract §7 render by stable IDs; failed step has error; reload does not duplicate event.

**Evidence:** mail/file/web/user and failure fixtures.

### T04 — Cancel a Task

**Blocked by:** T02. **Produces/Consumes:** cancel transition.

**Acceptance:** queued/scheduled Task cancels immediately; running Task sets `cancellationRequested`, remains publicly `running` until it stops before the next safe step, then becomes `cancelled`; terminal status rejects cancel with 409.

**Evidence:** Transition matrix and running-step interruption.

### T05 — Pause and resume a Task

**Blocked by:** T02. **Produces/Consumes:** pause/resume transition.

**Acceptance:** queued/running/scheduled pause at safe boundary; paused→queued resumes once; terminal status or wrong owner returns 409.

**Evidence:** Pause boundary/restart/resume flow.

### T06 — Retry a failed Task

**Blocked by:** T03. **Produces/Consumes:** new attempt.

**Acceptance:** failed→queued creates a new attempt while retaining old evidence; succeeded/cancelled cannot retry; retry idempotency key creates only one attempt.

**Evidence:** Failure/retry/duplicate-request check.

### T07 — Recover a lost Task lease

**Blocked by:** T02. **Produces/Consumes:** lease recovery.

**Acceptance:** Database-clock lease loss before external effect requeues once; after unconfirmed effect does not replay and records reconciliation wait/failure; stale worker cannot finish a new owner's claim.

**Evidence:** Killed-worker before/after effect fixture.

### T08 — Answer a Task waiting for input

**Blocked by:** T03, T07. **Produces/Consumes:** wait schema.

**Acceptance:** Owner submits exact waitId and typed fields; first valid answer consumes once; duplicate answer returns stored result; invalid/foreign answer leaves wait open.

**Evidence:** Restart-at-wait and duplicate-answer check.

### T09 — Run a Plan Task

**Blocked by:** T03, T07. **Produces/Consumes:** plan step graph.

**Acceptance:** Three-step fixture runs only when dependsOn predecessors succeed; restart retains succeeded steps; failed second step leaves third pending until explicit new attempt.

**Evidence:** Three-step success/failure/restart fixture.

### T10 — Schedule a Monitor

**Blocked by:** T02. **Produces/Consumes:** monitor schedule.

**Acceptance:** Condition is change/contains/price_below with interval 1–10,080 minutes; UTC nextCheckAt controls first due run; stop prevents later offers.

**Evidence:** Clock-controlled before/due/after/stop cases.

### T11 — Deduplicate and back off Monitor observations

**Blocked by:** T10, T07. **Produces/Consumes:** observation cursor.

**Acceptance:** Same normalized observation ID emits once after restart; new match emits once; failures back off 15/30/60 minutes capped at six hours.

**Evidence:** Repeated page/price fixture and fake clock.

### T12 — Notify Task and Monitor owners

**Blocked by:** T03, T11. **Produces/Consumes:** notification event.

**Acceptance:** Only enumerated events in contract §7 create one user-scoped item; monitor.matched uses observation ID; readAt persists and other user cannot mark it.

**Evidence:** State-transition/monitor match and two-user read check.

### T13 — Create a finance Task artifact

**Blocked by:** F02, T03. **Produces/Consumes:** finance result.

**Acceptance:** Exact three-row fixture gives 4200.00 income, 91.00 spending, 4109.00 saved; row 4 amount 6.501 refuses whole CSV; output File/Artifact is owner-scoped.

**Evidence:** CSV fixture, Task detail and private artifact check.

### T14 — Import a Gmail PDF attachment into Files

**Blocked by:** M04, F02. **Produces/Consumes:** attachment provenance.

**Acceptance:** Current user's PDF attachment becomes one File with source message/thread ID and SHA-256; retry with same import key returns same version; foreign attachment refuses.

**Evidence:** Real PDF mail and duplicate-import check.

### T15 — Fill a document Task after an input wait

**Blocked by:** T08, F06, T14. **Produces/Consumes:** document step.

**Acceptance:** Task requests missing text/checkbox values with schema; owner answer fills one copy, source stays unchanged; restart preserves wait and artifact version.

**Evidence:** Missing-value/restart/PDF fixture.

### T16 — Send a document Task's reviewed reply

**Blocked by:** T15, R04. **Produces/Consumes:** document reply.

**Acceptance:** Proposal binds reply thread/message, account generation and filled attachment version; denial retains File without send; uncertainty does not resend; receipt links Task.

**Evidence:** Real reply approve/deny/timeout flow.
## Personal context, Activity and account lifecycle

### P01 — Create and use a private Goal

**Blocked by:** I03, C01. **Produces/Consumes:** Goal tool.

**Acceptance:** Goal fields/milestones follow contract §7; private Bot retrieves exact ID/title/status; foreign user or Bot without grant gets no Goal; delete hides it.

**Evidence:** Goal UI/tool/permission fixture.

### P02 — Capture and use a private Idea

**Blocked by:** I03, C01, T01. **Produces/Consumes:** Idea tool.

**Acceptance:** Idea fields/status follow contract §7; accepted Idea points to one Task; private Bot cites exact Idea ID; foreign actor cannot retrieve.

**Evidence:** Idea UI/accept/tool/permission fixture.

### P03 — Write and retrieve private Memory

**Blocked by:** I03, C01. **Produces/Consumes:** Memory tool.

**Acceptance:** Explicit tool call writes ID/text/source and later retrieves exact record; another Bot/user cannot retrieve; delete/revoke removes future retrieval.

**Evidence:** Two-Bot write/read/delete fixture.

### V01 — Show Policy and Reviewed action items in Activity

**Blocked by:** K03, R03, R04, R06, R08. **Produces/Consumes:** typed action feed.

**Acceptance:** Feed source/type/status/order follow contract §8; stale/unknown reviewed items show actual state; Policy decision cannot claim a Reviewed action and vice versa.

**Evidence:** Mixed policy/reviewed action fixture.

### V02 — Show Task notifications in Activity

**Blocked by:** V01, T12. **Produces/Consumes:** typed notification feed.

**Acceptance:** task and monitor notifications join ordered feed with readAt; marking read never changes review/policy state; foreign user cannot read.

**Evidence:** Mixed feed, read and foreign-ID check.

### D01 — Fence a deleted account at authentication

**Blocked by:** I02. **Produces/Consumes:** deletion marker.

**Acceptance:** Atomic disabled marker makes all new authenticated requests fail immediately; repeated delete is idempotent; another user remains active.

**Evidence:** Session request race and repeat delete.

### D02 — Stop Task, Monitor and pending write work

**Blocked by:** D01, T08, T11, R04, R08. **Produces/Consumes:** work shutdown hook.

**Acceptance:** Deletion cancels queued/running/waiting Tasks, future Monitor offers and awaiting Reviewed actions; lease recovery cannot restart them; an executing external attempt remains outcome_unknown for reconciliation.

**Evidence:** Delete during run/wait/monitor/review fixtures.

### D03 — Revoke Google and File access at deletion

**Blocked by:** D01, G05, F02. **Produces/Consumes:** external access shutdown.

**Acceptance:** Provider calls and File bytes refuse immediately through fence; OpenConnector disconnect is attempted and retryable; late OAuth callback cannot restore a connection.

**Evidence:** Callback/download/provider-call race.

### D04 — Create a durable deletion resource manifest

**Blocked by:** D02, D03, C03, K03, F09, T09, T11, T12, T13, T16, P01, P02, P03, V02. **Produces/Consumes:** cleanup enumeration.

**Acceptance:** Before metadata removal, manifest records Bot/Channel/Thread/computer, Task/Monitor, reviews, personal context, File object keys and connector aliases; each resource has pending/deleted/retryable_error state.

**Evidence:** Inventory comparison against two-user seeded data.

### D05 — Restore the full recoverable set within 30 days

**Blocked by:** D04. **Produces/Consumes:** restoration.

**Acceptance:** Day 29 restores Bot, Channel/Thread, Task history, Files/versions, Goal, Idea, Memory, notification and reviewed history for correct owner; cancelled work stays stopped; day 31 returns 410.

**Evidence:** Fake-clock restore matrix.

### D06 — Purge external File bytes

**Blocked by:** D04, D05. **Produces/Consumes:** File cleanup.

**Acceptance:** Manifest object keys drive deletion of original and derived bytes before File metadata is removed; injected storage failure remains retryable; retry never touches another user's object.

**Evidence:** Storage fault/retry and two-user object count.

### D07 — Purge OpenConnector grants

**Blocked by:** D04, D05. **Produces/Consumes:** connector cleanup.

**Acceptance:** Manifest aliases drive revocation and deletion before account metadata is removed; injected connector failure remains retryable; repeated cleanup does not reconnect or affect another user.

**Evidence:** Connector fault/retry and alias inventory.

### D08 — Purge OpenBot relational personal data

**Blocked by:** D06, D07. **Produces/Consumes:** relational cleanup.

**Acceptance:** After external states are deleted, remove all manifested Bot/computer, Channel/Thread, Task/Monitor, reviewed, personal-context and notification records; partial DB failure retains manifest for retry.

**Evidence:** DB fault/retry and cross-user count check.

### D09 — Enforce backup retention and final cleanup visibility

**Blocked by:** D08. **Produces/Consumes:** retention/ops.

**Acceptance:** Backups containing deleted personal bytes expire within configured retention; unresolved manifest rows remain operator-visible; successful cleanup leaves only non-personal audit proof.

**Evidence:** Backup policy inspection and expired-manifest check.
## Deployment and source cleanup

### O01 — Deploy the OpenBot API and database baseline

**Blocked by:** B03. **Produces/Consumes:** reference environment.

**Acceptance:** Clean stack starts OpenBot API and PostgreSQL with migrations; readiness fails if database is absent; neither old OpenMuse server nor TaskWorker starts.

**Evidence:** Fresh deployment process inventory and database-off smoke.

### O02 — Deploy OpenConnector and OAuth callback

**Blocked by:** O01, G03. **Produces/Consumes:** connector environment.

**Acceptance:** Callback reaches the configured public origin; connector runtime/admin interfaces are backend-restricted; no secret enters the mobile bundle.

**Evidence:** Callback and network-boundary smoke.

### O03 — Bound private computer capacity

**Blocked by:** O02, K03. **Produces/Consumes:** computer capacity config.

**Acceptance:** 1–20 active-user profile fixes max concurrent computers, idle timeout and per-Bot disk cap; excess demand queues/refuses visibly without cross-user effects.

**Evidence:** Computer limit table and 21st-request smoke.

### O04 — Bound Task worker capacity

**Blocked by:** O02, T11. **Produces/Consumes:** worker capacity config.

**Acceptance:** Worker concurrency and queue ceiling are explicit; excess jobs remain queued or refuse with a visible reason; another user's Task is not starved indefinitely.

**Evidence:** Worker limit table and controlled overload smoke.

### O05 — Expose connector, task, review and cleanup failures

**Blocked by:** O03, O04, R04, R08, D09. **Produces/Consumes:** ops signals.

**Acceptance:** Health/status reports connector refresh failure, queue stuck Task, outcome_unknown Reviewed action and retryable cleanup with owner-safe identifiers; no secret leaks.

**Evidence:** Four injected fault signals and redacted log check.

### B04 — Remove copied client after all mapped adaptations land

**Blocked by:** B01, B03, I07, I08, C07, C08, C09, K04, G06, M04, A03, F04, F10, F07, F08, R08, T16, P03, V02. **Produces/Consumes:** single source.

**Acceptance:** Every B01 difference row names a resolved canonical commit and check; deleting apps/openmuse-mobile leaves Web/iOS/Android builds green and no import/CI reference to the copy.

**Evidence:** Resolved manifest, rg reference scan, three clean exports.
## Publication and execution gate

The following are **planning Tickets**, not dispatchable tasks. The approved breakdown is published as [Issues #2–#93](2026-10-12-openmuse-openbot-published-v4.md) with native GitHub dependencies. Spec #1 remains open; [Issue #94](https://github.com/1123786563/openmuse/issues/94) holds the separate release acceptance gate. Before a Ticket is claimed, write a file-level `writing-plans` plan with exact owned files, Consumes/Produces signatures, RED/GREEN commands and expected outputs; only then apply `ready-for-agent`.
