# On-device inference: assessment and open questions

Written 2026-10-04 against `Wiltermoodj/meaty` @ `6999e641` (local checkout at
`/home/ubuntu/meaty`, `main`). Verified by reading the source, not by taking
earlier notes on trust — one earlier claim ("no `.listen()` anywhere") turned out
to be **too strong** and is corrected below.

## The question

OpenMuse's model policy is "local when the device has a capable model, otherwise
API." `docs/SYNC.md` decided that **meaty hosts the endpoint and OpenMuse calls
it**, on the reasoning that meaty already owns on-device inference
(llama.rn / LiteRT / ExecuTorch) and the OpenAI-compatible client plumbing.

## What meaty actually is

A React Native app (iOS + Android) that runs models **in-process**:

| Concern | Implementation |
|---|---|
| Local inference | `src/services/llm.ts` (llama.rn/GGUF), `src/services/litert.ts` |
| Remote inference | `src/services/providers/openAICompatibleProvider.ts` — a **client** |
| Discovery | `src/services/networkDiscovery.ts` — probes Ollama :11434, LM Studio :1234, "Meaty Gateway" :7878 |
| Tool calling | `generationToolLoop.ts`, `llmToolGeneration.ts`, `openAIMessageBuilder.ts` |
| P2P sync | `src/services/sync/` — `react-native-tcp-socket` + `react-native-zeroconf` |

So: meaty **consumes** OpenAI-compatible servers and runs local models itself. It
is a capable *host* of inference and a capable *client* of an API.

## What it does not do

**It serves no inference endpoint.** Checked directly:

- No `http.createServer`, `net.createServer`, or `new Server(` anywhere in `src/`.
- No route handling `/v1/chat/completions`; every occurrence is a `fetch` to a
  *remote* base URL.
- The "Meaty Gateway" is a **URL** the app probes, not a server the app runs.
  `networkDiscovery.ts` comments it "runs on the user's laptop on the same LAN",
  and it appears in this repo only inside tests as `http://mac:7878`.

**Correction to the earlier note.** `docs/SYNC.md` and the project skill both
recorded "there is no `.listen()` in its `src/`, so nothing outside the app can
call its inference." That is right about *HTTP inference* and wrong as stated:
the sync subsystem does bind a TCP port (`transport.boundPort`, re-advertised
over mDNS in `nativeSync.ts`). So meaty *is* reachable on the LAN — it just
speaks its own sync protocol, not OpenAI. The conclusion for OpenMuse is
unchanged; the reasoning was wrong and would not survive being repeated.

**The gateway lives elsewhere.** A desktop component is referenced but is not in
this repository — there is no desktop package here. Whether it exists, is
private, or is planned is unknown from this checkout.

## The blocker, stated precisely

OpenMuse needs an **OpenAI-compatible HTTP endpoint on the device**, reachable
over the LAN, with SSE and tool-calling. Meaty has the inference and the
tool-calling; it does not have the serving. That half is either unimplemented or
in a repository we cannot see.

## Existing functionality relevant to this contract

Already in meaty, reusable as-is:

- GGUF and LiteRT inference, model download and lifecycle management.
- A complete OpenAI-compatible **client**: request building, SSE streaming,
  `tool_calls` assembly, a tool-execution loop.
- LAN discovery of OpenAI-compatible servers, with capability probing
  (`/v1/models`, llama.cpp `/props`).
- Capability derivation (vision / tools / thinking) for both local and remote
  models.

Missing, and required:

- Any listening HTTP server inside the app.
- `GET /v1/models` and `POST /v1/chat/completions` (SSE) routes.
- A service type to advertise via mDNS, plus the port.
- Tool-calling exposed over that endpoint (the loop exists internally; it must be
  reachable externally).

## Open questions — these block the work

Each needs an answer before implementation is meaningful.

1. **Where does the Meaty Gateway live?** Separate repository, private, or
   planned? This determines whether we extend meaty, contribute to it, or run our
   own endpoint.
2. **Who implements the endpoint?** If it belongs in meaty, that is a separate
   repo and a different authorization than "work on OpenMuse".
3. **Is the endpoint per-device or per-lan?** A phone-local endpoint is useless
   to a desktop client, and vice versa. Which is the requirement?
4. **Transport.** Plain HTTP on the LAN (needs TLS decision), or reuse the
   existing mDNS-discovered sync transport with a new message type?
5. **Authentication.** The sync transport has some trust model; an inference
   endpoint that runs tools on the user's machine needs a real one. What is
   acceptable?
6. **Model lifecycle.** Does meaty stream one already-loaded model, or must it
   download/load on first request? OpenMuse needs a cold-start failure mode.
7. **Minimum viable model.** Which model, and what context length? OpenMuse's own
   guidance is a 7B–9B floor for the chat model and more for task work; a phone
   may not sustain either.
8. **Tool-calling fidelity.** Does the endpoint stream tool calls incrementally,
   or emit them whole? OpenMuse's agent loop depends on the streaming shape.
9. **Is a phone-hosted endpoint even the goal?** Requirement 3 says device
   control is local, but the *model* need not be. If the phone is the client, a
   desktop-hosted endpoint may satisfy the policy just as well.
10. **Fallback contract.** `docs/SYNC.md` says fall back to remote, then API.
    Confirm the probe/timeout budget, since `networkDiscovery` already needed
    2000 ms after 500 ms produced false negatives.

## Recommendation

**Build the OpenMuse side against the documented contract, as decided** — a
provider that targets an OpenAI-compatible `/v1` endpoint, is configured per
device, and degrades to the existing model policy when nothing answers. That work
is useful regardless of the answers above: it is the same shape as the existing
`OPENAI_BASE_URL` / `OPENAI_API_FORMAT` local-LLM support, and it is testable
today against a fixture server.

Do not gate core agent functionality on the endpoint existing. When it does,
nothing in OpenMuse needs to change beyond configuration.

## Verification notes

- Claims above were checked against the working tree at `6999e641`. `git fetch`
  failed (no valid token in this environment), so **this is the local `main`, not
  necessarily the current remote** — re-verify before acting.
- Two questions I could not answer from this checkout and did not guess: where the
  gateway lives (1), and whether a mobile-hosted endpoint is the actual goal (9).