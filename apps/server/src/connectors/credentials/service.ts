import { randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret } from "../../../../../packages/integrations/src/vault.ts";
import type { BrowserService } from "../../browser.ts";
import type { Config } from "../../config.ts";
import type { Store } from "../../db.ts";
import { AppError } from "../../errors.ts";
import type { CredentialCreate, CredentialUpdate } from "./schemas.ts";

const KIND = "browser-credentials";

interface StoredCredential {
  id: string;
  label: string;
  domain: string;
  /** Vault envelope of JSON { username, password }. Never leaves this file decrypted. */
  secret: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

export interface CredentialMeta {
  id: string;
  label: string;
  domain: string;
  /** Redacted username, e.g. "jo***@example.com" or "a***". Never the password. */
  usernameHint: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

/** One candidate when several saved logins match a site. No secret material. */
export interface CredentialChoice {
  label: string;
  usernameHint: string;
}

export type LoginAutoResult =
  | { ok: true; label: string; domain: string; hostname: string }
  | { ok: false; needsChoice: true; hostname: string; options: CredentialChoice[] };

interface LoginSecrets {
  username: string;
  password: string;
}

/** Show just enough of the username to recognize it. */
export function usernameHint(username: string): string {
  const at = username.indexOf("@");
  if (at > 0) return `${username.slice(0, Math.min(2, at))}***@${username.slice(at + 1)}`;
  return `${username.slice(0, 1)}***`;
}

/** True when the session hostname is the credential domain or a subdomain of it. */
export function domainMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const expected = domain.toLowerCase().replace(/\.$/, "");
  return host === expected || host.endsWith(`.${expected}`);
}

export class CredentialsService {
  private readonly db: Store;
  private readonly config: Config;
  private readonly browser: BrowserService;

  constructor(db: Store, config: Config, browser: BrowserService) {
    this.db = db;
    this.config = config;
    this.browser = browser;
  }
  private requireKey(): string {
    if (!this.config.encryptionKey)
      throw new AppError("TOKEN_ENCRYPTION_KEY is not configured", 503);
    return this.config.encryptionKey;
  }
  private meta(stored: StoredCredential, hint: string): CredentialMeta {
    return {
      id: stored.id,
      label: stored.label,
      domain: stored.domain,
      usernameHint: hint,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      lastUsedAt: stored.lastUsedAt,
    };
  }
  private async hintFor(stored: StoredCredential): Promise<string> {
    // The hint needs the username; decrypt briefly and wipe immediately.
    let username = "";
    try {
      const secrets = JSON.parse(decryptSecret(stored.secret, this.requireKey())) as LoginSecrets;
      username = typeof secrets.username === "string" ? secrets.username : "";
      return usernameHint(username);
    } finally {
      username = "";
    }
  }
  async list(owner: string): Promise<CredentialMeta[]> {
    const stored = await this.db.list<StoredCredential>(owner, KIND);
    return Promise.all(stored.map(async (item) => this.meta(item, await this.hintFor(item))));
  }
  async create(owner: string, input: CredentialCreate): Promise<CredentialMeta> {
    const now = new Date().toISOString();
    const stored: StoredCredential = {
      id: randomUUID(),
      label: input.label,
      domain: input.domain,
      secret: encryptSecret(
        JSON.stringify({ username: input.username, password: input.password }),
        this.requireKey(),
      ),
      createdAt: now,
      updatedAt: now,
    };
    await this.db.put(owner, KIND, stored);
    return this.meta(stored, usernameHint(input.username));
  }
  async update(owner: string, id: string, patch: CredentialUpdate): Promise<CredentialMeta> {
    const stored = await this.db.get<StoredCredential>(owner, KIND, id);
    if (!stored) throw new AppError("Credential not found", 404);
    let secrets: LoginSecrets | null = null;
    let password = "";
    try {
      if (patch.password !== undefined || patch.username !== undefined) {
        secrets = JSON.parse(decryptSecret(stored.secret, this.requireKey())) as LoginSecrets;
      }
      const next: StoredCredential = {
        ...stored,
        label: patch.label ?? stored.label,
        domain: patch.domain ?? stored.domain,
        updatedAt: new Date().toISOString(),
      };
      if (secrets) {
        password = patch.password ?? secrets.password;
        next.secret = encryptSecret(
          JSON.stringify({ username: patch.username ?? secrets.username, password }),
          this.requireKey(),
        );
      }
      await this.db.put(owner, KIND, next);
      return this.meta(next, await this.hintFor(next));
    } finally {
      secrets = null;
      password = "";
    }
  }
  async remove(owner: string, id: string): Promise<void> {
    const stored = await this.db.get<StoredCredential>(owner, KIND, id);
    if (!stored) throw new AppError("Credential not found", 404);
    await this.db.remove(owner, KIND, id);
  }
  private async find(
    owner: string,
    selector: { id?: string; label?: string },
  ): Promise<StoredCredential> {
    if (selector.id) {
      const stored = await this.db.get<StoredCredential>(owner, KIND, selector.id);
      if (!stored) throw new AppError("Credential not found", 404);
      return stored;
    }
    const matches = (await this.db.list<StoredCredential>(owner, KIND)).filter(
      (item) => item.label.toLowerCase() === selector.label?.toLowerCase(),
    );
    if (matches.length === 0) throw new AppError("Credential not found", 404);
    if (matches.length > 1)
      throw new AppError(
        "Multiple credentials share that label. Use its id from the credentials list.",
        409,
      );
    return matches[0];
  }
  /**
   * Fill a saved login into a browser session. The decrypted password only
   * exists inside this method; callers receive a receipt, never the secret.
   */
  async login(
    owner: string,
    selector: { id?: string; label?: string },
    sessionId: string,
  ): Promise<{ ok: true; label: string; domain: string; hostname: string }> {
    const stored = await this.find(owner, selector);
    const hostname = await this.sessionHostname(owner, sessionId);
    if (!domainMatches(hostname, stored.domain))
      throw new AppError(
        `This login is saved for ${stored.domain} and cannot be used on ${hostname}`,
        403,
      );
    return this.fillSession(owner, stored, sessionId, hostname);
  }

