# v3 review resolution for the OpenMuse–OpenBot plan

> This records how the user's detailed review changed the plan. The authoritative v4 sources are the [Ticket catalog](2026-10-12-openmuse-openbot-ticket-catalog-v4.md), [contracts and fixtures](2026-10-12-openmuse-openbot-contracts-v4.md), and [acceptance matrix](2026-10-12-openmuse-openbot-acceptance-v4.md). The approved planning Tickets are [published](2026-10-12-openmuse-openbot-published-v4.md).

| Reviewed v3 item | v4 change | Contract / evidence |
| --- | --- | --- |
| 01–02 source layout and unknown copied-tree delta | B01 inventories every path/hash/intent; B02 Web submodule build; B03 native exports; B04 removes copy only after mapped adaptations resolve. Exact checkout and build commands fixed. | Contract §1; S41 |
| 03 Web login and Bot provisioning too broad | I01 existing-session read, I02 atomic private Bot creation with unique owner/template constraint, I03 first-entry UI. | Contract §2; S03/S06 |
| 04–05 native cache and expiry vague | I04/I05 session restore and 401; I06–I08 platform logout; current and target state locations listed. | Contract §2 table; S04/S05 |
| 06 template rules vague | I09 uses managed/user field table, v1→v2 grant fixture and concurrent apply rule. | Contract §2; S07/S08 |
| 07 baseline chat too broad | C01 one Channel; C02/C03 management; C04/C05 run lifecycle; C06 cards; C07 observable delegation after Task runner. | Contract §3; S10–S14 |
| 08–10 archive/replay/cards vague or overblocked | Archived filter retains Thread; e1/e2/e3 cursor fixture and terminal states; named tool-event list; C06 depends directly on C01. | Contract §3; S10/S13/F-STREAM-1 |
| 11 native multi-Channel dependency missing | C08 and C09 separate iOS/Android, each blocked by C02/C03/C04/C05/C06. | S10–S13 on I/A |
| 12–13 computer control underspecified | K01 auth, K02 preview, K03 lease/Policy state machine, K04 UI. Competing claims and late input are explicit. | Contract §3; S38/F-CONTROL-1 |
| 14–15 OAuth breadth and failures | G01 Gmail callback, G02 callback faults, G03 Calendar consent, G04 refresh, G05 disconnect, G06 status UI. State/nonce/generation matrix fixed. | Contract §4; S15/S16/F-OAUTH-1/2 |
| 16–19 domain data/paging/time zone vague | M01–M04 and A01–A03 use fixed DTOs, sort/cursor bounds, DST/all-day examples. Gmail read depends G01, not Calendar grant. | Contract §4; S17/S18 |
| 20–21 File scope/semantics vague | F01 upload/list, F02 content auth, F03 mutations, F04/F10 native clients; SHA-256, size, version, tombstone fixed. | Contract §5; S23 |
| 22–24 PDF and transfer underspecified | F05 inspection, F06 immutable fill/Web view, F07/F08 native viewers, F09 workspace transfer; type/limit/collision/retry fixtures fixed. | Contract §5; S25–S27 |
| 25–28 Reviewed action too broad | R01 shared prefactor with fake executor; R02–R04 Gmail send/stale/uncertain; R05–R08 Calendar create/update/delete/uncertain. | Contract §6; S19–S21/F-MAIL-1/2/F-CAL-1 |
| 29–30 Task base too broad | T01 queued UI/store then T02 one-step existing WorkQueue/headless runner, T03 typed step/evidence; lease system reused. | Contract §7; S28 |
| 31–34 control/recovery vague | T04 cancel, T05 pause/resume, T06 retry, T07 lease loss, T08 input wait, T09 Plan; legal transitions and three-step fixture fixed. | Contract §7; S31/S33/S34 |
| 35–37 Monitor→notification gap | T10 schedule, T11 cursor/dedupe/backoff, T12 event-keyed notifications blocked by T11. | Contract §7; S32/S35/S37 |
| 38–41 finance/document examples absent | T13 exact three-row totals and bad-row refusal; T14 owner-scoped idempotent import; T15 wait/filled version; T16 reply target/attachment binding. | Contracts §§5–7; S24/S29/S30 |
| 42–44 subjective personal-context checks | P01/P02/P03 use explicit Goal/Idea/Memory fields, exact ID retrieval, another-Bot refusal and delete behavior. | Contract §7; S36 |
| 45 Activity missing stale dependencies | V01 blocked by R03/R04/R06/R08 and K03; V02 adds notifications. Typed source/status/action table fixed. | Contract §8; S22 |
| 46–48 deletion and restoration incomplete | D01 auth fence, D02 work stop, D03 File/Google closure, D04 manifest, D05 full recoverable-set restore. Module lifecycle hooks are required. | Contract §9; S39/S40 |
| 49–50 unsafe purge order | D04 records external keys before cleanup; D06 File bytes and D07 connector grants run before D08 relational removal; D09 checks backups/retry visibility. | Contract §9; F-PURGE-1/2 |
| 51 deployment breadth/fault visibility | O01 API/DB, O02 connector/callback, O03 computer limits, O04 worker limits, O05 fault signals. Exact first-release values proposed. | Contract §10; S41–S43 |
| 52–65 unexecutable matrices | Replaced by 43 story cases plus 12 fault cards with fixtures, steps, expected UI/API/state, evidence IDs, owner routing and rerun rule. They are release gates, not Code Agent implementation Issues. | Acceptance matrix |

## Publication rule

The v4 catalog contains planning Tickets. A one-context file-level writing plan is still required for each Ticket before it may receive `ready-for-agent`. This is intentional: exact owned files and test commands cannot be safely fixed for ninety-plus future changes before earlier interfaces and copied-tree differences land. A file-level plan must name the integrated predecessor checkpoint and consume the contract version it was written against.

## Approved v4 planning defaults

The approved v4 contract fixes testable first-release defaults that were not explicitly decided in Spec #1: 20 MiB generic File upload, 10-minute OAuth state TTL, Mail page 25/max 100, Calendar page 50/max 100, 20 concurrent computers, 15-minute computer idle stop, 2 GiB per-Bot disk, four Task workers, 300-second first Task deadline, and the Monitor backoff sequence. They are **planning baselines**, not claims about existing code; a capacity or implementation Ticket may change them with reviewed evidence and updated acceptance cases.
