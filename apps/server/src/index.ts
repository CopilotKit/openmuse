import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadServerSecrets } from "./config/server-secrets.ts";
import { assertApiDeploymentConfig, readConfig } from "./config.ts";
import { EmailService } from "./connectors/email/service.ts";
import { startMirrorScheduler } from "./connectors/email/sync.ts";
import { createStore } from "./db.ts";
import { applyProviderSelection } from "./engine/providers.ts";

// Vault bootstrap (TRACK C): DATABASE_URL + TOKEN_ENCRYPTION_KEY stay in .env by
// design -- the vault lives in the Postgres DATABASE_URL points to, and the key
// decrypts the vault itself. Connect with the bootstrap values, materialize
// vault secrets into process.env, then read the full config so readConfig()'s
// live-mode checks see the vault values.
const db = await createStore({
  dataDir: `${resolve(process.env.DATA_DIR ?? ".openmuse")}/postgres`,
  databaseUrl: process.env.DATABASE_URL,
});
await loadServerSecrets(db, process.env.TOKEN_ENCRYPTION_KEY);
const config = readConfig();
assertApiDeploymentConfig(config);
// Provider selection (TRACK B): if the user picked an LLM provider in the
// dashboard, hot-apply it in-memory (config.model + process.env). No-op when
// nothing is selected, so env-based config (deepseek-chat default) keeps
// working. Fail-open at boot: a broken selection must not prevent startup;
// the dashboard route surfaces the error when the user changes it.
try {
  await applyProviderSelection(db, config);
} catch (error) {
  console.warn(
    "[openmuse] provider selection failed at startup; using env config:",
    error instanceof Error ? error.message : error,
  );
}
await db.recoverInterruptedActions();
const { app, agent } = await createApp(db, config);
if (config.taskWorkerEnabled) agent.start();
// Local mail mirror (Outlook/SOGo-style): background IMAP sync of INBOX/Sent
// every 5 minutes for every owner with email accounts. Started only in the
// real server entrypoint, never during unit tests. The timer is unref'd and
// stopped on shutdown. The service is constructed directly (stateless:
// db + config + default factories) rather than via the plugin registry.
const mirrorEmail = new EmailService(db, config);
const stopMirrorSync = startMirrorScheduler({
  store: db,
  getService: () => mirrorEmail,
});
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () =>
  console.log(`OpenMuse ${config.mode} API ready at ${config.publicUrl}`),
);
const shutdown = () => {
  stopMirrorSync();
  server.close(() => {
    void agent
      .stop()
      .then(() => db.close())
      .then(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
