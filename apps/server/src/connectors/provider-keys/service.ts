import { randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret } from "../../../../../packages/integrations/src/vault.ts";
import type { Config } from "../../config.ts";
import type { Store } from "../../db.ts";
import {
  applyProviderSelection,
  catalogEntry,
  clearProviderSelection,
  getSelectedProvider,
  PROVIDER_CATALOG,
  PROVIDER_KEYS_KIND,
  PROVIDER_SELECTION_ID,
  PROVIDER_SELECTION_KIND,
  type ProviderCatalogEntry,
  type ProviderId,
  type StoredProviderKey,
} from "../../engine/providers.ts";
import { AppError } from "../../errors.ts";
import type { ProviderKeyCreate, ProviderKeyUpdate } from "./schemas.ts";

const KIND = PROVIDER_KEYS_KIND;
/** /models probe timeout. Anthropic needs its own auth headers (x-api-key). */
const TEST_TIMEOUT_MS = 15000;
const ANTHROPIC_VERSION = "2023-06-01";
/** Provider error bodies are truncated to this many chars before surfacing. */
const MAX_ERROR_CHARS = 400;

export interface ProviderKeyMeta {
  id: string;
  provider: ProviderId;
  label: string;
  model: string;
  baseUrl?: string;
  /** Whether a key is stored (always false for local). */
  hasKey: boolean;
  /** Masked hint like "…abcd", or "none" when no key is stored. */
  keyHint: string;
  selected: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderTestResult {
  ok: boolean;
  detail?: string;
}

/**
 * Narrow HTTP surface so tests can substitute fakes (no network in tests).
 * Mirrors the subset of fetch used by the /models probe.
 */
export type ModelsFetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const defaultFetcher: ModelsFetcher = (url, init) =>
  fetch(url, init) as Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Decrypted entry. Created, used, and wiped inside a single operation. */
interface ResolvedProviderKey extends StoredProviderKey {
  apiKey: string;
}

const keyHintOf = (apiKey: string): string => `…${apiKey.slice(-4)}`;

export class ProviderKeyService {
  private readonly db: Store;
  private readonly config: Config;
  private readonly fetcher: ModelsFetcher;

  constructor(db: Store, config: Config, fetcher: ModelsFetcher = defaultFetcher) {
    this.db = db;
    this.config = config;
    this.fetcher = fetcher;
  }

  private requireKey(): string {
    if (!this.config.encryptionKey)
      throw new AppError("TOKEN_ENCRYPTION_KEY is not configured", 503);
    return this.config.encryptionKey;
  }

  catalog(): ProviderCatalogEntry[] {
    return PROVIDER_CATALOG;
  }

  private stored(owner: string, id: string): Promise<StoredProviderKey> {
    return this.db.get<StoredProviderKey>(owner, KIND, id).then((entry) => {
      if (!entry) throw new AppError("Provider key not found", 404);
      return entry;
    });
  }

