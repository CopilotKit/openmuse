import { Hono } from "hono";
import { z } from "zod";
import type { McpService } from "./mcp.ts";

export function mcpRoutes(mcp: McpService) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/servers", async (c) => c.json(await mcp.list(c.get("owner"))));
  app.post("/servers", async (c) => c.json(await mcp.add(c.get("owner"), await c.req.json()), 201));
  app.post("/servers/:id/connect", async (c) =>
    c.json(await mcp.connect(c.get("owner"), c.req.param("id"))),
  );
  app.post("/servers/:id/tools", async (c) =>
    c.json(await mcp.enable(c.get("owner"), c.req.param("id"), await c.req.json())),
  );
  app.delete("/servers/:id", async (c) =>
    c.json(await mcp.remove(c.get("owner"), c.req.param("id"))),
  );
  app.post("/servers/:id/call", async (c) => {
    const { name, args } = z
      .object({ name: z.string().min(1), args: z.record(z.string(), z.unknown()) })
      .parse(await c.req.json());
    return c.json(await mcp.call(c.get("owner"), c.req.param("id"), name, args));
  });
  return app;
}
