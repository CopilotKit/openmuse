/**
 * Plugin system HTTP API (mounted at /api/plugins, behind the existing
 * owner-auth middleware):
 *
 *   GET    /api/plugins              — plugin summaries for this owner
 *   GET    /api/plugins/errors       — discovery/load/doctor problems
 *   GET    /api/plugins/:id/config   — enabled flag + redacted config
 *   PATCH  /api/plugins/:id/config  — { enabled?, config? }; writeOnly "" = unchanged
 *   POST   /api/plugins/:id/invoke   — { binding, params? } dataBinding RPC
 *
 * writeOnly values are ALWAYS "" in responses — never the secret.
 */
import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../errors.ts";
import type { PluginRegistry } from "./registry.ts";

const configPatchSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const invokeSchema = z.object({
  binding: z.string().min(1).max(120),
  params: z.unknown().optional(),
});

export function pluginSystemRoutes(registry: PluginRegistry) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) => c.json(await registry.summaries(c.get("owner") as string)));
  app.get("/errors", (c) => c.json({ errors: registry.errors() }));
  app.get("/:id/config", async (c) =>
    c.json(await registry.publicConfig(c.get("owner") as string, c.req.param("id"))),
  );
  app.patch("/:id/config", async (c) => {
    const body = configPatchSchema.parse(await c.req.json());
    return c.json(await registry.updateConfig(c.get("owner") as string, c.req.param("id"), body));
  });
  app.post("/:id/invoke", async (c) => {
    const body = invokeSchema.parse(await c.req.json());
    return c.json(
      await registry.invokeBinding(
        c.get("owner") as string,
        c.req.param("id"),
        body.binding,
        body.params,
      ),
    );
  });
  // Unknown plugin ids surface as 404 from the registry; anything else here is 404.
  app.all("/:id", (c) => {
    throw new AppError(`Unknown plugin route: ${c.req.path}`, 404);
  });
  return app;
}
