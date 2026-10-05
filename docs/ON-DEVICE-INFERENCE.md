# On-device inference: assessment and open questions

**Rewritten 2026-10-04 after a version correction.** The first version of this
document was written against a local `meaty` checkout **286 commits behind**
GitHub and reached the wrong conclusion, because the feature it said did not exist
had landed in the gap. Both the assessment and the freshness caveat are below; the
caveat was not a sufficient defence — a stale read that is labelled stale is still
a wrong answer, and the "re-verify before acting" note sat at the bottom of a
document whose body was confidently wrong.

Current source: `Wiltermoodj/meaty` — `origin/main` is at `13f9a59b`, and PR #380's
branch `feat/localai-tool-calling` is at `ccc6d1d3` (merge-resolved, mergeable);
the OpenMuse-local checkout at `/home/ubuntu/meaty` matches the latter. Both were
checked this session with `GITHUB_TOKEN`. Tool-calling claims below are against the
PR #380 implementation; everything else is against `13f9a59b`. See "Verification
notes": PR #380 was open with merge conflicts that are now resolved and pushed.

## What and where: Meaty

**`Wiltermoodj/meaty`** — <https://github.com/Wiltermoodj/meaty> — a local-first,
privacy-preserving meeting-transcription and AI assistant. React Native
(Android primary, iOS secondary), running Whisper STT, speaker diarization and
LLM inference (`llama.rn`, LiteRT, ExecuTorch) **on the device**.

Its own docs, worth reading before touching this area:

- `knowledge/planning/on-device-ai-command-center-plan.md` — the initiative that
  built the localhost daemon this integration depends on. Status **complete**.
