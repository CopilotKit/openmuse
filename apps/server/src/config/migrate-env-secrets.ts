/**
 * One-time migration: move secret-bearing .env values into the encrypted vault.
 *
 * TRACK C of the OpenMuse clone build. Reads secret values from the .env file
 * ON THIS BOX, encrypts each with encryptSecret() + TOKEN_ENCRYPTION_KEY, and
 * stores them as vault records (owner "server", kind "server-secrets"). Then
 * rewrites .env WITHOUT the migrated lines so the flat file no longer holds
 * them at rest. The server materializes them into process.env at startup via
 * loadServerSecrets() (see ./server-secrets.ts).
 *
 * Migrated keys: OPENAI_API_KEY, WHATSAPP_SIDECAR_TOKEN, OPENMUSE_ACCESS_KEY.
 * Kept in .env by design: TOKEN_ENCRYPTION_KEY (master key), DATABASE_URL
 * (vault bootstrap), WORKER_TOKEN (browser worker has no DB access), and all
 * non-secret config. See server-secrets.ts for the full justification.
 *
 * Safety:
 * - Backs up the .env to <backup-dir>/openmuse-env-<timestamp>/.env FIRST and
 *   byte-verifies the backup before any write.
 * - On ANY failure after the rewrite, the backup is restored and verified.
 * - NEVER prints secret values: logs carry key names, byte counts and ok/fail
 *   only. (Values necessarily exist in this process's memory to encrypt them;
 *   they are never written to stdout, logs, or files except the vault.)
 * - Refuses to run twice: every migrated key must be present in the .env.
 *
 * Usage (run from /root/openmuse):
 *   # dry run against the live .env (no DB write, no .env rewrite):
 *   npx tsx apps/server/src/config/migrate-env-secrets.ts --dry-run
 *   # dry run against a temp copy (exercises backup+rewrite on scratch):
 *   npx tsx apps/server/src/config/migrate-env-secrets.ts --dry-run \
 *       --env-path /tmp/copy.env --backup-dir /tmp/mig-backups
 *   # FULL end-to-end rehearsal with zero live impact (file-backed PGlite
 *   # instead of Postgres; throwaway boot reads the rewritten copy):
 *   mkdir -p /tmp/sim && cp /root/openmuse/.env /tmp/sim/.env
 *   sed -i '/^DATABASE_URL=/d' /tmp/sim/.env   # force the PGlite fallback
 *   npx tsx apps/server/src/config/migrate-env-secrets.ts \
 *       --env-path /tmp/sim/.env --backup-dir /tmp/sim/backups \
 *       --pglite-dir /tmp/sim/pgdata --boot-cwd /tmp/sim
 *   # LIVE (run once, coordinated with the loadServerSecrets deploy):
 *   npx tsx apps/server/src/config/migrate-env-secrets.ts
 */
import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encryptSecret } from "../../../../packages/integrations/src/vault.ts";
import { createStore } from "../db.ts";
import {
  loadServerSecrets,
  MIGRATED_SERVER_SECRETS,
  SERVER_SECRETS_KIND,
  SERVER_SECRETS_OWNER,
} from "./server-secrets.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const TEST_PORT = 18787;

interface Args {
  dryRun: boolean;
  envPath: string;
  backupDir: string;
  /** Test hook: use file-backed PGlite at this dir instead of DATABASE_URL. */
  pgliteDir?: string;
  /** Test hook: run the boot-check child with this cwd instead of REPO_ROOT. */
  bootCwd?: string;
}

interface DbOpts {
  pgliteDir?: string;
  databaseUrl?: string;
}

function storeOpts(db: DbOpts): { dataDir?: string; databaseUrl?: string } {
  return db.pgliteDir ? { dataDir: db.pgliteDir } : { databaseUrl: db.databaseUrl };
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    envPath: join(REPO_ROOT, ".env"),
    backupDir: "",
  };
  let backupDirGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--env-path" && argv[i + 1]) args.envPath = resolve(argv[++i]);
    else if (a === "--backup-dir" && argv[i + 1]) {
      args.backupDir = resolve(argv[++i]);
      backupDirGiven = true;
    } else if (a === "--pglite-dir" && argv[i + 1]) args.pgliteDir = resolve(argv[++i]);
    else if (a === "--boot-cwd" && argv[i + 1]) args.bootCwd = resolve(argv[++i]);
    else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!backupDirGiven) {
    args.backupDir = args.dryRun
      ? mkdtempSync(join(tmpdir(), "openmuse-env-backup-"))
      : "/root/backups";
  }
  return args;
}

