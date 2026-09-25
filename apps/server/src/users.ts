import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

export type UserRole = "admin" | "user";

/** Stored dashboard user. Passwords are one-way scrypt hashes, never reversible. */
export interface DashboardUser {
  /** Lowercase username; also the record id. */
  id: string;
  passwordHash: string;
  role: UserRole;
  disabled: boolean;
  createdAt: string;
}

/** Safe projection for API responses: never includes the password hash. */
export interface PublicUser {
  username: string;
  role: UserRole;
  disabled: boolean;
  createdAt: string;
}

const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;

export function normalizeUsername(name: string): string {
  return name.trim().toLowerCase();
}

export function validateUsername(name: string): string {
  const id = normalizeUsername(name);
  if (!USERNAME_RE.test(id))
    throw new AppError("Username must be 3-32 characters: letters, numbers, - and _", 422);
  return id;
}

export function validatePassword(password: string): void {
  if (typeof password !== "string" || password.length < 8)
    throw new AppError("Password must be at least 8 characters", 422);
  if (password.length > 256) throw new AppError("Password is too long", 422);
}

// scrypt hash envelope: scrypt$N$r$p$saltHex$hashHex
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  const hex = (b: Buffer) => b.toString("hex");
  return [
    "scrypt",
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    hex(salt),
    hex(hash),
  ].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
  try {
    const salt = Buffer.from(parts[4], "hex");
    const expected = Buffer.from(parts[5], "hex");
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = scryptSync(password, salt, expected.length, { N, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function toPublic(user: DashboardUser): PublicUser {
  return {
    username: user.id,
    role: user.role,
    disabled: user.disabled,
    createdAt: user.createdAt,
  };
}

export async function listUsers(db: Store): Promise<DashboardUser[]> {
  return db.list<DashboardUser>("system", "users");
}

export async function getUser(db: Store, username: string): Promise<DashboardUser | null> {
  return db.get<DashboardUser>("system", "users", normalizeUsername(username));
}

export async function createUser(
  db: Store,
  username: string,
  password: string,
  role: UserRole,
): Promise<PublicUser> {
  const id = validateUsername(username);
  validatePassword(password);
  if (role !== "admin" && role !== "user")
    throw new AppError('Role must be "admin" or "user"', 422);
  if (await getUser(db, id)) throw new AppError("That username is already taken", 409);
  const user: DashboardUser = {
    id,
    passwordHash: hashPassword(password),
    role,
    disabled: false,
    createdAt: new Date().toISOString(),
  };
  await db.put("system", "users", user);
  return toPublic(user);
}

/**
 * Seed the initial admin account from the workspace access key. Only runs
 * when no users exist yet; returns true when it created the account.
 */
export async function ensureAdminSeeded(
  db: Store,
  accessKey: string | undefined,
): Promise<boolean> {
  if ((await listUsers(db)).length > 0) return false;
  if (!accessKey) return false;
  const user: DashboardUser = {
    id: "admin",
    passwordHash: hashPassword(accessKey),
    role: "admin",
    disabled: false,
    createdAt: new Date().toISOString(),
  };
  await db.put("system", "users", user);
  return true;
}

/**
 * Throws when acting on `username` would leave zero enabled admins
 * (delete, demote, or disable of the last one).
 */
export async function assertNotLastEnabledAdmin(db: Store, username: string): Promise<void> {
  const id = normalizeUsername(username);
  const users = await listUsers(db);
  const remaining = users.filter((u) => u.role === "admin" && !u.disabled && u.id !== id);
  if (remaining.length === 0) throw new AppError("Cannot remove or demote the last admin", 409);
}

/** Drop every session belonging to `username` (after disable/role change/delete). */
export async function revokeUserSessions(db: Store, username: string): Promise<void> {
  const id = normalizeUsername(username);
  const sessions = await db.list<{ id: string; username?: string }>("system", "sessions");
  for (const s of sessions) {
    if (s.username === id) await db.remove("system", "sessions", s.id);
  }
}
