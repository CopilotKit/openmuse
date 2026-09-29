import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type {
  AgentIdentity,
  AgentMemory,
  AgentNotification,
  AgentTask,
  DeviceModelRouting,
  RunEvent,
} from "../../../../packages/domain/src/agent.ts";
import type { DeviceInfo } from "../auth.ts";
import { AppError } from "../errors.ts";
import type { AgentService } from "./service.ts";

const text = z.string().trim().min(1).max(4000);
const memorySchema = z.object({ text, source: z.string().trim().min(1).max(200).optional() });
const goalPatchSchema = z.object({
  status: z.enum(["active", "paused", "completed"]).optional(),
  milestones: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        title: z.string().trim().min(1).max(200),
        done: z.boolean(),
      }),
    )
    .max(100)
    .optional(),
});

export function agentRoutes(
  service: AgentService,
): Hono<{ Variables: { owner: string; device: DeviceInfo } }> {
  const app = new Hono<{ Variables: { owner: string; device: DeviceInfo } }>();
  app.get("/", async (c) => c.json(await service.snapshot(c.get("owner"))));
  app.post("/tasks", async (c) =>
    c.json(
      await service.createTask(
        c.get("owner"),
        await c.req.json(),
        undefined,
        false,
        c.get("device"),
      ),
      201,
    ),
  );
  app.get("/tasks/:id", async (c) =>
    c.json(await service.detail(c.get("owner"), c.req.param("id"))),
  );
  app.post("/tasks/:id/control", async (c) => {
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "cancel", "retry"]) })
      .parse(await c.req.json());
    return c.json(await service.control(c.get("owner"), c.req.param("id"), action));
  });
  app.post("/tasks/:id/input", async (c) => {
    const body = z
      .object({
        answer: z.string().trim().min(1).max(12000),
        fields: z
          .record(z.string().min(1).max(300), z.union([z.string().max(12000), z.boolean()]))
          .optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await service.answer(c.get("owner"), c.req.param("id"), body.answer, body.fields),
    );
  });
  app.get("/tasks/:id/stream", async (c) => {
    const owner = c.get("owner");
    const taskId = c.req.param("id");
    const task = await service.db.get<AgentTask>(owner, "tasks", taskId);
    if (!task) throw new AppError("Task not found", 404);
    const terminal = new Set(["succeeded", "failed", "cancelled", "paused"]);
    const seen = new Set<string>();
    return streamSSE(c, async (stream) => {
      const existing = (await service.db.list<RunEvent>(owner, "run-events")).filter(
        (e) => e.taskId === taskId,
      );
      for (const e of existing) {
        seen.add(e.id);
        await stream.writeSSE({ data: JSON.stringify(e), event: "run-event" });
      }
      if (terminal.has(task.status)) {
        await stream.writeSSE({
          data: JSON.stringify({
            taskId,
            status: task.status,
            result: task.result,
            error: task.error,
          }),
          event: "task-complete",
        });
        return;
      }
      // biome-ignore lint/suspicious/noUnnecessaryConditions: intentional infinite loop with early return
      while (true) {
        await stream.sleep(service.config.streamPollIntervalMs ?? 2000);
        const next = (await service.db.list<RunEvent>(owner, "run-events")).filter(
          (e) => e.taskId === taskId && !seen.has(e.id),
        );
        for (const e of next) {
          seen.add(e.id);
          await stream.writeSSE({ data: JSON.stringify(e), event: "run-event" });
        }
        const live = await service.db.get<AgentTask>(owner, "tasks", taskId);
        if (live && terminal.has(live.status)) {
          await stream.writeSSE({
            data: JSON.stringify({
              taskId,
              status: live.status,
              result: live.result,
              error: live.error,
            }),
            event: "task-complete",
          });
          return;
        }
      }
    });
  });
  app.post("/goals", async (c) =>
    c.json(await service.createGoal(c.get("owner"), await c.req.json()), 201),
  );
  app.post("/goals/:id", async (c) => {
    const body = goalPatchSchema.parse(await c.req.json());
    return c.json(await service.updateGoal(c.get("owner"), c.req.param("id"), body));
  });
  app.post("/monitors", async (c) =>
    c.json(await service.createMonitor(c.get("owner"), await c.req.json()), 201),
  );
  app.post("/monitors/:id/control", async (c) => {
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "stop", "check"]) })
      .parse(await c.req.json());
    return c.json(await service.controlMonitor(c.get("owner"), c.req.param("id"), action));
  });
  app.post("/ideas/refresh", async (c) => c.json(await service.refreshIdeas(c.get("owner"))));
  app.post("/ideas/:id", async (c) => {
    const body = z
      .object({
        action: z.enum(["accept", "dismiss"]),
        prompt: z.string().trim().min(1).max(12000).optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await service.decideIdea(c.get("owner"), c.req.param("id"), body.action, body.prompt),
    );
  });
  app.post("/memories", async (c) => {
    const body = memorySchema.parse(await c.req.json());
    const memory: AgentMemory = {
      id: randomUUID(),
      text: body.text,
      source: body.source ?? "You",
      createdAt: new Date().toISOString(),
    };
    return c.json(await service.db.put(c.get("owner"), "memories", memory), 201);
  });
  app.post("/memories/:id", async (c) => {
    const body = memorySchema.parse(await c.req.json());
    const memory = await service.db.compareAndSwap<AgentMemory>(
      c.get("owner"),
      "memories",
      c.req.param("id"),
      {},
      body,
    );
    if (!memory) throw new AppError("Memory not found", 404);
    return c.json(memory);
  });
  app.post("/memories/:id/forget", async (c) => {
    if (!(await service.db.take(c.get("owner"), "memories", c.req.param("id"))))
      throw new AppError("Memory not found", 404);
    return c.json({ ok: true });
  });
  app.post("/identity", async (c) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(80),
        tone: z.enum(["warm", "concise", "thoughtful"]),
        avatar: z.enum(["sky", "sand", "lilac"]).optional(),
        showChatUpdates: z.boolean().optional(),
      })
      .parse(await c.req.json());
    const owner = c.get("owner");
    await service.ensure(owner);
    const identity = await service.db.compareAndSwap<AgentIdentity>(
      owner,
      "agent-settings",
      "identity",
      {},
      body,
    );
    if (!identity) throw new AppError("Agent identity changed; refresh and try again", 409);
    return c.json(identity);
  });
  app.get("/device-models", async (c) => {
    const device = c.get("device");
    if (!device.deviceId)
      throw new AppError("Sign in with a device ID to read model overrides", 400);
    return c.json(
      (await service.db.get<DeviceModelRouting>(
        c.get("owner"),
        "agent-settings",
        `device-models:${device.deviceId}`,
      )) ?? {},
    );
  });
  app.patch("/device-models", async (c) => {
    const device = c.get("device");
    if (!device.deviceId)
      throw new AppError("Sign in with a device ID to save model overrides", 400);
    const body = z
      .object({
        chatModel: z.string().optional(),
        taskModel: z.string().optional(),
        simpleTaskModel: z.string().optional(),
        chatMaxSteps: z.number().int().positive().optional(),
        taskMaxSteps: z.number().int().positive().optional(),
        simpleTaskMaxSteps: z.number().int().positive().optional(),
      })
      .parse(await c.req.json());
    await service.db.put(c.get("owner"), "agent-settings", {
      id: `device-models:${device.deviceId}`,
      ...body,
    });
    return c.json({ ok: true });
  });
  app.get("/notifications", async (c) =>
    c.json((await service.snapshot(c.get("owner"))).notifications),
  );
  app.post("/notifications/:id/read", async (c) => {
    const notification = await service.db.compareAndSwap<AgentNotification>(
      c.get("owner"),
      "notifications",
      c.req.param("id"),
      {},
      { read: true },
    );
    if (!notification) throw new AppError("Notification not found", 404);
    return c.json(notification);
  });
  app.post("/sample-page", async (c) => {
    if (service.config.mode !== "sample") throw new AppError("Not found", 404);
    const body = z.object({ text: z.string().max(100000) }).parse(await c.req.json());
    await service.db.put(c.get("owner"), "sample-pages", { id: "availability", text: body.text });
    return c.json({ ok: true });
  });
  return app;
}
