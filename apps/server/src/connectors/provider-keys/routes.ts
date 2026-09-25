import { Hono } from "hono";
import { providerKeyCreateSchema, providerKeyUpdateSchema } from "./schemas.ts";
import type { ProviderKeyService } from "./service.ts";

/**
 * Provider-keys routes. All responses are metadata only — vault-encrypted
 * keys are never returned, and the API key field is write-only (create /
 * explicit rotation). The test probe makes a minimal authenticated
 * non-generative call (GET {baseUrl}/models) with sanitised diagnostics.
 */
export function providerKeyRoutes(service: ProviderKeyService) {
  const app = new Hono<{ Variables: { owner: string } }>();

  app.get("/catalog", (c) => c.json(service.catalog()));

  app.get("/selection", async (c) => c.json(await service.getSelection(c.get("owner") as string)));

  app.get("/", async (c) => c.json(await service.list(c.get("owner") as string)));

  app.post("/", async (c) => {
    const body = providerKeyCreateSchema.parse(await c.req.json());
    return c.json(await service.create(c.get("owner") as string, body), 201);
  });

  app.post("/:id/select", async (c) =>
    c.json(await service.select(c.get("owner") as string, c.req.param("id"))),
  );

  app.post("/:id/test", async (c) =>
    c.json(await service.test(c.get("owner") as string, c.req.param("id"))),
  );

  app.patch("/:id", async (c) => {
    const body = providerKeyUpdateSchema.parse(await c.req.json());
    return c.json(await service.update(c.get("owner") as string, c.req.param("id"), body));
  });

  app.delete("/:id", async (c) => {
    await service.delete(c.get("owner") as string, c.req.param("id"));
    return c.json({ ok: true });
  });

  return app;
}
