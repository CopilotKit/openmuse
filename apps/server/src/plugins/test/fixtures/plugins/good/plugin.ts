/**
 * Test fixture plugin. Tracks how often its doctor migration ran so the
 * registry test can assert migrations run exactly once.
 */
import { defineTool } from "@copilotkit/runtime/v2";
import { Hono } from "hono";
import { z } from "zod";
import type { PluginActivation, PluginContext } from "../../../../plugin-api.ts";

export let migrationRuns = 0;

export async function activate(ctx: PluginContext): Promise<PluginActivation> {
  ctx.registerTools({
    fixture_echo: {
      chat: (owner: string) => [
        defineTool({
          name: "fixture_echo",
          description: `Echo for ${owner}`,
          parameters: z.object({ text: z.string() }),
          execute: async ({ text }) => ({ echo: text }),
        }),
      ],
    },
    fixture_worker_echo: {
      worker: (host) =>
        host.defineTool(
          "fixture_worker_echo",
          "Worker echo.",
          z.object({ text: z.string() }),
          async ({ text }) => ({ echo: text }),
        ),
    },
  });
  ctx.registerDataBinding("ping", async () => ({ pong: true }));
  ctx.registerDataBinding("big", async () => ({ blob: "x".repeat(300 * 1024) }));
  const app = new Hono();
  app.get("/", (c) => c.json({ ok: true }));
  return {
    routes: app,
    migrations: {
      "seed-defaults": async (ctx) => {
        migrationRuns += 1;
        // Doctor migrations must never see the full Store.
        if ("db" in ctx) throw new Error("doctor context leaked the full Store");
        if (typeof ctx.state.get !== "function" || typeof ctx.state.put !== "function")
          throw new Error("doctor context is missing scoped state access");
      },
    },
  };
}
