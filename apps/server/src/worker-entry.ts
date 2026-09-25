import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { createStore } from "./db.ts";
import { applyProviderSelection } from "./engine/providers.ts";

const config = readConfig();
if (!config.databaseUrl)
  throw new Error(
    "A separate task worker requires DATABASE_URL. Embedded PGlite runs inside the API process.",
  );
const db = await createStore({ databaseUrl: config.databaseUrl });
// Provider selection (TRACK D): the standalone task worker must honour the
// dashboard-picked provider too. Fail-open like index.ts: a broken
// selection must not prevent the worker from starting.
try {
  await applyProviderSelection(db, config);
} catch (error) {
  console.warn(
    "[openmuse] provider selection failed in task worker; using env config:",
    error instanceof Error ? error.message : error,
  );
}
const { agent } = await createApp(db, config);
agent.start();
console.log("OpenMuse task worker running");
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await agent.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", () => {
  void stop().catch(() => process.exit(1));
});
process.on("SIGTERM", () => {
  void stop().catch(() => process.exit(1));
});
