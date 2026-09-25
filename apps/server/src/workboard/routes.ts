import { Hono } from "hono";
import type { WorkboardService } from "./service.ts";

export function workboardRoutes(service: WorkboardService): Hono<{ Variables: { owner: string } }> {
  const app = new Hono<{ Variables: { owner: string } }>();
  // One call renders the board: the workboard.cards.list/stats binding shape.
  app.get("/", async (c) => c.json(await service.board(c.get("owner"))));
  app.post("/cards", async (c) =>
    c.json(await service.createCard(c.get("owner"), await c.req.json()), 201),
  );
  app.get("/cards/:id", async (c) =>
    c.json(await service.getCard(c.get("owner"), c.req.param("id"))),
  );
  app.patch("/cards/:id", async (c) =>
    c.json(await service.updateCard(c.get("owner"), c.req.param("id"), await c.req.json())),
  );
  app.post("/cards/:id/move", async (c) =>
    c.json(await service.moveCard(c.get("owner"), c.req.param("id"), await c.req.json())),
  );
  app.post("/cards/:id/dispatch", async (c) =>
    c.json(await service.dispatch(c.get("owner"), c.req.param("id"), await c.req.json())),
  );
  return app;
}
