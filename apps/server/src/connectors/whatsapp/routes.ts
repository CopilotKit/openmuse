import { Hono } from "hono";
import type { Config } from "../../config.ts";
import { AppError } from "../../errors.ts";
import {
  whatsappConsentSchema,
  whatsappInboundSchema,
  whatsappRecentQuerySchema,
  whatsappRuleIdSchema,
  whatsappRuleSchema,
} from "./schemas.ts";
import type { WhatsAppService } from "./service.ts";

/**
 * Public routes (mounted at /api/whatsapp, owner-authenticated).
 *
 * There is intentionally NO direct send route: outbound WhatsApp messages
 * go only through the reviewed action flow (POST /api/actions with kind
 * whatsapp.send), which executes via the sidecar after owner approval AND
 * an allow-list check. The QR is served raw; the client renders it.
 */
export function whatsappRoutes(service: WhatsAppService) {
  const app = new Hono<{ Variables: { owner: string } }>();
  const ownerOf = (c: { get(key: "owner"): string }) => c.get("owner") as string;

  app.get("/", async (c) => c.json(await service.getStatus(ownerOf(c))));

  app.post("/consent", async (c) => {
    const body = whatsappConsentSchema.parse(await c.req.json());
    return c.json(await service.recordConsent(ownerOf(c), body.accepted));
  });

  app.post("/pair/start", async (c) => c.json(await service.startPairing(ownerOf(c)), 202));
  app.get("/pair/qr", async (c) => c.json(await service.getQr(ownerOf(c))));
  app.post("/pair/stop", async (c) => c.json(await service.stopPairing(ownerOf(c))));

  app.post("/logout", async (c) => c.json(await service.logout(ownerOf(c))));

  // Full reset: session + rules + pairing state. Inbox history is kept.
  app.delete("/", async (c) => {
    await service.deletePairing(ownerOf(c));
    return c.json({ ok: true });
  });

  app.get("/rules", async (c) => c.json(await service.listRules(ownerOf(c))));
  app.post("/rules", async (c) => {
    const body = whatsappRuleSchema.parse(await c.req.json());
    return c.json(await service.addRule(ownerOf(c), body), 201);
  });
  app.delete("/rules/:id", async (c) => {
    const id = whatsappRuleIdSchema.parse(c.req.param("id"));
    await service.removeRule(ownerOf(c), id);
    return c.json({ ok: true });
  });

  app.get("/recent", async (c) => {
    const query = whatsappRecentQuerySchema.parse(c.req.query());
    return c.json(await service.searchRecent(ownerOf(c), query));
  });

  return app;
}

/**
 * Internal sidecar route (mounted at /internal/whatsapp in app.ts).
 * Authenticated by the WHATSAPP_SIDECAR_TOKEN bearer — NOT by owner session —
 * because the sidecar has no user session. The owner comes from the request
 * body (the sidecar's active pairing owner). Inbound is recorded regardless
 * of pairing state; only allow-listed senders are routed to the agent.
 */
export function whatsappInternalRoutes(service: WhatsAppService, config: Config) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const token = config.whatsappSidecarToken;
    const header = c.req.header("authorization") ?? "";
    if (!token || header !== `Bearer ${token}`) throw new AppError("Forbidden", 403);
    await next();
  });
  app.post("/inbound", async (c) => {
    const body = whatsappInboundSchema.parse(await c.req.json());
    const result = await service.handleInbound(body.owner, body.message);
    return c.json(result);
  });
  return app;
}
