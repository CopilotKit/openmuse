import { Hono } from "hono";
import {
  credentialCreateSchema,
  credentialLoginAutoSchema,
  credentialLoginSchema,
  credentialUpdateSchema,
} from "./schemas.ts";
import type { CredentialsService } from "./service.ts";

/** Metadata-only routes. Decrypted secrets never appear in any response. */
export function credentialsRoutes(service: CredentialsService) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) => c.json(await service.list(c.get("owner") as string)));
  app.post("/", async (c) => {
    const body = credentialCreateSchema.parse(await c.req.json());
    return c.json(await service.create(c.get("owner") as string, body), 201);
  });
  /**
   * Sign the given browser session into whatever site it is on, auto-matching
   * saved logins by domain. Pass a label to skip auto-match. Returns 409 with
   * { needsChoice: true, options } when several saved logins match.
   */
  app.post("/login-auto", async (c) => {
    const body = credentialLoginAutoSchema.parse(await c.req.json());
    const owner = c.get("owner") as string;
    if (body.label)
      return c.json(await service.login(owner, { label: body.label }, body.sessionId));
    const result = await service.loginAuto(owner, body.sessionId);
    if (!result.ok) return c.json(result, 409);
    return c.json(result);
  });
  app.patch("/:id", async (c) => {
    const body = credentialUpdateSchema.parse(await c.req.json());
    return c.json(await service.update(c.get("owner") as string, c.req.param("id"), body));
  });
  app.delete("/:id", async (c) => {
    await service.remove(c.get("owner") as string, c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/:id/login", async (c) => {
    const body = credentialLoginSchema.parse(await c.req.json());
    return c.json(
      await service.login(c.get("owner") as string, { id: c.req.param("id") }, body.sessionId),
    );
  });
  return app;
}