  /**
   * Log in to whatever site the browser session is currently on, auto-matching
   * the owner's saved logins by domain. No label needed: the caller (agent or
   * user) doesn't have to know the credential's name.
   *
   * - exactly one saved login matches the site → it is filled automatically
   * - several match → returns the candidates so the caller can ask which one
   * - none match → 404 with a plain message naming the site
   *
   * Domain-locking is structural: only matching credentials are ever
   * considered, so a wrong-domain fill is impossible through this path.
   */
  async loginAuto(owner: string, sessionId: string): Promise<LoginAutoResult> {
    const hostname = await this.sessionHostname(owner, sessionId);
    const matches = (await this.db.list<StoredCredential>(owner, KIND)).filter((item) =>
      domainMatches(hostname, item.domain),
    );
    if (matches.length === 0)
      throw new AppError(
        `No saved login for ${hostname}. Save one in Connectors → Website logins first.`,
        404,
      );
    if (matches.length > 1) {
      const options = await Promise.all(
        matches.map(async (item) => ({
          label: item.label,
          usernameHint: await this.hintFor(item),
        })),
      );
      return { ok: false, needsChoice: true, hostname, options };
    }
    return this.fillSession(owner, matches[0], sessionId, hostname);
  }

  private async sessionHostname(owner: string, sessionId: string): Promise<string> {
    const session = await this.browser.get(owner, sessionId);
    try {
      return new URL(session.url).hostname;
    } catch {
      throw new AppError("The browser session has no valid page URL", 409);
    }
  }

  private async fillSession(
    owner: string,
    stored: StoredCredential,
    sessionId: string,
    hostname: string,
  ): Promise<{ ok: true; label: string; domain: string; hostname: string }> {
    let username = "";
    let password = "";
    try {
      const secrets = JSON.parse(decryptSecret(stored.secret, this.requireKey())) as LoginSecrets;
      username = secrets.username;
      password = secrets.password;
      if (!username || !password)
        throw new AppError("This credential is incomplete. Update it and try again.", 409);
      await this.browser.fillLogin(owner, sessionId, username, password, stored.domain);
    } finally {
      username = "";
      password = "";
    }
    await this.db.put(owner, KIND, {
      ...stored,
      lastUsedAt: new Date().toISOString(),
    });
    await this.db.put(owner, "activity", {
      id: randomUUID(),
      title: `Browser login · ${stored.label}`,
      detail: `Signed in to ${hostname} in a browser session`,
      date: new Date().toISOString(),
      status: "succeeded",
    });
    return { ok: true, label: stored.label, domain: stored.domain, hostname };
  }
}
