/**
 * LLM provider catalog + runtime provider selection.
 *
 * The provider-keys connector stores per-user LLM API keys (vault-encrypted).
 * This module holds the static provider catalog and the hot-apply logic that
 * switches the running agent to the selected provider WITHOUT restarting the
 * server and WITHOUT writing to .env.
 *
 * INTEGRATOR NOTE (one line, at server startup after the Store is ready):
 *   await applyProviderSelection(db, config);
 * When no provider-keys entries/selection exist the call is a strict no-op,
 * so env-based config (e.g. MODEL=openai/deepseek-chat via OPENAI_API_KEY /
 * OPENAI_BASE_URL) keeps working exactly as today.
 *
 * SDK wiring (verified against @copilotkit/runtime v1.70.1
 * dist/agent/index.mjs resolveModel): BuiltInAgent accepts
 *   openai/<model>    -> OPENAI_API_KEY / OPENAI_BASE_URL
 *   anthropic/<model> -> ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL  (native)
 *   google/<model>    -> GOOGLE_API_KEY / GOOGLE_GENERATIVE_AI_BASE_URL (native)
 * Every provider in the catalog maps onto one of these three prefixes.
 * OpenAI/DeepSeek/xAI/Mistral/Custom/Local all expose OpenAI-compatible
 * /v1 endpoints, so they run through the openai/... prefix with a
 * per-provider baseUrl + key. Google Gemini exposes an OpenAI-compatible
 * /v1beta/openai endpoint and rides the same openai/... path; only Anthropic
 * uses its native prefix (its /v1/models probe needs x-api-key auth).
 * There is intentionally no "stored only" provider: every catalog
 * entry is agent-chat capable.
 *
 * TRACK D (provider gaps): Google keeps its native google/... SDK prefix
 * with the native Generative Language base URL (https://generativelanguage.
 * googleapis.com/v1beta) — the OpenAI-compatible /v1beta/openai URL does not
 * match the native prefix's REST contract. A stored secret is decrypted
 * whenever one exists (custom endpoints allow optional keys), and the
 * OpenAI-compatible runtime path uses an inert "none" key for keyless
 * selections (local Ollama, keyless custom) because the SDK requires a
 * non-empty key string even when the endpoint ignores auth.
 */
import { decryptSecret } from "../../../../packages/integrations/src/vault.ts";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";

export type ProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "deepseek"
  | "xai"
  | "mistral"
  | "custom"
  | "local";

export type SdkPrefix = "openai" | "anthropic" | "google";

export interface ProviderCatalogEntry {
  id: ProviderId;
  displayName: string;
  /** Default base URL. Absent for fully custom providers. */
  defaultBaseUrl?: string;
  /** Pre-filled model id shown in the add form. */
  defaultModel: string;
  /** Which CopilotKit model prefix the agent uses for this provider. */
  sdkPrefix: SdkPrefix;
  /** Whether an API key is mandatory at create time. */
  keyRequired: boolean;
  /** Whether the agent can chat through this provider (all catalog entries: true). */
  agentChatSupported: boolean;
  agentChatNote?: string;
}

/**
 * Local (Ollama) defaults. Overridable without code changes: restart the
 * server with LOCAL_LLM_BASE_URL / LOCAL_LLM_MODEL set to point the
 * "local" provider at a different endpoint or installed model. Per-entry
 * values stored in the vault always win at apply time. Neither value is
 * a secret.
 */
export const LOCAL_LLM_BASE_URL =
  process.env.LOCAL_LLM_BASE_URL?.trim() || "http://127.0.0.1:11434/v1";
