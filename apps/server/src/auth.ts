import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import {
  ensureAdminSeeded,
  getUser,
  listUsers,
  normalizeUsername,
  type UserRole,
  verifyPassword,
} from "./users.ts";

const digest = (value: string) => createHash("sha256").update(value).digest();

interface SessionRow {
  id: string;
  owner: string;
  username?: string;
  role?: UserRole;
  expiresAt: number;
}

export interface SessionInfo {
  owner: string;
  username: string;
  role: UserRole;
}

export class Auth {
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly signingKey: string,
  ) {}
  async session(opts?: { accessKey?: string; username?: string; password?: string }) {
    const accessKey = opts?.accessKey;
    const username = opts?.username;
    const password = opts?.password;
    const users = await listUsers(this.db).catch(() => []);
    let sessionUser: { username: string; role: UserRole };
    if (users.length === 0) {
      // First-run bootstrap: the workspace access key becomes the initial
      // admin password. After this, sign-in is username + password.
      if (this.config.mode === "live") {
        // Tolerate stray whitespace from copy-paste (chat apps love trailing spaces).
        const key = (password ?? accessKey)?.trim();
        if (
          !key ||
          !this.config.accessKey ||
          !timingSafeEqual(digest(key), digest(this.config.accessKey))
        )
          throw new AppError("Access key is incorrect", 401);
        await ensureAdminSeeded(this.db, key);
      }
      sessionUser = { username: "admin", role: "admin" };
    } else {
      const id = normalizeUsername(username ?? "");
      if (!id || !password) throw new AppError("Username and password are required", 401);
      const user = await getUser(this.db, id);
      if (!user || user.disabled || !verifyPassword(password, user.passwordHash))
        throw new AppError("Wrong username or password", 401);
      sessionUser = { username: user.id, role: user.role };
    }
    // Lazily purge expired rows on every sign-in so the sessions store cannot
    // grow without bound; a purge failure must never block signing in.
    await this.purgeExpired().catch(() => {});
    const token = randomBytes(32).toString("base64url");
    await this.db.put("system", "sessions", {
      id: digest(token).toString("hex"),
      owner: "local-user",
      username: sessionUser.username,
      role: sessionUser.role,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });
    return {
      token,
      mode: this.config.mode,
      username: sessionUser.username,
      role: sessionUser.role,
    };
  }
  async owner(authorization?: string) {
    return (await this.sessionInfo(authorization)).owner;
  }
  /** Full session identity: data owner plus the signed-in dashboard user. */
  async sessionInfo(authorization?: string): Promise<SessionInfo> {
    if (!authorization?.startsWith("Bearer ")) throw new AppError("Sign in to OpenMuse", 401);
    const session = await this.db.get<SessionRow>(
      "system",
      "sessions",
      digest(authorization.slice(7)).toString("hex"),
    );
    if (!session || session.expiresAt < Date.now())
      throw new AppError("Session expired. Sign in again.", 401);
    // Sessions minted before the user system existed carry no identity;
    // treat them as the admin so existing sign-ins keep working.
    return {
      owner: session.owner,
      username: session.username ?? "admin",
      role: session.role ?? "admin",
    };
  }
  async revoke(authorization?: string) {
    // Idempotent: deleting a row that is already gone is a no-op.
    if (!authorization?.startsWith("Bearer ")) return;
    await this.db.remove("system", "sessions", digest(authorization.slice(7)).toString("hex"));
  }
  async purgeExpired() {
    const sessions = await this.db.list<{ id: string; expiresAt: number }>("system", "sessions");
    const now = Date.now();
    let removed = 0;
    for (const session of sessions) {
      if (session.expiresAt < now) {
        await this.db.remove("system", "sessions", session.id);
        removed += 1;
      }
    }
    return removed;
  }
  sign(owner: string, path: string) {
    const expires = String(Date.now() + 15 * 60 * 1000);
    const signature = createHmac("sha256", this.signingKey)
      .update(`${owner}\n${path}\n${expires}`)
      .digest("hex");
    return `${this.config.publicUrl}${path}?owner=${encodeURIComponent(owner)}&expires=${expires}&signature=${signature}`;
  }
  verify(url: URL) {
    const owner = url.searchParams.get("owner") ?? "";
    const expires = url.searchParams.get("expires") ?? "";
    const signature = url.searchParams.get("signature") ?? "";
    if (
      !owner ||
      !/^\d+$/.test(expires) ||
      Number(expires) < Date.now() ||
      !/^\w{64}$/.test(signature)
    )
      throw new AppError("Document link expired; refresh the workspace", 401);
    const expected = createHmac("sha256", this.signingKey)
      .update(`${owner}\n${url.pathname}\n${expires}`)
      .digest("hex");
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature)))
      throw new AppError("Invalid access link", 403);
    return owner;
  }
}
export async function createAuth(db: Store, config: Config) {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const path = join(config.dataDir, "session-signing-key");
  let key: string;
  try {
    key = await readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    key = randomBytes(32).toString("base64");
    await writeFile(path, key, { mode: 0o600, flag: "wx" });
  }
  return new Auth(db, config, key);
}
