import { Hono } from "hono";
import { z } from "zod";
import { AiUnavailableError, draftReply, fixGrammarText } from "./ai.ts";
import {
  aiReplySchema,
  emailAccountCreateSchema,
  emailAccountUpdateSchema,
  emailMessageQuerySchema,
  fixGrammarSchema,
} from "./schemas.ts";
import type { EmailService } from "./service.ts";

/**
 * Metadata + message routes. The account password never appears in any
 * response. There is intentionally no direct send route: sending happens
 * only through the reviewed action flow (POST /api/actions with kind
 * email.send), which executes via SMTP after user approval.
 *
 * GET /:id/messages returns a paginated page object
 * { total, page, pageSize, items } — the search runs server-side over the
 * whole folder, so every match is visible through paging.
 */
export function emailRoutes(service: EmailService) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) => c.json(await service.listAccounts(c.get("owner") as string)));
  // Manual mirror sync. Syncs INBOX/Sent for the caller's accounts into the
  // local mirror and returns per-folder counts (added/deleted/flags/total).
  // Registered before "/:id" so the literal path wins over the param route.
  app.post("/sync", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const accountId =
      typeof body.accountId === "string" && body.accountId.length > 0 ? body.accountId : undefined;
    return c.json(await service.syncMirrors(c.get("owner") as string, accountId));
  });
  app.post("/", async (c) => {
    const body = emailAccountCreateSchema.parse(await c.req.json());
    return c.json(await service.createAccount(c.get("owner") as string, body), 201);
  });
  // Compose-box AI helpers. Account-agnostic (the client passes the quoted
  // original); they only return text — sending still goes through the
  // reviewed action flow. Registered before "/:id" so the literal paths win.
  // Model failures surface as 502 with a readable message for the UI.
  app.post("/ai-reply", async (c) => {
    const input = aiReplySchema.parse(await c.req.json());
    try {
      return c.json({ reply: await draftReply(input) });
    } catch (e) {
      const message = e instanceof Error ? e.message : "AI reply failed";
      const status = e instanceof AiUnavailableError ? 502 : 500;
      return c.json({ error: message }, status);
    }
  });
  app.post("/fix-grammar", async (c) => {
    const input = fixGrammarSchema.parse(await c.req.json());
    try {
      return c.json({ text: await fixGrammarText(input.text) });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Grammar fix failed";
      const status = e instanceof AiUnavailableError ? 502 : 500;
      return c.json({ error: message }, status);
    }
  });
  app.patch("/:id", async (c) => {
    const body = emailAccountUpdateSchema.parse(await c.req.json());
    return c.json(await service.updateAccount(c.get("owner") as string, c.req.param("id"), body));
  });
  app.delete("/:id", async (c) => {
    await service.deleteAccount(c.get("owner") as string, c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/:id/test", async (c) =>
    c.json(await service.testConnection(c.get("owner") as string, c.req.param("id"))),
  );
  app.get("/:id/folders", async (c) =>
    c.json(await service.folders(c.get("owner") as string, c.req.param("id"))),
  );
  app.get("/:id/messages", async (c) => {
    const query = emailMessageQuerySchema.parse(c.req.query());
    return c.json(await service.page(c.get("owner") as string, c.req.param("id"), query));
  });
  app.get("/:id/messages/:uid", async (c) => {
    const uid = z.coerce.number().int().min(1).parse(c.req.param("uid"));
    const folder = z
      .string()
      .min(1)
      .max(256)
      .parse(c.req.query("folder") ?? "INBOX");
    return c.json(await service.read(c.get("owner") as string, c.req.param("id"), folder, uid));
  });
  return app;
}
