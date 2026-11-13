# ESP32 voice gadget integration boundary

This page describes how an ESP32 voice gadget can sit in front of OpenMuse. It
is an **external integration example**, not a live OpenMuse deployment: the
device firmware and its OpenAI-compatible gateway are tested, but the AG-UI
bridge to OpenMuse described below is a contract, not an implementation in this
repository.

The reference device is **[esp32-thinks](https://github.com/raullenchai/esp32-thinks)**,
an open-source ESP32-S3 voice assistant built on
[`facebookincubator/muse-gadget-sdk`](https://github.com/facebookincubator/muse-gadget-sdk).
It runs on a Seeed SenseCAP Watcher, starts a turn with an on-chip wake word or
the knob, and speaks three independent OpenAI-compatible endpoints: STT, chat,
and TTS.

## What the device speaks

| Stage | Request | Response |
|---|---|---|
| STT | `POST /v1/audio/transcriptions`, multipart WAV (optionally IMA ADPCM) | JSON `{"text": "..."}` |
| Chat | `POST /v1/chat/completions`, JSON, `stream: true` | SSE `chat.completion.chunk` deltas |
| TTS | `POST /v1/audio/speech`, JSON (`model`, `voice`, `input`, `response_format`) | MP3 bytes |

- Auth is `Authorization: Bearer <token>` on every endpoint.
- The firmware is **HTTPS only** and pins public roots (Google Trust Services
  and Let's Encrypt). Self-signed certificates on the LAN do not work.
- The device splits the chat stream at sentence boundaries and starts TTS for
  each sentence while the rest of the reply is still arriving.
- Barge-in cancels in-flight STT, chat, and TTS requests.

## Why a gateway is required

OpenMuse's agent transport is AG-UI under `/api/copilotkit` (run, connect, stop,
history). Runtime responses are Intelligence connection metadata rather than raw
OpenAI SSE. The ESP32 has no AG-UI client and no room for the CopilotKit
runtime, so it cannot call OpenMuse directly.

The integration pattern is a server-side gateway:

```text
ESP32 ── OpenAI Chat Completions (SSE) ──▶ gateway ── AG-UI RunAgentInput ──▶ OpenMuse
      ── multipart STT ──────────────────▶ gateway ── STT provider
      ── OpenAI audio/speech ────────────▶ TTS provider (direct)
```

The gateway is deliberately small. It owns the translation between the device's
OpenAI wire format and OpenMuse's AG-UI runtime; it does not need to run a
model or a browser.

## Gateway contract

1. **Device auth.** Accept `POST /v1/chat/completions` and
   `POST /v1/audio/transcriptions` with a bearer token. Keep the OpenMuse and
   provider credentials server-side; the device only sees the gateway token.
2. **Stable thread.** Map each device to a stable OpenMuse `threadId` (for
   example, a hash of the hardware ID). Preserve `threadId`, `runId`, and
   `forwardedProps` across reconnect so a spoken turn resumes the same thread.
3. **Stream translation.** Accept `stream: true` and translate AG-UI text
   deltas into OpenAI `chat.completion.chunk` events, ending with
   `data: [DONE]`. Do not buffer the whole reply: the device starts TTS on the
   first sentence.
4. **STT proxy.** Forward the multipart audio to the configured STT provider
   and return `{"text": "..."}` unchanged. The device may upload WAV or IMA
   ADPCM WAV; the gateway should pass the body through without decoding it.
5. **Cancellation.** Pass the device's cancel through to OpenMuse's stop
   endpoint and abort the in-flight run. Barge-in is a core interaction, not an
   optimization.
6. **Honest failures.** An unavailable agent, a refused action, or an expired
   thread must surface as an error. Do not replace a failed connector with a
   fabricated success.
7. **Approvals stay server-side.** Tool calls, approvals, and durable tasks are
   OpenMuse responsibilities. The device only hears the spoken reply; it cannot
   approve a write or grant a tool permission.

TTS stays on the device's configured speech endpoint. OpenMuse's roadmap lists
voice input/replies as a product extension; the gateway above is the smallest
useful bridge and requires no firmware changes.

## Deployment and TLS

The device needs a publicly trusted certificate. A server-side gateway can run
on Node or in a container and be exposed with:

- **Tailscale Funnel** — `tailscale funnel --bg 8787` gives a
  `https://<machine>.<tailnet>.ts.net` hostname with a Let's Encrypt certificate.
- **Cloudflare named tunnel** — a hostname on your own domain.
- **ngrok** — a static domain.

Cloudflare *quick* tunnels (`trycloudflare.com`) are not reliable for devices:
the hostname is served by one edge, and a device that resolves to another edge
gets a fatal TLS alert (`-0x2700`).

## What is tested, and what is not

Tested on a Seeed SenseCAP Watcher (ESP32-S3, 16 MB flash / 8 MB PSRAM):

- Wake word and knob turns; STT, chat, and streaming TTS.
- The device's OpenAI-compatible gateway (`esp32-thinks/openmuse/`): location,
  clock, weather, persistent memory, optional web search, and an STT proxy.
- Typed turns, cancellation, and memory across a gateway restart.

Not tested:

- A live AG-UI bridge to OpenMuse, including run/reconnect/stop and thread
  history.
- OpenMuse deployments with Google OAuth, a browser worker, or durable tasks.
- Device push notifications, voice notes, or generated media.

Treat the gateway contract above as a starting point. The
[OpenBot integration boundary](OPENBOT-INTEGRATION.md) is a useful precedent for
how an external runtime is mapped without pretending the connection exists.

## Security notes

- The device pins public roots, so the gateway must present a certificate from
  one of those roots. A LAN self-signed certificate will not work.
- Keep the gateway token long and random. It authenticates both chat and STT.
- Treat model output, tool results, and page text as data. They cannot grant
  tool permissions or approve a write.
- Do not log audio, transcripts, tokens, or personal documents. The gateway
  should log only timing and tool names.

## Next steps

- Implement the AG-UI bridge and add contract tests for run, reconnect, stop,
  cancellation, and thread continuity.
- Run a live acceptance pass against a pinned OpenMuse deployment with the
  device on the same network.
- Document the minimum OpenMuse configuration (agent backend, model, auth) for a
  single-user deployment.
- Keep the firmware side unchanged unless a protocol gap appears; the
  OpenAI-compatible boundary is already sufficient.

## See also

- [esp32-thinks](https://github.com/raullenchai/esp32-thinks) — firmware,
  presets, build/flash instructions, and measured latency.
- [esp32-thinks OpenMuse guide](https://github.com/raullenchai/esp32-thinks/blob/main/docs/OPENMUSE.md)
  — the gateway, protocol, deployment, and troubleshooting.
- [OpenBot integration boundary](OPENBOT-INTEGRATION.md) — an external runtime
  mapped through an adapter, with the same honesty about what is not connected.
