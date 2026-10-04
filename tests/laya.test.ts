/**
 * Test: Laya client integration with OpenMuse.
 *
 * Creates temp files on the host filesystem, classifies them with Laya,
 * and verifies the classification results are correct. Also checks
 * status and cache operations.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../apps/server/src/config.ts";
import { LayaClient } from "../apps/server/src/laya.ts";

const fakeConfig: Config = {
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: "/tmp/test-openmuse",
  agentBackend: "model",
  allowedOrigins: ["http://localhost:8081"],
  googleRedirectUri: "http://localhost:8787/api/google/callback",
};

const owner = "test-owner";

async function main() {
  const laya = new LayaClient(fakeConfig, owner);

  // 1. Check status
  console.log("=== Status ===");
  const status = await laya.status();
  console.log(JSON.stringify(status, null, 2));
  if (!status.tunnel_alive) throw new Error("Tunnel not alive");
  if (status.laya_service !== "ok") throw new Error("Laya service not ok");
  console.log("✅ Status OK\n");

  // 2. Create test files
  const testDir = await mkdtemp(join(tmpdir(), "laya-test-"));
  const authFile = join(testDir, "auth.py");
  const configFile = join(testDir, "config.py");
  const logFile = join(testDir, "app.log");

  await writeFile(
    authFile,
    `
import bcrypt
SECRET_KEY = "sk-abc123"
def login(email, password):
    user = User.get(email=email)
    if bcrypt.checkpw(password, user.password_hash):
        return generate_token(user)
    return None
  `.trim(),
  );

  await writeFile(
    configFile,
    `
DB_HOST = "localhost"
DB_PORT = 5432
DB_NAME = "myapp"
DEBUG = True
  `.trim(),
  );

  await writeFile(
    logFile,
    `
[2024-01-15 10:30:00] INFO: Server started
[2024-01-15 10:31:00] ERROR: Database connection failed
[2024-01-15 10:32:00] WARNING: Retrying connection
[2024-01-15 10:33:00] ERROR: Max retries exceeded
  `.trim(),
  );

  // 3. Classify single file — does auth.py contain auth?
  console.log("=== Classify: auth.py contains auth? ===");
  const authResult = await laya.classifyHostFile(
    authFile,
    "Does this file contain authentication or credential management code?",
    "Contains auth code",
    "No auth code",
  );
  console.log(JSON.stringify(authResult, null, 2));
  if (authResult.answer !== "yes") throw new Error(`Expected yes, got ${authResult.answer}`);
  console.log("✅ auth.py correctly classified as auth code\n");

  // 4. Classify config.py — should be "no" for auth
  console.log("=== Classify: config.py contains auth? ===");
  const configResult = await laya.classifyHostFile(
    configFile,
    "Does this file contain authentication or credential management code?",
    "Contains auth code",
    "No auth code",
  );
  console.log(JSON.stringify(configResult, null, 2));
  if (configResult.answer !== "no") throw new Error(`Expected no, got ${configResult.answer}`);
  console.log("✅ config.py correctly classified as not auth code\n");

  // 5. Classify app.log — does it contain errors?
  console.log("=== Classify: app.log contains errors? ===");
  const logResult = await laya.classifyHostFile(
    logFile,
    "Does this file contain error or failure information?",
    "Contains errors",
    "No errors",
  );
  console.log(JSON.stringify(logResult, null, 2));
  if (logResult.answer !== "yes") throw new Error(`Expected yes, got ${logResult.answer}`);
  console.log("✅ app.log correctly classified as containing errors\n");

  // 6. Clear cache and verify
  console.log("=== Clear cache ===");
  const cleared = await laya.clearCache();
  console.log(JSON.stringify(cleared, null, 2));
  console.log("✅ Cache cleared\n");

  // 7. Check status again (should show 0 entries after clear)
  console.log("=== Status after clear ===");
  const status2 = await laya.status();
  console.log(
    JSON.stringify(
      { entries: status2.cache.entries, hits: status2.cache.hits, misses: status2.cache.misses },
      null,
      2,
    ),
  );
  console.log("✅ Cache cleared confirmed\n");

  // 8. Re-classify with caching (should be slower, cache miss)
  console.log("=== Re-classify auth.py (cache miss after clear) ===");
  const reResult = await laya.classifyHostFile(
    authFile,
    "Does this file contain authentication or credential management code?",
    "Contains auth code",
    "No auth code",
  );
  console.log(JSON.stringify(reResult, null, 2));
  if (reResult.answer !== "yes") throw new Error(`Expected yes, got ${reResult.answer}`);
  console.log("✅ Re-classification OK\n");

  // 9. Glob classify multiple files at once
  console.log("=== Glob classify directory ===");
  const globPattern = join(testDir, "**", "*");
  const globResults = await laya.classifyHostGlob(
    globPattern,
    "Which category best describes this file?",
    {
      code: "Source code file",
      config: "Configuration file",
      log: "Log file",
      doc: "Documentation file",
    },
  );
  console.log(JSON.stringify(globResults, null, 2));
  if (globResults.length < 3) throw new Error(`Expected >= 3 results, got ${globResults.length}`);
  const byName = new Map(globResults.map((r) => [r.path?.split("/").pop(), r]));
  const authClass = byName.get("auth.py");
  const cfgClass = byName.get("config.py");
  const logClass = byName.get("app.log");
  console.log(`auth.py -> ${authClass?.choice} (conf: ${authClass?.confidence})`);
  console.log(`config.py -> ${cfgClass?.choice} (conf: ${cfgClass?.confidence})`);
  console.log(`app.log -> ${logClass?.choice} (conf: ${logClass?.confidence})`);
  if (!authClass) throw new Error("Missing auth.py in glob results");
  if (!cfgClass) throw new Error("Missing config.py in glob results");
  if (!logClass) throw new Error("Missing app.log in glob results");
  if (authClass?.choice !== "code")
    throw new Error(`Expected code for auth.py, got ${authClass?.choice}`);
  if (cfgClass?.choice !== "config")
    throw new Error(`Expected config for config.py, got ${cfgClass?.choice}`);
  if (logClass?.choice !== "log")
    throw new Error(`Expected log for app.log, got ${logClass?.choice}`);
  console.log("✅ Glob classification correct\n");

  // 10. Pick most relevant file
  console.log("=== Pick most relevant file ===");
  const pickResult = await laya.pickFromHostFiles(
    "file containing authentication or credential management code",
    [authFile, configFile, logFile],
  );
  console.log(JSON.stringify(pickResult, null, 2));
  if (pickResult.path !== authFile)
    throw new Error(`Expected auth.py to be picked, got ${pickResult.path}`);
  console.log("✅ Pick returned correct file\n");

  // Clean up
  await rm(testDir, { recursive: true, force: true });

  console.log("=== All tests passed! ===");
}

main().catch((error) => {
  console.error("❌ Test failed:", error);
  process.exit(1);
});
