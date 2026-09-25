import { Hono } from "hono";
import { AppError } from "../../errors.ts";
import { telegramConfigSchema } from "./schemas.ts";
import type { TelegramService } from "./service.ts";

export function telegramRoutes(
  service: TelegramService,
): Hono<{ Variables: { owner: string; role?: string } }> {
  const app = new Hono<{ Variables: { owner: string; role?: string } }>();

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.message }, err.status);
    }
    return c.json({ error: err.message || "Internal error" }, 500);
  });

  function getOwner(c: any): string {
    return c.req.header("x-owner") || c.get("owner") || (c.env as any)?.owner || "default";
  }

  function requireAdmin(c: any) {
    const role = c.req.header("x-role") || c.get("role") || (c.env as any)?.role;
    if (role && role !== "admin") {
      throw new AppError("Admin role required to manage Telegram connector", 403);
    }
  }

  // GET status (available to authenticated users)
  app.get("/status", async (c) => {
    const owner = getOwner(c);
    const status = await service.getStatus(owner);
    return c.json(status);
  });

  // POST config (admin only)
  app.post("/config", async (c) => {
    requireAdmin(c);
    const owner = getOwner(c);
    const body = await c.req.json();
    const parsed = telegramConfigSchema.parse(body);
    const status = await service.saveConfig(owner, parsed);
    return c.json(status);
  });

  // POST test message (admin only)
  app.post("/test", async (c) => {
    requireAdmin(c);
    const owner = getOwner(c);
    const result = await service.testConnection(owner);
    return c.json(result);
  });

  return app;
}
