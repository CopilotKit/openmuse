import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

export interface DeviceInfo {
  // `| undefined` because these come from a session row that may have been
  // written before device identity existed.
  deviceId?: string | null | undefined;
  deviceName?: string | null | undefined;
}

const digest = (value: string) => createHash("sha256").update(value).digest();
export class Auth {
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly signingKey: string,
  ) {}
  async session(accessKey?: string, device: DeviceInfo = {}) {
    if (
      this.config.mode === "live" &&
      (!accessKey ||
        !this.config.accessKey ||
        !timingSafeEqual(digest(accessKey), digest(this.config.accessKey)))
    )
      throw new AppError("Access key is incorrect", 401);
    const token = randomBytes(32).toString("base64url");
    await this.db.put("system", "sessions", {
      id: digest(token).toString("hex"),
      owner: "local-user",
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      deviceId: device.deviceId ?? null,
      deviceName: device.deviceName ?? null,
      createdAt: Date.now(),
    });
    return { token, mode: this.config.mode };
  }
  async owner(authorization?: string) {
    return (await this.device(authorization)).owner;
  }
  /** Resolve the owning device for a bearer token, with device identity. */
  async device(authorization?: string): Promise<{ owner: string } & DeviceInfo> {
    if (!authorization?.startsWith("Bearer ")) throw new AppError("Sign in to OpenMuse", 401);
    const session = await this.db.get<{
      owner: string;
      expiresAt: number;
      deviceId?: string | null;
      deviceName?: string | null;
    }>("system", "sessions", digest(authorization.slice(7)).toString("hex"));
    if (!session || session.expiresAt < Date.now())
      throw new AppError("Session expired. Sign in again.", 401);
    return {
      owner: session.owner,
      deviceId: session.deviceId ?? null,
      deviceName: session.deviceName ?? null,
    };
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
