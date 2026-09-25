import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { modelFixture } from "./helpers/model.ts";

const shop = "https://shop.example/";
type ModelCall = { name: string; arguments: object };

test("a task operates a page and pauses for the person before a consequential step", async (t) => {
  const acts: Record<string, unknown>[] = [];
  const worker = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const path = request.url ?? "";
    const id = path.split("/")[2] ?? body.id;
    const session = { id, title: "Shop", url: shop, status: "active", updatedAt: new Date(0) };
    const send = (status: number, data: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(data));
    };
    if (path.endsWith("/read"))
      return send(200, { url: shop, title: "Shop", text: "Order", truncated: false });
    if (path.endsWith("/elements"))
      return send(200, {
        url: shop,
        title: "Shop",
        elements: [
          { ref: 1, role: "textbox", name: "Name", inView: true },
          { ref: 2, role: "button", name: "Place order", needsConfirmation: true, inView: true },
          { ref: 3, role: "button", name: "Delete account", needsConfirmation: true, inView: true },
        ],
        truncated: false,
        scroll: { y: 0, height: 800, viewport: 800 },
      });
    if (path.endsWith("/act")) {
      acts.push(body);
      if (body.action === "click" && body.confirmed !== true)
        return send(409, {
          error: {
            code: "CONFIRMATION_REQUIRED",
            message:
              "Clicking “Place order” may buy, send, submit, delete, book or sign up for something. Ask the person to confirm this exact step in chat, then repeat it with confirmedByUser set to true.",
          },
        });
      return send(200, { ...session, target: body.ref === 1 ? "Name" : "Place order" });
    }
    return send(201, session);
  });
  worker.listen(0, "127.0.0.1");
  await once(worker, "listening");
  const address = worker.address();
  assert(address && typeof address !== "string");
  t.after(() => {
    worker.closeAllConnections();
    worker.close();
  });

  // Run 1 asks before ordering; run 2 starts after the person answers.
  const first: ModelCall[] = [
    { name: "read_web", arguments: { url: shop } },
    { name: "page_elements", arguments: {} },
    { name: "page_act", arguments: { action: "type", ref: 1, text: "Asem", key: null } },
    { name: "page_act", arguments: { action: "click", ref: 2 } },
  ];
  const second: ModelCall[] = [
    // Resumed runs often redo earlier steps first; that must not use up the approval.
    { name: "page_act", arguments: { action: "type", ref: 1, text: "Asem" } },
    { name: "page_act", arguments: { action: "click", ref: 3, confirmedByUser: true } },
    { name: "page_act", arguments: { action: "click", ref: 2, confirmedByUser: true } },
    { name: "finish_task", arguments: { summary: "Placed the order for Asem." } },
  ];
  let run = first;
  let step = 0;
  const fixture = await modelFixture(t, (index) => {
    if (run === first && fixture.requests[index].body.includes("to let me do it")) {
      run = second;
      step = 0;
      return undefined;
    }
    return run[step++];
  });

  const directory = await mkdtemp(join(tmpdir(), "openmuse-task-page-"));
  const db = await createStore();
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    intelligenceApiKey: "test-project-key-never-sent",
    model: "openai/fixture",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    workerUrl: `http://127.0.0.1:${address.port}`,
    workerToken: "test-worker-token-at-least-32-characters",
  });
  try {
    const task = await server.agent.createTask("owner", {
      prompt: "Order a pizza for Asem on shop.example",
      kind: "agent",
    });
    await server.agent.worker.tick();
    const paused = await server.agent.detail("owner", task.id);
    assert.equal(paused.task.status, "waiting_input", paused.task.error ?? undefined);
    assert.match(paused.task.question ?? "", /^Clicking “Place order” may buy/);
    assert.match(paused.task.question ?? "", /Reply “yes” to let me do it/);
    assert.deepEqual(paused.task.state.pendingStep, { action: "click", ref: 2, url: shop });
    assert.deepEqual(
      acts.map((act) => [act.action, act.ref, act.confirmed]),
      [
        ["type", 1, false],
        ["click", 2, false],
      ],
    );
    assert.equal(acts[0].key, undefined, "null fields are dropped before reaching the worker");

    await server.agent.answer("owner", task.id, "yes, place it");
    await server.agent.worker.tick();
    const done = await server.agent.detail("owner", task.id);
    assert.equal(done.task.status, "succeeded", done.task.error ?? done.task.question);
    assert.equal(done.task.result, "Placed the order for Asem.");
    assert.deepEqual(
      acts.map((act) => [act.action, act.ref, act.confirmed]),
      [
        ["type", 1, false],
        ["click", 2, false],
        ["type", 1, false],
        ["click", 2, true],
      ],
      "confirming a step the task never asked about does not reach the worker",
    );
    assert.equal(done.task.state.pendingStep, null);
    assert.ok(done.events.some((event) => event.title === "Clicked “Place order”"));
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