  private async meta(owner: string, stored: StoredProviderKey): Promise<ProviderKeyMeta> {
    const selection = await getSelectedProvider(this.db, owner);
    return {
      id: stored.id,
      provider: stored.provider,
      label: stored.label,
      model: stored.model,
      baseUrl: stored.baseUrl,
      hasKey: Boolean(stored.secret),
      keyHint: stored.keyHint,
      selected: selection?.providerKeyId === stored.id,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  }

  /**
   * Run an operation with the decrypted key, wiping it afterwards.
   * The resolved entry never escapes this method. Local entries have no key.
   */
  private async withKey<T>(
    owner: string,
    id: string,
    operation: (entry: ResolvedProviderKey) => Promise<T>,
  ): Promise<T> {
    const stored = await this.stored(owner, id);
    const resolved: ResolvedProviderKey = { ...stored, apiKey: "" };
    try {
      if (stored.secret) resolved.apiKey = decryptSecret(stored.secret, this.requireKey());
      return await operation(resolved);
    } finally {
      resolved.apiKey = "";
    }
  }

  async list(owner: string): Promise<ProviderKeyMeta[]> {
    const entries = await this.db.list<StoredProviderKey>(owner, KIND);
    const sorted = entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return Promise.all(sorted.map((entry) => this.meta(owner, entry)));
  }

  async getSelection(owner: string): Promise<ProviderKeyMeta | null> {
    const selection = await getSelectedProvider(this.db, owner);
    if (!selection) return null;
    const stored = await this.db.get<StoredProviderKey>(owner, KIND, selection.providerKeyId);
    if (!stored) return null;
    return this.meta(owner, stored);
  }

  async create(owner: string, input: ProviderKeyCreate): Promise<ProviderKeyMeta> {
    const _entry = catalogEntry(input.provider);
    const now = new Date().toISOString();
    const baseUrl = input.baseUrl?.trim() || undefined;
    const stored: StoredProviderKey = {
      id: randomUUID(),
      provider: input.provider,
      label: input.label,
      model: input.model,
      baseUrl,
      secret: input.apiKey ? encryptSecret(input.apiKey, this.requireKey()) : undefined,
      keyHint: input.apiKey ? keyHintOf(input.apiKey) : "none",
      createdAt: now,
      updatedAt: now,
    };
    await this.db.put(owner, KIND, stored);
    // First entry becomes the selected provider automatically so the agent
    // starts using it; later entries never steal the selection.
    const existing = await getSelectedProvider(this.db, owner);
    if (!existing) await this.select(owner, stored.id);
    return this.meta(owner, stored);
  }

  async update(owner: string, id: string, patch: ProviderKeyUpdate): Promise<ProviderKeyMeta> {
    const stored = await this.stored(owner, id);
    const entry = catalogEntry(stored.provider);
    // The provider itself is immutable; delete and re-add to change it.
    if (patch.apiKey && stored.provider === "local")
      throw new AppError("Local (Ollama) entries use no API key", 400);
    if (patch.apiKey && !entry.keyRequired && stored.provider !== "custom")
      throw new AppError(`${entry.displayName} entries use no API key`, 400);
    const next: StoredProviderKey = {
      ...stored,
      label: patch.label ?? stored.label,
      model: patch.model ?? stored.model,
      baseUrl: patch.baseUrl !== undefined ? patch.baseUrl.trim() || undefined : stored.baseUrl,
      secret: patch.apiKey ? encryptSecret(patch.apiKey, this.requireKey()) : stored.secret,
      keyHint: patch.apiKey ? keyHintOf(patch.apiKey) : stored.keyHint,
      updatedAt: new Date().toISOString(),
    };
    await this.db.put(owner, KIND, next);
    // If the selected entry's runtime inputs changed, re-apply them.
    const selection = await getSelectedProvider(this.db, owner);
    if (selection?.providerKeyId === id) await applyProviderSelection(this.db, this.config, owner);
    return this.meta(owner, next);
  }

  async delete(owner: string, id: string): Promise<void> {
    await this.stored(owner, id);
    await this.db.remove(owner, KIND, id);
    const selection = await getSelectedProvider(this.db, owner);
    if (selection?.providerKeyId === id) {
      // Deleting the selected entry clears the selection AND restores the
      // pre-apply in-memory env/config snapshot — the process must never be
      // stranded on a deleted key.
      await clearProviderSelection(this.db, this.config, owner);
    }
  }

  async select(owner: string, id: string): Promise<ProviderKeyMeta> {
    const stored = await this.stored(owner, id);
    await this.db.put(owner, PROVIDER_SELECTION_KIND, {
      id: PROVIDER_SELECTION_ID,
      providerKeyId: stored.id,
    });
    await applyProviderSelection(this.db, this.config, owner);
    return this.meta(owner, stored);
  }

  private resolveBaseUrl(entry: ResolvedProviderKey): string {
    const catalog = catalogEntry(entry.provider);
    const baseUrl = entry.baseUrl?.trim() || catalog.defaultBaseUrl;
    if (!baseUrl) throw new AppError("This provider entry has no base URL configured", 400);
    return baseUrl.replace(/\/+$/, "");
  }

  /**
   * A hostile or buggy provider can echo the submitted API key in an error
   * body. Scrub the active key from any provider-supplied text before it
   * reaches diagnostics, logs, or API responses (split/join: the key may
   * contain regex metacharacters).
   */
  private redactKey(text: string, apiKey: string): string {
    if (!apiKey) return text;
    return text.split(apiKey).join("[redacted]");
  }

  /**
   * Provider error bodies are untrusted: scrub the active key, truncate,
   * strip control characters, and never include request data (the key is
   * only ever sent as a header value, never rendered into a message).
   */
  private safeDetail(raw: string): string {
    return raw
      .replace(/\p{Cc}/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_ERROR_CHARS);
  }

  private async safeError(
    error: unknown,
    entry: ResolvedProviderKey,
    baseUrl: string,
  ): Promise<string> {
    if (error instanceof AppError) return error.message;
    const rawMessage = error instanceof Error ? error.message : "Connection failed";
    // fetch() never includes request headers in its errors, but redact anyway
    // in case a lower layer echoes request data.
    const message = this.redactKey(rawMessage, entry.apiKey);
    if (entry.provider === "local" && /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message))
      return `Local model server is not reachable at ${baseUrl} — start Ollama and retry.`;
    return this.safeDetail(message);
  }

  /**
   * Minimal authenticated, non-generative probe: GET {baseUrl}/models with a
   * 15s timeout. No AI generation calls are ever made (zero cost). The key is
   * sent only as an auth header to the provider's own endpoint and never
   * appears in the result.
   */
  async test(owner: string, id: string): Promise<ProviderTestResult> {
    return this.withKey(owner, id, async (entry) => {
      const baseUrl = this.resolveBaseUrl(entry);
      const headers: Record<string, string> = { Accept: "application/json" };
      if (entry.apiKey) {
        if (entry.provider === "anthropic") {
          headers["x-api-key"] = entry.apiKey;
          headers["anthropic-version"] = ANTHROPIC_VERSION;
        } else if (
          entry.provider === "google" &&
          baseUrl === catalogEntry(entry.provider).defaultBaseUrl
        ) {
          // Native Generative Language endpoint: API-key header, not Bearer.
          headers["x-goog-api-key"] = entry.apiKey;
        } else {
          headers.Authorization = `Bearer ${entry.apiKey}`;
        }
      }
      try {
        const response = await this.fetcher(`${baseUrl}/models`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        });
        if (response.ok) return { ok: true };
        const detail = this.safeDetail(this.redactKey(await response.text(), entry.apiKey));
        return { ok: false, detail: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` };
      } catch (error) {
        return { ok: false, detail: await this.safeError(error, entry, baseUrl) };
      }
    });
  }
}
