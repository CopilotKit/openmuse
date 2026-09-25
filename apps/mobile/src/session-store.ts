// Durable storage for the API session token.
//
// The login token returned by POST /api/session must survive a page reload.
// On web this uses window.localStorage (durable across reloads); on native
// platforms without localStorage it falls back to an in-memory store so the
// behaviour is unchanged from before. The raw workspace access KEY is never
// persisted here -- only the server-issued session token, which expires
// server-side after 24h.
//
// The storage backend is injectable via setTokenStore/setStorageBackend so
// unit tests can run without a browser environment. The same localStorage-
// backed backend also persists user settings such as chat shortcuts
// (see shortcuts.ts).

/**
 * Minimal localStorage-shaped key/value store. Session tokens and user
 * settings (chat shortcuts, ...) share one backend instance.
 */
export interface KeyValueStore {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): unknown;
  removeItem(key: string): unknown;
}

/** Backwards-compatible alias for the session-token storage backend. */
export type TokenStore = KeyValueStore;

const TOKEN_KEY = "openmuse.session.token";

function defaultStore(): KeyValueStore {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    // Storage unavailable (private mode, SSR, etc.) -- fall through to memory.
  }
  const memory = new Map<string, string>();
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
    removeItem: (key) => {
      memory.delete(key);
    },
  };
}

let override: KeyValueStore | null = null;

/** Test seam: replace the storage backend (e.g. an in-memory fake). */
export function setTokenStore(store: KeyValueStore | null): void {
  setStorageBackend(store);
}

/** Test seam for non-token settings modules (chat shortcuts, ...). */
export function setStorageBackend(store: KeyValueStore | null): void {
  override = store;
}

/** Shared localStorage-backed backend used by settings modules. */
export function getStorageBackend(): KeyValueStore {
  return activeStore();
}

function activeStore(): TokenStore {
  if (!override) override = defaultStore();
  return override;
}

export async function loadSessionToken(): Promise<string | null> {
  try {
    return (await activeStore().getItem(TOKEN_KEY)) ?? null;
  } catch {
    return null;
  }
}

export async function saveSessionToken(token: string): Promise<void> {
  try {
    await activeStore().setItem(TOKEN_KEY, token);
  } catch {
    // Best effort: a session that can't be persisted still works until reload.
  }
}

export async function clearSessionToken(): Promise<void> {
  try {
    await activeStore().removeItem(TOKEN_KEY);
  } catch {
    // Best effort.
  }
}

/**
 * Check whether a stored session token is still accepted by the server.
 * Returns false when the server rejects it (401 = expired or unknown token).
 * Network failures propagate so the caller can surface them instead of
 * silently wiping a token that might still be good.
 */
export async function validateSessionToken(apiUrl: string, token: string): Promise<boolean> {
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/api/workspace`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.ok;
}

const USER_KEY = "openmuse.session.user";

/** Who is signed in (persisted alongside the token so the UI can gate admin screens). */
export interface StoredSessionUser {
  username: string;
  role: string;
}

export async function saveSessionUser(user: StoredSessionUser): Promise<void> {
  try {
    await activeStore().setItem(USER_KEY, JSON.stringify(user));
  } catch {
    // Best effort.
  }
}

export async function loadSessionUser(): Promise<StoredSessionUser | null> {
  try {
    const raw = await activeStore().getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSessionUser>;
    if (typeof parsed.username === "string" && typeof parsed.role === "string")
      return { username: parsed.username, role: parsed.role };
    return null;
  } catch {
    return null;
  }
}

export async function clearSessionUser(): Promise<void> {
  try {
    await activeStore().removeItem(USER_KEY);
  } catch {
    // Best effort.
  }
}