export const LOCAL_LLM_MODEL = process.env.LOCAL_LLM_MODEL?.trim() || "qwen3:1.7b";

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5",
    sdkPrefix: "openai",
    keyRequired: true,
    agentChatSupported: true,
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4.5",
    sdkPrefix: "anthropic",
    keyRequired: true,
    agentChatSupported: true,
    agentChatNote:
      "Native anthropic/... prefix in @copilotkit/runtime v1.70.1 (reads ANTHROPIC_API_KEY).",
  },
  {
    id: "google",
    displayName: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-pro",
    sdkPrefix: "google",
    keyRequired: true,
    agentChatSupported: true,
    agentChatNote:
      "Google's OpenAI-compatible /v1beta/openai endpoint; runs through the openai/... prefix (the native google/... prefix expects REST /v1beta URLs).",
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    sdkPrefix: "openai",
    keyRequired: true,
    agentChatSupported: true,
    agentChatNote: "OpenAI-compatible /v1 endpoint; runs through the openai/... prefix.",
  },
  {
    id: "xai",
    displayName: "xAI",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-3",
    sdkPrefix: "openai",
    keyRequired: true,
    agentChatSupported: true,
    agentChatNote: "OpenAI-compatible /v1 endpoint; runs through the openai/... prefix.",
  },
  {
    id: "mistral",
    displayName: "Mistral",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    sdkPrefix: "openai",
    keyRequired: true,
    agentChatSupported: true,
    agentChatNote: "OpenAI-compatible /v1 endpoint; runs through the openai/... prefix.",
  },
  {
    id: "custom",
    displayName: "Custom (OpenAI-compatible)",
    defaultModel: "",
    sdkPrefix: "openai",
    keyRequired: false,
    agentChatSupported: true,
    agentChatNote: "Any OpenAI-compatible endpoint; key optional.",
  },
  {
    id: "local",
    displayName: "Local (Ollama)",
    defaultBaseUrl: LOCAL_LLM_BASE_URL,
    defaultModel: LOCAL_LLM_MODEL,
    sdkPrefix: "openai",
    keyRequired: false,
    agentChatSupported: true,
    agentChatNote:
      "No key. Expects Ollama on 127.0.0.1 (systemd unit ollama.service); a stopped Ollama " +
      "surfaces as a clear error at test/use time. Defaults overridable via " +
      "LOCAL_LLM_BASE_URL / LOCAL_LLM_MODEL env vars.",
  },
];

export function catalogEntry(provider: ProviderId): ProviderCatalogEntry {
  const entry = PROVIDER_CATALOG.find((candidate) => candidate.id === provider);
  if (!entry) throw new AppError(`Unknown provider "${provider}"`, 400);
  return entry;
}

/** DB kind for stored provider keys (also the plugin id). */
export const PROVIDER_KEYS_KIND = "provider-keys";
/** DB kind/id of the selection record (owner-scoped settings row). */
export const PROVIDER_SELECTION_KIND = "settings";
export const PROVIDER_SELECTION_ID = "selected-provider";

/**
 * A stored provider key. `secret` is a vault envelope; it is absent for
 * `local` entries. The plaintext key never appears on this object.
 */
export interface StoredProviderKey {
  id: string;
  provider: ProviderId;
  label: string;
  model: string;
  baseUrl?: string;
  secret?: string;
  /** Last-4 masked hint (e.g. "…abcd"), computed at create/rotation time. */
  keyHint: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderSelectionRecord {
  id: string;
  providerKeyId: string | null;
}

export interface AppliedProvider {
  id: string;
  provider: ProviderId;
  label: string;
  model: string;
  /** The model spec the agent was switched to (e.g. "openai/deepseek-chat"). */
  modelSpec: string;
}

// Env vars applyProviderSelection may overwrite. The pre-apply values are
// snapshotted once so clearProviderSelection can restore them (delete of the
// selected entry must not strand the process on the deleted key).
const MANAGED_ENV = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_BASE_URL",
] as const;

const originalEnv: Record<string, string | undefined> = {};
let envSnapshotted = false;
let originalModel: string | undefined;
let modelSnapshotted = false;
function snapshotOnce(config: Config): void {
  if (!envSnapshotted) {
    for (const name of MANAGED_ENV) originalEnv[name] = process.env[name];
    envSnapshotted = true;
  }
  if (!modelSnapshotted) {
    originalModel = config.model;
    modelSnapshotted = true;
  }
}

function restoreEnv(config: Config): void {
  for (const name of MANAGED_ENV) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  config.model = originalModel;
}

/**
 * Read the selection record. Owner-scoped when an owner is given; otherwise
 * the first owner-scoped selection found (single-user default).
 */
