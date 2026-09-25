import { decryptSecret } from "../../../../packages/integrations/src/vault.ts";
import type { Store } from "../db.ts";

/**
 * Server-secrets vault (TRACK C: .env -> vault migration).
 *
 * Secrets that used to live plaintext in /root/openmuse/.env are stored
 * AES-256-GCM-encrypted in Postgres (owner "server", kind "server-secrets")
 * and materialized into process.env IN-MEMORY at startup, before readConfig()
 * runs. All existing consumers (agent.ts, the sidecar client, auth) keep
 * reading process.env / Config unchanged.
 *
 * WHAT MOVED vs WHAT STAYS (decisions, verified on-box 2026-09-23):
 *
 * Moved to the vault:
 * - OPENAI_API_KEY          (model provider credential; consumed post-DB-connect)
 * - WHATSAPP_SIDECAR_TOKEN  (sidecar bearer token; API server + sidecar both
 *                            have DB access, so both can load it at startup)
 * - OPENMUSE_ACCESS_KEY     (dashboard/API auth key. Moved deliberately rather
 *                            than kept in .env: it only needs to be in memory
 *                            before the server starts listening, so startup
 *                            materialization covers per-request auth via
 *                            config.accessKey with zero per-request decrypt
 *                            cost. The startup reorder was required anyway for
 *                            WHATSAPP_SIDECAR_TOKEN, which readConfig() also
 *                            maps from process.env.)
 *
 * Stays plaintext in .env:
 * - TOKEN_ENCRYPTION_KEY    (master key: decrypts the vault envelopes
 *                            themselves; chicken-and-egg, strictly needed at
 *                            runtime before any vault access is possible)
 * - DATABASE_URL            (credential-bearing: yes (postgresql:// with
 *                            userinfo, verified on-box). Stays anyway: the
 *                            vault lives in the Postgres database this URL
 *                            points to, so the server must read the DSN before
 *                            any vault access is possible. Same bootstrap
 *                            class as TOKEN_ENCRYPTION_KEY.)
 * - WORKER_TOKEN            (the browser worker is a separate process whose
 *                            systemd unit loads --env-file=/root/openmuse/.env
 *                            directly; it has no DB connection and therefore
 *                            no path to the vault. Verified via
 *                            `systemctl cat openmuse-browser-worker.service`.
 *                            Removing it from .env would break worker auth.)
 * - everything non-secret (ports, URLs, feature flags, ...)
 *
 * BOOTSTRAP ORDER (see index.ts, whatsapp-entry.ts):
 *   1. config.ts loads .env into process.env (unchanged)
 *   2. createStore() connects with DATABASE_URL from .env (bootstrap only)
 *   3. loadServerSecrets() decrypts vault records -> process.env (memory only)
 *   4. readConfig() runs; its live-mode checks see the vault values
 *
 * The vault never replaces .env as the bootstrap source; it only removes
 * high-value secrets from the flat file at rest.
 */

export const SERVER_SECRETS_OWNER = "server";
export const SERVER_SECRETS_KIND = "server-secrets";

/** .env keys migrated into the vault. Everything else stays in .env. */
export const MIGRATED_SERVER_SECRETS = [
  "OPENAI_API_KEY",
  "WHATSAPP_SIDECAR_TOKEN",
  "OPENMUSE_ACCESS_KEY",
] as const;

export interface ServerSecretRecord {
  id: string;
  encrypted: string;
  updatedAt: string;
}

/**
 * Load vault-held server secrets into process.env (in-memory only; nothing is
 * written back to disk). Returns the key names that were resolved.
 *
 * Fail-closed: when a migrated key is in neither the vault nor the
 * environment, this throws an Error naming the KEY (never any value).
 *
 * Pre-migration fallback: when the vault has no record but the value is still
 * present in the environment (old .env, migration not yet run), the env value
 * is kept and a loud warning is logged naming the key. Post-migration the key
 * is gone from .env, so the fallback never triggers and the vault is
 * authoritative.
 */
export async function loadServerSecrets(
  store: Store,
  encryptionKey: string | undefined,
): Promise<string[]> {
  if (!encryptionKey) {
    throw new Error(
      "[openmuse] Cannot load server secrets: TOKEN_ENCRYPTION_KEY is not set. " +
        "It must stay in .env (it decrypts the vault envelopes themselves).",
    );
  }
  const loaded: string[] = [];
  for (const name of MIGRATED_SERVER_SECRETS) {
    const record = await store.get<ServerSecretRecord>(
      SERVER_SECRETS_OWNER,
      SERVER_SECRETS_KIND,
      name,
    );
    if (!record) {
      const envValue = process.env[name];
      if (envValue) {
        console.warn(
          `[openmuse] WARNING: server secret "${name}" is not in the vault; ` +
            "using the .env value (pre-migration fallback). Run " +
            "apps/server/src/config/migrate-env-secrets.ts to migrate it.",
        );
        loaded.push(name);
        continue;
      }
      throw new Error(
        `[openmuse] Server secret "${name}" is not in the vault (owner ` +
          `"${SERVER_SECRETS_OWNER}", kind "${SERVER_SECRETS_KIND}") and is not ` +
          "in the environment. Run " +
          "apps/server/src/config/migrate-env-secrets.ts to migrate it from .env.",
      );
    }
    let plaintext: string;
    try {
      plaintext = decryptSecret(record.encrypted, encryptionKey);
    } catch {
      throw new Error(
        `[openmuse] Server secret "${name}" in the vault failed to decrypt. ` +
          "The vault may have been written with a different TOKEN_ENCRYPTION_KEY.",
      );
    }
    process.env[name] = plaintext;
    loaded.push(name);
  }
  return loaded;
}
