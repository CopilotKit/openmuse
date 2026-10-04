import { serve } from "@hono/node-server";
import { defined } from "../../../packages/backends/src/strict-optional.ts";
import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { createStore } from "./db.ts";

const config = readConfig();
const db = await createStore(
  defined({
    dataDir: `${config.dataDir}/postgres`,
    databaseUrl: config.databaseUrl,
  }),
);
await db.recoverInterruptedActions();
const { app, agent } = await createApp(db, config);
if (config.taskWorkerEnabled) agent.start();
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () =>
  console.log(`OpenMuse ${config.mode} API ready at ${config.publicUrl}`),
);
const shutdown = () => {
  server.close(() => {
    void agent
      .stop()
      .then(() => db.close())
      .then(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
