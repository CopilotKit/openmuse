import { decryptSecret, encryptSecret } from "../../../../../packages/integrations/src/vault.ts";
import type { Config } from "../../config.ts";
import type { Store } from "../../db.ts";
import { AppError } from "../../errors.ts";

/**
 * Baileys AuthenticationState backed by the encrypted store — the only auth
 * state this connector ever uses. `useMultiFileAuthState` is deliberately
 * NOT used: session credentials are login-equivalent secrets, so they live
 * in AES-256-GCM envelopes (TOKEN_ENCRYPTION_KEY) in the DB, never as files
 * on disk and never in plaintext.
 *
 * This module has no Baileys import (structural types only), so it is
 * unit-testable without the package installed. bridge.ts composes it with
 * the real `initAuthCreds()` / `makeWASocket()` at sidecar runtime.
 */

const CREDS_KIND = "whatsapp-auth";
const CREDS_ID = "creds";
const KEYS_KIND = "whatsapp-auth-keys";

/** Structural match for Baileys' SignalKeyStore (get/set/clear). */
export interface SignalKeyStore {
  get(type: string, ids: string[]): Promise<Record<string, unknown>>;
  set(data: Record<string, Record<string, unknown | null>>): Promise<void>;
  clear(): Promise<void>;
}

export interface EncryptedAuthState {
  /** Decrypted creds, or null when nothing is paired yet. */
  creds: unknown | null;
  /** Persist (encrypted) creds after Baileys' creds.update. */
  saveCreds(creds: unknown): Promise<void>;
  /** DB-backed SignalKeyStore; every value is an encrypted envelope. */
  keys: SignalKeyStore;
  /** Remove every auth record (logout / delete / needs_repair). */
  wipe(): Promise<void>;
}

interface EnvelopeRecord {
  id: string;
  envelope: string;
}

function requireKey(config: Config): string {
  if (!config.encryptionKey) throw new AppError("TOKEN_ENCRYPTION_KEY is not configured", 503);
  return config.encryptionKey;
}

/**
 * Baileys creds/keys contain Uint8Array values (Signal key material).
 * Plain JSON.stringify turns them into {"0":1,...} objects that come back
 * as plain objects — breaking the crypto on restore. The replacer/reviver
 * below round-trips every Uint8Array (Buffer included) as tagged base64.
 */
const BYTES_TAG = "__wa_bytes";

const toJson = (value: unknown): string =>
  JSON.stringify(value, (_key, nested: unknown) => {
    if (nested instanceof Uint8Array)
      return { [BYTES_TAG]: Buffer.from(nested).toString("base64") };
    return nested;
  });

const fromJson = (json: string): unknown =>
  JSON.parse(json, (_key, nested: unknown) => {
    if (
      nested &&
      typeof nested === "object" &&
      typeof (nested as Record<string, unknown>)[BYTES_TAG] === "string"
    )
      return Buffer.from((nested as Record<string, string>)[BYTES_TAG], "base64");
    return nested;
  });

export async function createEncryptedAuthState(
  db: Store,
  config: Config,
  owner: string,
): Promise<EncryptedAuthState> {
  const key = requireKey(config);
  const seal = (value: unknown): string => encryptSecret(toJson(value), key);
  const open = (envelope: string): unknown => fromJson(decryptSecret(envelope, key));

  const readEnvelope = async (kind: string, id: string): Promise<EnvelopeRecord | null> =>
    (await db.get<EnvelopeRecord>(owner, kind, id)) ?? null;

  const keys: SignalKeyStore = {
    get: async (type, ids) => {
      const out: Record<string, unknown> = {};
      for (const id of ids) {
        const record = await readEnvelope(KEYS_KIND, `${type}:${id}`);
        if (record) out[id] = open(record.envelope);
      }
      return out;
    },
    set: async (data) => {
      for (const [type, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries)) {
          const recordId = `${type}:${id}`;
          if (value === null || value === undefined) {
            await db.remove(owner, KEYS_KIND, recordId).catch(() => undefined);
          } else {
            await db.put(owner, KEYS_KIND, { id: recordId, envelope: seal(value) });
          }
        }
      }
    },
    clear: async () => {
      const records = await db.list<EnvelopeRecord>(owner, KEYS_KIND);
      for (const record of records) {
        await db.remove(owner, KEYS_KIND, record.id).catch(() => undefined);
      }
    },
  };

  const loadCreds = async (): Promise<unknown | null> => {
    const record = await readEnvelope(CREDS_KIND, CREDS_ID);
    if (!record) return null;
    try {
      return open(record.envelope);
    } catch {
      // Corrupt or re-keyed envelope: treat as absent. wipe() still removes
      // the row, so logout / needs_repair can never be blocked by bad
      // ciphertext — the safe direction is always "no session".
      return null;
    }
  };

  return {
    creds: await loadCreds(),
    saveCreds: async (creds: unknown) => {
      await db.put(owner, CREDS_KIND, { id: CREDS_ID, envelope: seal(creds) });
    },
    keys,
    wipe: async () => {
      await db.remove(owner, CREDS_KIND, CREDS_ID).catch(() => undefined);
      await keys.clear();
    },
  };
}
