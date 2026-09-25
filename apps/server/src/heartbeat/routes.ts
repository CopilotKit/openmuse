import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../errors.ts";
import type { HeartbeatService } from "./service.ts";

const createRuleSchema = z.object({
  name: z.string().min(1),
  field: z.enum([
    "upcoming_meeting_minutes",
    "unread_email_subject",
    "unread_email_sender",
    "service_health",
    "custom",
  ]),
  operator: z.enum(["less_than", "greater_than", "equals", "contains", "matches"]),
  value: z.union([z.string(), z.number()]),
  template: z.string().min(1),
});

export function heartbeatRoutes(
  service: HeartbeatService,
): Hono<{ Variables: { owner: string; role?: string } }> {
  const app = new Hono<{ Variables: { owner: string; role?: string } }>();

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.message }, (err as any).status || 400);
    }
    return c.json({ error: err.message || "Internal error" }, 500);
  });

  function getOwner(c: any): string {
    return c.req.header("x-owner") || c.get("owner") || (c.env as any)?.owner || "default";
  }

  // GET /status
  app.get("/status", (c) => {
    return c.json({
      config: service.getConfig(),
      rulesCount: service.automations.getRules().length,
    });
  });

  // POST /pulse (manual trigger)
  app.post("/pulse", async (c) => {
    const owner = getOwner(c);
    const result = await service.pulse(owner);
    return c.json(result);
  });

  // GET /rules
  app.get("/rules", (c) => {
    return c.json({
      rules: service.automations.getRules(),
    });
  });

  // POST /rules
  app.post("/rules", async (c) => {
    const body = await c.req.json();
    const parsed = createRuleSchema.parse(body);
    const rule = service.automations.addRule({
      name: parsed.name,
      enabled: true,
      condition: {
        field: parsed.field,
        operator: parsed.operator,
        value: parsed.value,
      },
      action: {
        type: "telegram_alert",
        template: parsed.template,
      },
    });
    return c.json({ ok: true, rule });
  });

  // DELETE /rules/:id
  app.delete("/rules/:id", (c) => {
    const id = c.req.param("id");
    const ok = service.automations.deleteRule(id);
    return c.json({ ok });
  });

  return app;
}
