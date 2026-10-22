# OpenMuse on OpenBot — release acceptance matrix (v4 draft)

> **Status:** approved and published as [release gate #94](https://github.com/1123786563/openmuse/issues/94); no cases executed. Companion to the [v4 Ticket catalog](2026-10-12-openmuse-openbot-ticket-catalog-v4.md) and [contracts](2026-10-12-openmuse-openbot-contracts-v4.md). The cases below are **release gates**, not Code Agent implementation Tickets. A gate is assigned to one verifier context by a bounded scenario group, and a failure becomes a defect Issue owned by the implementation Ticket in the last column.

## Environment and evidence protocol

- **Users:** OpenBot users U-A and U-B, each with a distinct real Gmail and Calendar test account G-A and G-B. Use separate private Bots B-A/B-B, Channels C-A/C-B and computers K-A/K-B. Seed PDF P-1 (text/checkbox/unsupported dropdown), mail thread M-1 with PDF attachment, calendar event E-1 and finance CSV F-1 from contract §§4–7. No production personal data.
- **Devices:** Web in a clean browser profile; one iOS device/simulator with the release bundle; one Android device/emulator with the release bundle. Record OS/app versions, API revision, OpenMuse submodule SHA, OpenConnector version, UTC run time, and environment ID. Native tests include process kill/reopen; Web includes refresh. For callbacks, record only sanitized authorization status, never tokens.
- **Evidence:** each row's ID is a case prefix. Run applicable platforms separately: `W-<ID>`, `I-<ID>`, `A-<ID>`; admin/operator-only rows use `O-<ID>`. Store a record under `docs/acceptance/openmuse-on-openbot/<run-id>/<evidence-id>.md` with preconditions, exact actions, expected UI, expected API/database/provider state, observed result, sanitized screenshot/log/receipt paths, and PASS/FAIL. A row is passed only when every listed platform has a PASS record.
- **Failure routing:** last-column Ticket owns first investigation; an interface bug can be reassigned with evidence. A fix reruns the failed row on affected platforms and any row sharing the changed contract. Signoff links all 43 row IDs to PASS evidence; missing evidence is a failure, not a waiver. No old OpenMuse server or TaskWorker process may be present.
- **Bounded verifier groups:** core identity/chat/computer (S01–S14, S38); Google/review (S15–S22); files/document (S23–S29); Tasks/monitor/finance (S28, S30–S35, S37); personal/deletion/ops (S36, S39–S43). Each group is run separately per platform; a verifier receives only that group and the relevant contract section.

## Spec #1 story cases

| ID / platform | Preconditions and action | Expected UI, API and durable/provider state | Owning Ticket |
| --- | --- | --- | --- |
| S01 / I | U-A signed out on iOS; sign in and open workspace. | Sign-in returns U-A session; B-A appears, B-B absent; no OpenMuse Bearer token. | I04 |
| S02 / A | U-A signed out on Android; sign in and open workspace. | Same account and B-A as Web/iOS; B-B absent. | I05 |
| S03 / W | U-A signed out on Web; sign in and open workspace. | Better Auth cookie session returns U-A; B-A opens; no old /api/session. | I01,I03 |
| S04 / W,I,A | U-A signed in; kill/reopen native app or refresh Web. | getSession remains U-A; same B-A and Channel list reappear without duplicate Bot. | I03,I04,I05 |
| S05 / W,I,A | U-A opens Channel, PDF and computer preview; logout; U-B signs in on same device/profile. | U-B sees none of U-A's Channel/cache/PDF bytes/stream; old File URL and session fail. | I06,I07,I08 |
| S06 / W,I,A | New U-B signs in and enters twice, including concurrent first-entry requests. | One B-B row and one computer profile exist; both requests return same Bot ID. | I02,I03 |
| S07 / O,W | U-A edits Bot title to Research helper; admin previews v1→v2 template. | Preview shows managed mail.read→calendar.read and unchanged user title; apply preserves title. | I09 |
| S08 / O,W | Admin applies v2 twice concurrently to B-A/B-B. | Each Bot ends at v2 with one grant update; non-admin apply gets 403. | I09 |
| S09 / W,I,A | U-A and U-B open computer and workspace views simultaneously. | K-A/K-B IDs differ; foreign stream/input/File request returns 403/404; no cross-user bytes. | I02,K01,K03 |
| S10 / W,I,A | U-A creates C1/C2, switches, renames C1, archives and reopens it. | C1/C2 retain different Thread IDs; archived filter finds C1 and its history. | C02,C03,C08,C09 |
| S11 / W,I,A | U-A sends text in C1; reload/reopen and select C1. | Same Thread and messages persist; C2 history remains distinct. | C01,C02 |
| S12 / W,I,A | Bot streams text, named tool event and error fixture. | Text incrementally appears; exact event card or neutral unknown fallback appears; error is not success. | C01,C06 |
| S13 / W,I,A | Start run; stop during stream; start another and disconnect after e2, reconnect. | Stopped/completed terminal state is singular; e2 renders once and e3 follows; no spinner. | C04,C05 |
| S14 / W,I,A | Ask private Bot to delegate a one-step task, then inspect Task status. | Tool invocation creates one durable Task; reply never says complete before Task terminal state. | C07,T02 |
| S15 / W,I,A | U-A connects G-A Gmail; U-B connects G-B; authorize Calendar separately. | Account/scopes visible; aliases differ; no Google token in client; callback returns to owner. | G01,G03,G06 |
| S16 / W,I,A | Disconnect G-A, invoke Mail, reconnect and inspect account. | Disconnected UI and 409 provider refusal; new generation on reconnect; G-B unaffected. | G05,G06 |
| S17 / W,I,A | Seed three Gmail messages with equal timestamp, page size 2; open thread and attachment. | No duplicate/missing IDs; oldest-first thread; attachment metadata/bytes match G-A only. | M01,M02,M03,M04 |
| S18 / W,I,A | Seed LA DST timed and all-day events; browse Calendar from two device zones. | Timed fixture shows 01:30–03:30 LA and one-hour duration; all-day stays March 8; G-B isolated. | A01,A02,A03 |
| S19 / W,I,A | Prepare Gmail proposal with exact to/subject/body/G-A; approve once. | Review shows bound fields; one provider message ID and one receipt; Task link if present. | R01,R02 |
| S20 / W,I,A | Prepare create/update/delete event proposals with E-1 etag; approve each. | Exact calendar/time zone/target visible; one provider outcome/receipt per approved action. | R05,R06,R07 |
| S21 / W,I,A | Deny one proposal; expire another; change account/etag; inject provider timeout. | Zero writes for deny/expiry/stale; uncertain shows warning and no auto-retry; reconciliation evidence persists. | R03,R04,R08 |
| S22 / W,I,A | Seed one Policy approval, one Reviewed action and one Task notification; act on each. | One ordered typed feed; wrong decision type returns 409; marking notification read changes only it. | V01,V02 |
| S23 / W,I,A | U-A uploads File X, lists, renames, downloads, deletes; U-B copies URL. | Metadata persists; SHA-256 matches bytes; old URL and U-B fetch fail; item disappears on delete. | F01,F02,F03,F04,F10 |
| S24 / W,I,A | U-A selects PDF attachment from M-1 and imports twice with same key. | One owned File version with message/thread provenance; U-B cannot import G-A attachment. | T14 |
| S25 / W,I,A | Inspect P-1 with text, checkbox and dropdown; inspect encrypted PDF. | Text/checkbox supported; dropdown reason shown; encrypted PDF fails distinctly; original unchanged. | F05 |
| S26 / W,I,A | Fill P-1 name=Ava and consent=true; try unknown field and wrong type. | New version has Ava/true; original hash unchanged; invalid input creates no version. | F06 |
| S27 / W,I,A | Open original and copy; transfer copy twice into K-A workspace. | Both versions readable; generated workspace artifact stable on retry; same-name existing file not overwritten. | F07,F08,F09 |
| S28 / W,I,A | Start one-step Task, close client, reopen after run; inspect detail. | Task runs on private Bot; steps/evidence and terminal result persist; U-B gets 404 for Task ID. | T01,T02,T03 |
| S29 / W,I,A | Select M-1 PDF, start document Task, omit a required value, reopen and answer; review reply. | Wait survives restart; one filled copy created; exact attachment version bound; no send until approval. | T14,T15,T16 |
| S30 / W,I,A | Submit F-1 three-row CSV and bad 6.501 row variant. | Valid result: income 4200.00, spending 91.00, saved 4109.00; bad row 4 refuses all output. | T13 |
| S31 / W,I,A | Run three-step Plan; fail step 2, restart worker, inspect. | Step 1 remains succeeded; step 2 failed; step 3 pending; no duplicate external effect. | T09 |
| S32 / W,I,A | Create change/contains/price monitor with allowed interval; advance fake clock. | Due check occurs at nextCheckAt; condition match appears once with notification. | T10,T11,T12 |
| S33 / W,I,A | Queue Task then cancel; pause running Task at safe step, resume; retry failed Task. | Transition matrix matches contract §7; terminal illegal action gets 409; retry has new attempt and old evidence. | T04,T05,T06 |
| S34 / W,I,A | Kill worker during lease, waiting input and waiting review; restart and answer once. | No lost wait or duplicated completed step; stale worker cannot finish; repeated answer does not advance twice. | T07,T08 |
| S35 / W,I,A | Repeat Monitor observation after restart and inject three failures. | Same observation creates no second item; next delays 15/30/60 minutes and reset after success. | T11 |
| S36 / W,I,A | U-A creates Goal, Idea and Memory; private Bot reads IDs; U-B and another Bot try. | Private Bot returns exact ID/title/text; foreign reads refuse; deleted/revoked record no longer returns. | P01,P02,P03 |
| S37 / W,I,A | Task succeeds then Monitor matches; inspect unread count and mark first read. | One notification per event key; unread count persists; U-B cannot mark A's item. | T12,V02 |
| S38 / W,I,A | U-A views K-A, requests control; U-B requests K-A; A disconnects then sends input. | A controls until disconnect; B refused; late input returns 403/409 and is not delivered; audit records actor. | K01,K02,K03,K04 |
| S39 / W,I,A | Delete U-A during active Task, Monitor and pending Reviewed action; attempt API/file/callback. | Session, Bot, Task scheduling, provider and File access stop immediately; U-B unaffected; executing uncertain attempt not replayed. | D01,D02,D03 |
| S40 / O,W | At day 29 restore U-A; at day 31 repeat on another seeded deletion. | Bot, Channel/Thread, Task history, Files, Goal, Idea, Memory, notifications and review history restored read-only as specified; day-31 restore 410. | D04,D05 |
| S41 / O | Clean recursive OpenBot checkout at pinned OpenMuse SHA; build Web/iOS/Android. | Exact commands in contract §1 pass; no copied-tree imports; deployed process list has no old OpenMuse backend. | B01,B02,B03,B04,O01 |
| S42 / O | Start 20 private computers; request a 21st; queue five runnable Tasks; exceed a Bot's 2 GiB disk limit; advance 15 idle minutes. | 21st computer queues/refuses; only four Tasks run; fifth remains queued; disk write refuses; idle stream closes; no cross-user leak. | O03,O04 |
| S43 / O | Inject connector refresh failure, queued Task age >5 minutes, outcome_unknown write and cleanup retryable_error. | Four health/ops signals appear with safe IDs and no secrets; owner sees delayed/uncertain states; cleanup retries remain visible. | O05,D09 |

## Fault and edge-case run cards

| Case | Setup → action | Expected result | Rerun owners |
| --- | --- | --- | --- |
| F-OAUTH-1 | Start Gmail consent, sign out, then return callback | State/session mismatch; no connection; UI asks sign-in | G01,G02,I06–I08 |
| F-OAUTH-2 | Reuse completed callback URL | Same recorded connection result; no second alias/generation | G02 |
| F-MAIL-1 | Approve same hash in two clients at once | One claim, one provider attempt, both clients see one receipt | R01,R02 |
| F-MAIL-2 | Provider accepts send, response times out | outcome_unknown with attempt fingerprint; zero automatic retries | R04,T16 |
| F-CAL-1 | Change E-1 etag after proposal | 409 stale, zero Calendar update/delete calls | R06,R07,R08 |
| F-STREAM-1 | Disconnect after e2, replay e2/e3 | e2 rendered once, e3 rendered once | C05,C08,C09 |
| F-CONTROL-1 | Revoke lease while key event is in flight | Later sequence refused; no input delivered after revocation | K03,K04 |
| F-TASK-1 | Kill worker after lease claim before side effect | One recovered attempt, no lost Task | T07 |
| F-TASK-2 | Kill worker after possible external effect | Reconciliation wait/failure; no replay | T07,R04 |
| F-DELETE-1 | Delete while OAuth callback and signed download race | Both refuse after deletion marker; resource manifest remains retryable | D01,D03,D04 |
| F-PURGE-1 | Fail File byte deletion once, retry | Manifest retains external key, then marks deleted; relational row not removed first | D04,D06,D08 |
| F-PURGE-2 | Fail OpenConnector revocation once, retry | Alias remains enumerated and blocked until successful purge | D04,D07,D08 |

## Signoff

A release signer records a table with columns `storyId / requiredPlatforms / evidenceIds / result / codeRevision / defectIssue?`. All 43 rows must have passed evidence for every listed platform, plus all applicable fault cards. A defect triggers rerun of its row, fault card and any case that consumes the changed contract; prior evidence from a different revision cannot be reused for changed behavior. Signoff also attaches the deployment process inventory proving that OpenMuse's old server and TaskWorker were not running.
