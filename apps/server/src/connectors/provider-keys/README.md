# provider-keys connector

Stores LLM provider API keys (AES-256-GCM vault envelopes) and lets the user
pick which model the agent runs on. The selection hot-applies in memory — no
server restart, no `.env` write.

## Model

- Multiple entries per provider are allowed; exactly one entry is the
  *selected* provider for the agent (owner-scoped `settings` record id
  `selected-provider`). Creating the first entry auto-selects it.
- `applyProviderSelection(db, config)` (`apps/server/src/engine/providers.ts`)
  loads the selected entry, decrypts the key in memory, and sets
  `config.model` + the matching `process.env` vars (`openai/...`,
  `anthropic/...`, or `google/...` prefix per the provider catalog).
  With no entries/selection it is a strict no-op: env-based config
  (`MODEL=openai/deepseek-chat` via `OPENAI_API_KEY`/`OPENAI_BASE_URL`) keeps
  working exactly as today.
- Startup wiring (integrator): `await applyProviderSelection(db, config);`
  once, after the Store is ready.

## Catalog

OpenAI, Anthropic, Google Gemini, DeepSeek, xAI, Mistral, Custom
(OpenAI-compatible), Local (Ollama at `http://127.0.0.1:11434/v1`, model
`qwen3:1.7b`, no key). All run through CopilotKit's model prefixes; OpenAI,
DeepSeek, xAI, Mistral, Custom, and Local use `openai/...` with a per-provider
baseUrl, Anthropic uses the native `anthropic/...` prefix, Google uses
`google/...`.

## Routes (mounted at /api/provider-keys)

- `GET /catalog` — provider catalog (display name, defaults, key requirements)
- `GET /selection` — currently selected entry (metadata) or null
- `GET /` — entries (metadata only: id, provider, label, model, baseUrl,
  hasKey, keyHint `…abcd`, selected, timestamps)
- `POST /` (201) — create; `apiKey` write-only, required except `local`
- `POST /:id/select` — select + hot-apply
- `POST /:id/test` — minimal authenticated `GET {baseUrl}/models` probe
  (15s timeout, sanitised diagnostics, zero generation cost)
- `PATCH /:id` — update; key rotation via `apiKey`
- `DELETE /:id` — delete; deleting the selected entry clears the selection
  and restores the pre-apply in-memory env/config snapshot

## Security

Keys are decrypted only inside a single operation (`withKey`) and wiped after.
Responses carry metadata only; the key hint (`…abcd`) is computed at
create/rotation time. The test probe calls only the provider's own `/models`
endpoint; provider error bodies are truncated to 400 chars with control
characters stripped, never rendered raw.

## Local LLM (Ollama on this box)

The `local` provider needs no API key. Runtime: Ollama served by the existing
`ollama.service` systemd unit (enabled, restart-always) bound to
`127.0.0.1:11434` only — nothing is exposed off-box. Installed model:
`qwen3:1.7b` (Q4_K_M, ~1.4 GB on disk, ~1.8 GB resident with a 4k context).
It serves the OpenAI-compatible `/v1` API the engine expects, so the local
entry runs through the `openai/...` SDK prefix with an inert placeholder key.

Catalog defaults are env-configurable (no code changes, no secrets):

- `LOCAL_LLM_BASE_URL` — default `http://127.0.0.1:11434/v1`
- `LOCAL_LLM_MODEL` — default `qwen3:1.7b`

To switch models: `ollama pull <model>` on the box, then either set
`LOCAL_LLM_MODEL` before (re)starting the server or edit the entry's Model
field in the dashboard (Models & API keys → Edit) — the per-entry value in
the vault always wins. The dashboard Test button probes `{baseUrl}/models`
(no generation, zero cost); if Ollama is down it reports the configured base
URL so you know exactly where it looked.