export async function getSelectedProvider(
  db: Store,
  owner?: string,
): Promise<{ owner: string; providerKeyId: string } | null> {
  if (owner) {
    const record = await db.get<ProviderSelectionRecord>(
      owner,
      PROVIDER_SELECTION_KIND,
      PROVIDER_SELECTION_ID,
    );
    return record?.providerKeyId ? { owner, providerKeyId: record.providerKeyId } : null;
  }
  const rows = await db.scan<ProviderSelectionRecord>(PROVIDER_SELECTION_KIND);
  const hit = rows.find((row) => row.value.id === PROVIDER_SELECTION_ID && row.value.providerKeyId);
  return hit ? { owner: hit.owner, providerKeyId: hit.value.providerKeyId as string } : null;
}

async function writeSelection(
  db: Store,
  owner: string,
  providerKeyId: string | null,
): Promise<void> {
  await db.put(owner, PROVIDER_SELECTION_KIND, {
    id: PROVIDER_SELECTION_ID,
    providerKeyId,
  } satisfies ProviderSelectionRecord);
}

/**
 * Load the selected provider-keys entry, decrypt its key in memory, and
 * hot-apply it to the running process: config.model plus the matching
 * process.env vars. In-memory only — .env is never written.
 *
 * Returns the applied provider, or null when nothing is selected (env-based
 * config keeps working exactly as today). A stale selection (entry deleted
 * without clearing) is cleared defensively and returns null.
 */
export async function applyProviderSelection(
  db: Store,
  config: Config,
  owner?: string,
): Promise<AppliedProvider | null> {
  const selection = await getSelectedProvider(db, owner);
  if (!selection) return null;
  const stored = await db.get<StoredProviderKey>(
    selection.owner,
    PROVIDER_KEYS_KIND,
    selection.providerKeyId,
  );
  if (!stored) {
    await writeSelection(db, selection.owner, null);
    return null;
  }
  const entry = catalogEntry(stored.provider);
  if (!config.encryptionKey && entry.keyRequired)
    throw new AppError("TOKEN_ENCRYPTION_KEY is not configured", 503);
  snapshotOnce(config);
  let apiKey = "";
  try {
    if (stored.secret) {
      if (!config.encryptionKey) throw new AppError("TOKEN_ENCRYPTION_KEY is not configured", 503);
      apiKey = decryptSecret(stored.secret, config.encryptionKey as string);
    } else if (entry.keyRequired) {
      throw new AppError("This provider entry has no API key stored", 500);
    }
    const baseUrl = stored.baseUrl?.trim() || entry.defaultBaseUrl || "";
    switch (entry.sdkPrefix) {
      case "anthropic":
        config.model = `anthropic/${stored.model}`;
        process.env.ANTHROPIC_API_KEY = apiKey;
        if (baseUrl) process.env.ANTHROPIC_BASE_URL = baseUrl;
        break;
      case "google":
        config.model = `google/${stored.model}`;
        process.env.GOOGLE_API_KEY = apiKey;
        if (baseUrl) process.env.GOOGLE_GENERATIVE_AI_BASE_URL = baseUrl;
        break;
      default:
        config.model = `openai/${stored.model}`;
        // Keyless selections (local Ollama, custom endpoints without a key):
        // the OpenAI SDK requires a non-empty key string even when the
        // endpoint ignores auth.
        process.env.OPENAI_API_KEY = apiKey || "none";
        if (baseUrl) process.env.OPENAI_BASE_URL = baseUrl;
        break;
    }
    return {
      id: stored.id,
      provider: stored.provider,
      label: stored.label,
      model: stored.model,
      modelSpec: config.model,
    };
  } finally {
    // The decrypted key is only ever alive inside this call.
    apiKey = "";
  }
}

/**
 * Clear the selection record and restore the pre-apply in-memory env/config
 * snapshot, so deleting the selected entry cannot strand the process on a
 * deleted key. When nothing was ever applied, only the record is cleared.
 */
export async function clearProviderSelection(
  db: Store,
  config: Config,
  owner?: string,
): Promise<void> {
  if (owner) {
    await writeSelection(db, owner, null);
  } else {
    const rows = await db.scan<ProviderSelectionRecord>(PROVIDER_SELECTION_KIND);
    for (const row of rows)
      if (row.value.id === PROVIDER_SELECTION_ID) await writeSelection(db, row.owner, null);
  }
  if (envSnapshotted || modelSnapshotted) restoreEnv(config);
}