/** Match a top-level KEY=... line (no `export`, no leading whitespace). */
function parseEnvLine(line: string): { key: string; raw: string } | null {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  return m ? { key: m[1], raw: m[2] } : null;
}

/**
 * Ground-truth values using Node's own dotenv parser in a child process, so a
 * hand-rolled parser can never silently mangle a secret. Returns key->value.
 * (Values stay in memory only; never logged.)
 */
function readEnvValues(envPath: string, keys: readonly string[]): Map<string, string> {
  const script =
    `console.log(JSON.stringify([${keys.map((k) => JSON.stringify(k)).join(",")}]` +
    `.map((k) => [k, process.env[k] ?? null])))`;
  const out = execFileSync(process.execPath, ["--env-file", envPath, "-e", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pairs = JSON.parse(out) as [string, string | null][];
  const values = new Map<string, string>();
  for (const [k, v] of pairs) {
    if (v === null)
      throw new Error(`[migrate] key "${k}" not found in ${envPath} (aborting; already migrated?)`);
    values.set(k, v);
  }
  return values;
}

function backupEnv(envPath: string, backupDir: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15); // 20260923-103000
  const dir = join(backupDir, `openmuse-env-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const backupPath = join(dir, ".env");
  copyFileSync(envPath, backupPath);
  const original = readFileSync(envPath);
  const backup = readFileSync(backupPath);
  if (!original.equals(backup)) {
    throw new Error(`[migrate] backup byte-verification FAILED for ${backupPath}`);
  }
  return backupPath;
}

const MIGRATION_HEADER = [
  "# NOTE (2026-09-23, TRACK C): OPENAI_API_KEY, WHATSAPP_SIDECAR_TOKEN and",
  '# OPENMUSE_ACCESS_KEY now live in the encrypted vault (Postgres owner "server",',
  '# kind "server-secrets"). They are materialized into process.env at startup by',
  "# loadServerSecrets() (apps/server/src/config/server-secrets.ts). Do not re-add",
  "# them here; run apps/server/src/config/migrate-env-secrets.ts to rotate them.",
  "# Kept here by design: TOKEN_ENCRYPTION_KEY (decrypts the vault itself),",
  "# DATABASE_URL (the vault lives in the DB it points to; bootstrap), WORKER_TOKEN",
  "# (the browser worker loads this file directly and has no DB access).",
  "",
].join("\n");

function rewriteEnvWithoutSecrets(envPath: string): void {
  const lines = readFileSync(envPath, "utf8").split("\n");
  const kept: string[] = [];
  const removed: string[] = [];
  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (parsed && (MIGRATED_SERVER_SECRETS as readonly string[]).includes(parsed.key)) {
      removed.push(parsed.key);
      continue;
    }
    kept.push(line);
  }
  if (removed.length !== MIGRATED_SERVER_SECRETS.length) {
    throw new Error(
      `[migrate] expected to remove ${MIGRATED_SERVER_SECRETS.length} keys, found ${removed.length} — aborting`,
    );
  }
  const tmpPath = `${envPath}.migrate-tmp`;
  writeFileSync(tmpPath, MIGRATION_HEADER + kept.join("\n"), "utf8");
  renameSync(tmpPath, envPath);
  console.log(`[migrate] .env rewritten without: ${removed.join(", ")}`);
}

function restoreBackup(envPath: string, backupPath: string): void {
  copyFileSync(backupPath, envPath);
  const original = readFileSync(backupPath);
  const restored = readFileSync(envPath);
  if (!original.equals(restored)) {
    throw new Error("[migrate] CRITICAL: backup restore byte-verification FAILED");
  }
  console.log(`[migrate] .env restored from backup ${backupPath}`);
}

/** Minimal in-memory Store for dry-run verification (no DB writes). */
function fakeStore(records: Map<string, { id: string; encrypted: string }>) {
  return {
    async get<T>(owner: string, kind: string, id: string): Promise<T | null> {
      return (records.get(`${owner}/${kind}/${id}`) as T | undefined) ?? null;
    },
  };
}

async function verifyRoundTrip(
  encrypted: Map<string, string>,
  masterKey: string,
  originalLengths: Map<string, number>,
  useRealDb: boolean,
  db: DbOpts,
): Promise<void> {
  // Simulate the post-migration state: keys absent from the environment, then
  // loadServerSecrets() must restore every one from the vault (lengths only).
  const saved = new Map<string, string | undefined>();
  for (const name of MIGRATED_SERVER_SECRETS) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  const savedMode = process.env.WORKSPACE_MODE;
  const savedMaster = process.env.TOKEN_ENCRYPTION_KEY;
  try {
    if (useRealDb) {
      const store = await createStore(storeOpts(db));
      try {
        await loadServerSecrets(store, masterKey);
      } finally {
        await store.close();
      }
    } else {
      const records = new Map<string, { id: string; encrypted: string }>();
      for (const name of MIGRATED_SERVER_SECRETS) {
        records.set(`${SERVER_SECRETS_OWNER}/${SERVER_SECRETS_KIND}/${name}`, {
          id: name,
          encrypted: encrypted.get(name)!,
        });
      }
      // biome-ignore lint/suspicious/noExplicitAny: fake store for dry-run only
      await loadServerSecrets(fakeStore(records) as any, masterKey);
    }
    for (const name of MIGRATED_SERVER_SECRETS) {
      const v = process.env[name];
      if (!v || v.length !== originalLengths.get(name)) {
        throw new Error(`[migrate] verification FAILED for "${name}": length mismatch`);
      }
    }
    // Prove readConfig()'s live-mode gates accept the vault-materialized values.
    process.env.WORKSPACE_MODE = "live";
    process.env.TOKEN_ENCRYPTION_KEY = masterKey;
    const { readConfig } = await import("../config.ts");
    const config = readConfig();
    if (!config.accessKey || config.accessKey.length < 24 || !config.encryptionKey) {
      throw new Error("[migrate] verification FAILED: readConfig() live-mode gates not satisfied");
    }
    console.log(
      `[migrate] verify ok: ${MIGRATED_SERVER_SECRETS.length} secrets round-tripped ` +
        `(lengths match), readConfig() live-mode gates pass`,
    );
  } finally {
    for (const [name, v] of saved) {
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    }
    if (savedMode === undefined) delete process.env.WORKSPACE_MODE;
    else process.env.WORKSPACE_MODE = savedMode;
    if (savedMaster === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = savedMaster;
  }
}

/** Boot a throwaway API instance on a test port, hit /api/health, shut it down. */
async function verifyBoot(args: Args): Promise<void> {
  const tsxBin = join(REPO_ROOT, "node_modules", ".bin", "tsx");
  if (!existsSync(tsxBin)) throw new Error(`[migrate] tsx not found at ${tsxBin}`);
  const bootCwd = args.bootCwd ?? REPO_ROOT;
  console.log(`[migrate] booting throwaway API on 127.0.0.1:${TEST_PORT} (cwd=${bootCwd}) ...`);
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    PORT: String(TEST_PORT),
    TASK_WORKER_ENABLED: "false", // don't run the task worker in the probe
  };
  if (args.pgliteDir) {
    // The probe must open the SAME file-backed PGlite the migration wrote to:
    // createStore() derives it from DATA_DIR, so point DATA_DIR at its parent.
    childEnv.DATA_DIR = dirname(args.pgliteDir);
    // verifyRoundTrip() imports config.ts, whose module scope loadEnvFile()s the
    // migration's own .env into THIS process. Scrub DATABASE_URL so the probe
    // really uses the PGlite fallback instead of inheriting the live database.
    delete childEnv.DATABASE_URL;
  }
  // The probe is throwaway: bind loopback so the 127.0.0.1 health check always
  // reaches it regardless of the .env's HOST.
  childEnv.HOST = "127.0.0.1";
  const child = spawn(tsxBin, [join(REPO_ROOT, "apps/server/src/index.ts")], {
    cwd: bootCwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const exited = new Promise<number | null>((resolveExit) => {
    child.on("exit", (code) => resolveExit(code));
  });
  try {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (/API ready at/.test(stdout)) break;
      const exitCode: number | null = await Promise.race([
        exited,
        new Promise<null>((r) => setTimeout(() => r(null), 500)),
      ]);
      if (exitCode !== null) {
        throw new Error(
          `[migrate] probe server exited early (code ${exitCode}): ${stderr.slice(-2000)}`,
        );
      }
    }
    if (!/API ready at/.test(stdout)) {
      throw new Error(`[migrate] probe server did not become ready in 90s: ${stderr.slice(-2000)}`);
    }
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/health`);
    if (!res.ok) throw new Error(`[migrate] /api/health returned HTTP ${res.status}`);
    const body = (await res.json()) as { ok?: boolean };
    if (!body.ok) throw new Error("[migrate] /api/health did not return ok:true");
    console.log("[migrate] verify ok: throwaway API booted and /api/health returned ok:true");
  } finally {
    child.kill("SIGTERM");
    const code = await Promise.race([
      exited,
      new Promise<null>((r) => setTimeout(() => r(null), 15_000)),
    ]);
    if (code === null) child.kill("SIGKILL");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[migrate] ${args.dryRun ? "DRY RUN" : "LIVE RUN"} env-path=${args.envPath} backup-dir=${args.backupDir}`,
  );
  if (!existsSync(args.envPath)) throw new Error(`[migrate] env file not found: ${args.envPath}`);

  // 1. Read ground-truth values (Node's own parser, child process).
  const needed = ["TOKEN_ENCRYPTION_KEY", ...MIGRATED_SERVER_SECRETS];
  if (!args.pgliteDir) needed.splice(1, 0, "DATABASE_URL");
  const values = readEnvValues(args.envPath, needed);
  const masterKey = values.get("TOKEN_ENCRYPTION_KEY")!;
  const db: DbOpts = args.pgliteDir
    ? { pgliteDir: args.pgliteDir }
    : { databaseUrl: values.get("DATABASE_URL")! };
  const originalLengths = new Map<string, number>();
  for (const name of MIGRATED_SERVER_SECRETS) {
    const v = values.get(name)!;
    if (!v) throw new Error(`[migrate] "${name}" is empty in ${args.envPath} — aborting`);
    originalLengths.set(name, v.length);
  }
  console.log(
    `[migrate] read ${MIGRATED_SERVER_SECRETS.length} secrets from .env: ` +
      MIGRATED_SERVER_SECRETS.join(", "),
  );

  // 2. Backup FIRST, byte-verified, before any write.
  const backupPath = backupEnv(args.envPath, args.backupDir);
  console.log(`[migrate] backup ok: ${backupPath}`);

  // 3. Encrypt in memory (validates TOKEN_ENCRYPTION_KEY is 32-byte base64).
  const encrypted = new Map<string, string>();
  for (const name of MIGRATED_SERVER_SECRETS) {
    encrypted.set(name, encryptSecret(values.get(name)!, masterKey));
  }
  console.log(`[migrate] encrypted ${encrypted.size} secrets (AES-256-GCM envelopes)`);

  try {
    if (!args.dryRun) {
      // 4. Write vault records.
      const store = await createStore(storeOpts(db));
      try {
        for (const name of MIGRATED_SERVER_SECRETS) {
          await store.put(SERVER_SECRETS_OWNER, SERVER_SECRETS_KIND, {
            id: name,
            encrypted: encrypted.get(name)!,
            updatedAt: new Date().toISOString(),
          });
        }
      } finally {
        await store.close();
      }
      console.log(
        `[migrate] vault write ok: kind "${SERVER_SECRETS_KIND}", owner "${SERVER_SECRETS_OWNER}"`,
      );

      // 5. Rewrite .env without the migrated lines.
      rewriteEnvWithoutSecrets(args.envPath);

      // 6. Verify: round-trip through the REAL vault + readConfig() gates.
      await verifyRoundTrip(encrypted, masterKey, originalLengths, true, db);

      // 7. Verify: throwaway boot on a test port.
      await verifyBoot(args);

      console.log("[migrate] DONE. Secrets live in the vault; .env no longer holds them.");
      console.log(`[migrate] Backup retained at: ${backupPath}`);
    } else {
      // Dry run: no DB write, no .env rewrite. Verify the round-trip logic
      // against a fake store and the live-mode config gates.
      await verifyRoundTrip(encrypted, masterKey, originalLengths, false, db);
      console.log("[migrate] DRY RUN ok: no DB writes, no .env changes. Live command:");
      console.log("  npx tsx apps/server/src/config/migrate-env-secrets.ts");
    }
  } catch (err) {
    if (!args.dryRun) {
      console.error(`[migrate] FAILED: ${(err as Error).message} — restoring backup`);
      restoreBackup(args.envPath, backupPath);
    }
    throw err;
  }
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
