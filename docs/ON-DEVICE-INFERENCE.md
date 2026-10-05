# On-device inference: assessment and open questions

**Rewritten 2026-10-04 after a version correction.** The first version of this
document was written against a local `meaty` checkout **286 commits behind**
GitHub and reached the wrong conclusion, because the feature it said did not exist
had landed in the gap. Both the assessment and the freshness caveat are below; the
caveat was not a sufficient defence — a stale read that is labelled stale is still
a wrong answer, and the "re-verify before acting" note sat at the bottom of a
document whose body was confidently wrong.

Current source: `Wiltermoodj/meaty` @ `3e95e5ac` (`origin/main`), fetched this
session with `GITHUB_TOKEN`. All claims below are against that commit.

## Summary

**The endpoint exists and implements the contract.** Meaty ships
`src/services/localAiServer.ts`: `GET /health`, `GET /v1/models`,
`POST /v1/chat/completions` (SSE and non-streaming), plus audio transcription,
vision and embeddings.

**Two blockers, and the second is the larger.** (1) OpenMuse runs all inference
in `apps/server` and cannot reach a phone's loopback. (2) The served endpoint
does not support tool-calling at all, and OpenMuse's agent *is* a tool loop. Both
must be resolved; neither is a configuration change on our side.

## What meaty provides

| Requirement (from `docs/SYNC.md`) | Status |
|---|---|
| `/v1/chat/completions`, SSE | ✅ implemented (`localAi/chatCompletionHandler.ts`) |
| Reachable so another app can use it | ⚠️ **loopback only — see below** |
| Tool-calling support | ❌ **not exposed on the endpoint** — see below |
| OpenAI-compatible client plumbing | ✅ pre-existing |
| Model lifecycle | ✅ GGUF + LiteRT, download and load managed in-app |

Authentication is `Authorization: Bearer` plus two headers: `X-Ecosystem-App`
(validated against a canonical app registry in `@wiltermoodj/contracts`) and
`X-Priority`. `/health` is unauthenticated; everything else is.

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

## Open questions — these block the work

1. **(a), (b) or (c)?** Everything else depends on this.
2. **Would meaty accept a `0.0.0.0` bind?** If (a), that is a change to another
   repository and needs agreement there.
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
7. ~~Tool-calling fidelity.~~ **Answered 2026-10-04, and it is the second
   blocker.** The served endpoint does not support tool-calling at all.
   `localAi/chatCompletionHandler.ts` reads `body.stream` and nothing else —
   no `tools`, no `tool_choice` — and `createSseStream` emits only
   `delta: { content }`. There is no mention of tools anywhere under
   `src/services/localAi/`. Meaty *has* a tool loop (`generationToolLoop.ts`,
   `openAIMessageBuilder.ts`), but it runs inside the app for its own chat UI and
   is not reachable over HTTP.

   OpenMuse's agent is a tool loop. A chat-completions endpoint that cannot call
   tools is a completion endpoint, not an agent endpoint, so **(a), (b) and (c)
   all fail without this** too. It is the larger of the two gaps.
8. **Fallback budget.** `docs/SYNC.md` says fall back to remote, then API. Meaty's
   own discovery needed 2000 ms after 500 ms produced false negatives, so do not
   probe tighter than that.
9. **Does the server hold the model lease?** Requirement 4 runs concurrent roles;
   one phone serves one model, and the device work loop is deliberately
   one-task-at-a-time. Worth deciding explicitly rather than discovering under
   load.

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

- Verified against `meaty` `origin/main` @ `3e95e5ac`, fetched this session with
  `GITHUB_TOKEN`. Ambient git credentials fail with 401 — use the token, as
  OpenMuse already does for its own pushes.
- The local checkout at `/home/ubuntu/meaty` is at `6999e641` (PR #240); current is
  PR #377. It has **not** been fast-forwarded, so anything assessed from that
  working tree needs re-checking.
- Not determined from the source, and not guessed: whether OpenMuse is an intended
  consumer of this daemon (question 5).
- Question 7 (tool-calling) was open in the first draft and has since been
  answered by reading the handler — see the struck-through entry above. The
  lesson stands: two of the ten questions were answerable from the source, and
  asking the user questions the code could answer is its own failure mode.