- `knowledge/planning/agent-tool-calling-local-ai-plan.md` — **the plan for the
  tool-calling feature**, authored 2026-10-04 in support of this integration.
  <https://github.com/Wiltermoodj/meaty/pull/378> (branch
  `feat/agent-tool-calling-local-ai`); that PR is **merged** to `main` (plan
  only). The implementation is [PR #380](https://github.com/Wiltermoodj/meaty/pull/380).
- `knowledge/planning/README.md` — index; non-trivial plans must be registered
  there.
- `AGENTS.md` — the repo's mandatory agent workflow (stubs tooling, strictness).

Other things to know before assessing it:

- **A local checkout may be hundreds of commits stale.** Use `GITHUB_TOKEN` for
  fetch/push; ambient git credentials return 401.
- **Its HTTP listener is native code** (Kotlin `NanoHTTPD`, Swift `NWListener`)
  bridged into JS, so grepping `src/` for `createServer` finds nothing even on a
  current tree. Check `android/.../daemon/` and `ios/` too.
- **It is not a library OpenMuse imports.** It is a separate app that serves an
  HTTP contract. There is no code-level dependency in either direction.

## Summary

**The endpoint exists and implements the contract.** Meaty ships
`src/services/localAiServer.ts`: `GET /health`, `GET /v1/models`,
`POST /v1/chat/completions` (SSE and non-streaming), plus audio transcription,
vision and embeddings.

**One blocker remains, and it is the larger.** (1) OpenMuse runs all inference in
`apps/server` and cannot reach a phone's loopback. (2) Tool-calling was the second
blocker; it is **resolved** — implemented (non-streaming) in
[PR #380](https://github.com/Wiltermoodj/meaty/pull/380), which was open with merge
conflicts against `main` (whose `dec25f93` grew a second, divergent tool-calling
impl); those were reconciled in favour of PR #380 and pushed, so the PR is
mergeable. The contract it imposes: `stream: true` with `tools` returns 400 (use
non-streaming for tool turns), and `tool_choice` must be `"auto"` or omitted
(`"required"`/named is refused). Neither is a config change on our side, but (2) is
no longer a gap.

## What meaty provides

| Requirement (from `docs/SYNC.md`) | Status |
|---|---|
| `/v1/chat/completions`, SSE | ✅ implemented (`localAi/chatCompletionHandler.ts`) |
| Reachable so another app can use it | ⚠️ **loopback only — see below** |
| Tool-calling support | ✅ implemented (non-streaming), [PR #380](https://github.com/Wiltermoodj/meaty/pull/380) |
| OpenAI-compatible client plumbing | ✅ pre-existing |
| Model lifecycle | ✅ GGUF + LiteRT, download and load managed in-app |

Authentication is `Authorization: Bearer` plus two headers: `X-Ecosystem-App`
(validated against a canonical app registry in `@wiltermoodj/contracts`; `openmuse`
is registered as an app alias) and `X-Priority`. `/health` is unauthenticated;
everything else is.

## The blocker, precisely

The daemon binds **`127.0.0.1` only**, on both platforms:

- Android: `class DaemonHttpServer(port: Int) : NanoHTTPD("127.0.0.1", port)`
  (`android/app/src/main/java/ai/meaty/daemon/LocalAiDaemonService.kt:83`) — the
  only `NanoHTTPD` instantiation in the repo.
- iOS: `NWEndpoint.hostPort(host: "127.0.0.1", port: 11435)`
  (`ios/LocalAiDaemonModule.swift:30`).

Port `11435`.

OpenMuse runs **all** model inference in `apps/server`, on a machine that is not
the phone. `device-protocol.ts` shows device work is a client of the server API —
claim, heartbeat, report — never a local model call. A loopback endpoint on the
phone is therefore unreachable from the process that does the inferencing, by
construction.

This is not a small gap. It is one of three architectures:

- **(a) meaty binds `0.0.0.0`**, OpenMuse reaches it over the LAN. Requires a
  change to meaty, plus real auth and TLS for an endpoint that runs tools on the
  user's files and accounts. Loopback-only is likely deliberate.
- **(b) OpenMuse gains an on-device inference client** in `apps/mobile` and runs
  device-local work on-device. A new execution path, not a config knob, and it
  collides with vision requirement 4 (concurrent specialist roles), which today
  runs server-side.
- **(c) the phone proxies** — relaying between the server and its own loopback
  endpoint. Keeps orchestration server-side while the model runs on the phone.

(c) is the least invasive and the only one needing no change to meaty. All three
are product decisions about where the agent runs, not implementation details.

## Decisions (2026-10-04)

Four settled with the user. Superseding the open questions below.

1. **Reachability: (c), the phone proxies.** The server orchestrates; the phone
   relays to its own `127.0.0.1:11435`. Chosen over a LAN bind (needs a change to
   meaty and exposes an inference endpoint to the network) and over an on-device
   inference client (a second agent execution path, colliding with vision
   requirement 4). *Consequence:* OpenMuse must build a streaming client on the
   phone — `api.request()` buffers whole responses today — and a relay path in the
   server.
2. **Routing: the server decides per request**, falling back to remote-then-API
   when the phone is asleep or unreachable. Never unconditionally through the
   phone. *Consequence:* a reachability probe and a fallback deadline. Do not
   probe tighter than meaty's own 2000 ms discovery budget, which was raised from
   500 ms after false negatives.
3. **Tool-calling.** Implemented (non-streaming) in [PR #380](https://github.com/Wiltermoodj/meaty/pull/380)
   (branch `feat/localai-tool-calling`). The plan shipped as
   [PR #378](https://github.com/Wiltermoodj/meaty/pull/378) (merged to `main`); PR
   #380 was open with merge conflicts against `main`, which had grown a second,
   divergent implementation (`dec25f93` — see Verification notes); the conflicts
   were reconciled in favour of PR #380 (it matches plan §5 and this contract) and
   pushed, so the PR is mergeable. The contract PR #380 imposes: `stream: true`
   with `tools` → 400 (non-streaming for tool turns); `tool_choice`
   `required`/named → 400 (send `"auto"` or omit). This was the gate everything
   else waited on; it is closed.
4. **Whose tools: standard OpenAI semantics.** The served endpoint accepts the
   *request's* tools and emits `tool_calls`; the caller executes them and sends
   results back. Meaty does **not** expose its internal registry to remote
   callers. This matters: `registry.ts` tools reach the device and UI stores
   (`useChatStore`, `useAppStore`), and running those because a network client
   asked would be a very different risk from echoing a tool call back.

### What the meaty-side proposal became

`localAi/chatCompletionHandler.ts` now parses `body.tools` / `body.tool_choice`,
gates on model capability (refuses `stream: true` + `tools` and `required`/named
with 400), and emits OpenAI `tool_calls` non-streaming. It does **not** route
through `generationToolLoop` — that loop is coupled to `useChatStore` /
`useAppStore` / `useRemoteServerStore` and runs inside the app for its own chat UI.
Instead the served path is `handleToolCompletion` → `llmService.generateResponseWithTools`,
which reuses `src/services/tools/registry.ts` for schema only and never touches the
stores.

*Open question, not decided:* whether OpenMuse may propose further changes to
`Wiltermoodj/meaty` as a contribution, and whether that repo accepts outside
contributions. Check before assuming a PR is appropriate.

## Open questions — still open

1. ~~**(a), (b) or (c)?**~~ **Answered: (c)**, above.
3. ~~**Would meaty accept a `0.0.0.0` bind?**~~ **Moot** under (c) — no bind
   change is needed.
3. **Where does the ecosystem token come from?** OpenMuse needs the same token
   meaty validates against. The default is a dev constant
   (`omnibutler-local-dev-token`), which is not a production secret; provisioning
   is unsolved on both sides.
4. **Is `X-Ecosystem-App` required, and under what name?** It is validated against
   a canonical registry. Does OpenMuse have an entry, or does one need adding?
5. **Is OpenMuse an intended consumer?** The daemon is described as serving
   "sibling ecosystem applications." This repository does not settle it.
6. **Model viability.** Meaty serves whatever the device has loaded. OpenMuse's
   guidance is a 7B–9B floor for chat and more for task work. What can the target
   phone hold, and what is the cold-start behaviour with nothing loaded?
7. ~~Tool-calling fidelity.~~ **Answered 2026-10-05** — tool-calling is on the
   served endpoint, implemented (non-streaming) as
   [PR #380](https://github.com/Wiltermoodj/meaty/pull/380).
   `localAi/chatCompletionHandler.ts` parses `body.tools` / `body.tool_choice`,
   gates on model capability (refuses `stream: true` + `tools` and `required`/named
   with 400), and emits OpenAI `tool_calls`; the caller executes them. It does **not**
   route through `generationToolLoop` (coupled to the app's own chat-UI stores) —
   see Decision 3. Meaty *has* a tool loop (`generationToolLoop.ts`,
   `openAIMessageBuilder.ts`) for its own chat UI; that is the unrelated,
   meaty-internal path.

   **Do not build a streaming tool-calling client:** send `stream: false` for tool
   turns. The "larger gap" framing from 2026-10-04 is obsolete; reachability is now
   the only blocker (see Summary).
8. **Fallback budget.** `docs/SYNC.md` says fall back to remote, then API. Meaty's
   own discovery needed 2000 ms after 500 ms produced false negatives, so do not
   probe tighter than that.
9. **Does the server hold the model lease?** Requirement 4 runs concurrent roles;
   one phone serves one model, and the device work loop is deliberately
   one-task-at-a-time. Worth deciding explicitly rather than discovering under
   load.

## Sequencing

**(c) is settled and tool-calling is implemented (PR #380), so only OpenMuse-side
work remains:**

1. **Provider wiring** — point `OPENAI_BASE_URL` at the relay host, per-device
   model configuration, and the fallback budget. Buildable **now** against PR #380:
   send `stream: false` for tool turns and `tool_choice` unset.
2. **The server's relay route and per-request routing decision**, with the
   reachability probe and remote-then-API fallback.
3. **A streaming client on the phone** — for normal chat text only.
   `api.request()` buffers whole responses, and relaying token-by-token needs
   `response.body` streaming plus a long-lived connection the OS will not kill
   mid-run. (Tool turns are non-streaming, so this step is for chat text, not for
   tool execution.)

PR #380 is the target that step 1 waited on; do not build a streaming
tool-calling client, or the client gets built twice.

## Existing OpenMuse functionality this would build on

- `OPENAI_BASE_URL` + `OPENAI_API_FORMAT=chat-completions` already support any
  OpenAI-compatible server, with `defined()` normalization for
  `exactOptionalPropertyTypes` (`packages/backends/src/strict-optional.ts`).
- Per-device model routing: `agent-settings:device-models:{deviceId}`, settable via
  `PATCH /api/agent/device-models`.
- `CHAT_TOOL_ALLOWLIST` and per-device overrides, for small-model tool surfaces.
- Step budgets per device (`chatMaxSteps`, `taskMaxSteps`).

So the *provider* side is largely pointing `OPENAI_BASE_URL` at a reachable host.
The hard part is reachability and the execution path.

## Superseded: what the previous version claimed

Kept because the error is instructive, not because any of it is true.

It claimed meaty "does not serve an inference endpoint," on three checks that
were all performed correctly against the wrong commit: no `http.createServer` in
`src/`, every `/v1/chat/completions` a `fetch` to elsewhere, and the "Meaty
Gateway" being a probed URL rather than a served one. All true at `6999e641`.
`localAiServer.ts` did not exist yet — the listener is a **native** daemon
(Kotlin `NanoHTTPD`, Swift `NWListener`) bridged into JS, so even a current tree
would not have shown `createServer` in `src/`. Grepping the wrong directory for
the wrong implementation is a way of getting a clean result that means nothing.

It also carried a self-correction I was proud of: that an earlier "no listener at
all" claim was too strong, because the sync subsystem does bind a TCP port. That
correction was true, and was still consistent with a wrong conclusion, because it
only checked the one thing that happened not to have changed.

## Verification notes

- Verified against `meaty`: `origin/main` @ `13f9a59b` and PR #380's branch
  `feat/localai-tool-calling` @ `ccc6d1d3` (merge-resolved, mergeable), both
  fetched this session with `GITHUB_TOKEN`. Ambient git credentials fail with 401
  — use the token, as OpenMuse already does for its own pushes. PR #380's branch
  was fast-forwarded to `ccc6d1d3` (the conflict-resolution commit) and pushed; the
  PR is now mergeable on GitHub — not yet merged to `main`.
- `tsc --noEmit` is clean on the reconciled tree.
- PR #380's tool-calling suites (`localAiServer`, `localAiToolCalling`,
  `localAiToolAdapter`, `localAiToolChoice`) are green — 72 tests, with two
  `localAiServer` assertions reconciled to PR #380's contract. The branch's
  mutation harness `scripts/mutation-localai-tools.sh` reports
  `MUTATION_KILLED=12 SURVIVED=0` — the tests bite, not just pass.
- **No regressions from the merge.** Full `__tests__/unit/services` on the
  reconciled tree fails 13 suites / 68 tests — but those are the **same** 13 suites
  / 68 failures on clean `origin/main @ 13f9a59b` (jules-bot churn on networking,
  model residency, auth and parsers). The merge introduced none; PR #380 only
  *adds* green suites.
- Reconciled the two tool-calling implementations: `main` grew `dec25f93` (PR #381,
  jules-bot), which *supports* `stream: true` + `tools` and `tool_choice`
  `required`/named — contradicting plan §5 and this contract. Kept PR #380's
  implementation (matches plan §5 and this contract); kept main's *independent*
  work (`types.ts` at `6cae1e3d`, `modelResidency`, `localAiServer.ts`,
  `offgrid-sync-shim.ts`, `debounce.ts`).
- Meaty-internal defect, **not** in OpenMuse's path: a duplicate-message bug in
  the chat-UI store path (`onFinalResponse` + `flushTokenBuffer` two-writer on
  `generationServiceHelpers.ts` / `generationService.ts`). The served endpoint
  routes through `handleToolCompletion` → `llmService.generateResponseWithTools`,
  not `generationToolLoop`, so it is unaffected. Unfixed; flagged so it is not
  rediscovered.
- The local checkout at `/home/ubuntu/meaty` is on PR #380's branch @ `ccc6d1d3`.
- Not determined from the source, and not guessed: whether OpenMuse is an intended
  consumer of this daemon (question 5).
- Question 7 (tool-calling) was open in the first draft and is answered above:
  tool-calling is implemented (PR #380). Lesson stands: two of the ten questions
  were answerable from the source, and "shipped/landed" is a claim that must be
  checked against `merged_at` (PR #380 is implemented and mergeable, but open).