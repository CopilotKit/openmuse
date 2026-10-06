import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { shutdownOnce } from "../apps/server/src/shutdown.ts";

/**
 * A server holding one long-lived streaming response, the way /api/copilotkit/* does while a chat
 * turn is running. `server.close()` only calls back once every connection has ended, so this is the
 * shape that decides whether a stop can finish at all.
 */
async function serverHoldingAnOpenStream(): Promise<{
  server: Server;
  close: () => Promise<void>;
}> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: open\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  // Hold a response open, and never finish it. The request is expected to be cut when the
  // connections are dropped, so its failure is the point rather than a test failure.
  void fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/stream`).catch(
    () => {},
  );
  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function recorder() {
  const calls: string[] = [];
  return {
    calls,
    agent: {
      stop: async () => {
        calls.push("agent.stop");
      },
    },
    db: {
      close: async () => {
        calls.push("db.close");
      },
    },
  };
}

test("an open event stream does not stop the server shutting down", async () => {
  const { server, close } = await serverHoldingAnOpenStream();
  const seen = recorder();

  const outcome = await shutdownOnce({
    server,
    agent: seen.agent,
    db: seen.db,
    drainMs: 50,
  });

  // Before this existed, `server.close()` waited on the open stream and this never resolved, so
  // agent.stop() never ran and the in-flight turn was never aborted.
  assert.equal(outcome, "drained");
  assert.deepEqual(seen.calls, ["agent.stop", "db.close"]);
  await close();
});

test("a stop that never settles still leaves the process", async () => {
  const { server, close } = await serverHoldingAnOpenStream();
  let forced = false;
  // Every timer in here is unref'd on purpose, and this stop never settles, so nothing would be
  // holding the loop open for the backstop to fire in.
  const hold = setInterval(() => {}, 20);

  try {
    // Deliberately not awaited: a stop that hangs is exactly what this is about, so the sequence
    // never gets past agent.stop() and the backstop is the only thing that can end it.
    void shutdownOnce({
      server,
      agent: {
        stop: () => new Promise<void>(() => {}),
      },
      db: { close: async () => {} },
      drainMs: 50,
      forceExitAfterMs: 100,
      forceExit: () => {
        forced = true;
      },
    });

    const until = Date.now() + 5_000;
    while (!forced && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    clearInterval(hold);
    await close();
  }

  assert.equal(forced, true);
});

test("shutting down twice does not stop the agent twice", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const seen = recorder();
  const target = {
    server,
    agent: seen.agent,
    db: seen.db,
    drainMs: 50,
  };

  let stopping = false;
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    void shutdownOnce(target);
  };

  onSignal();
  onSignal();
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.deepEqual(seen.calls, ["agent.stop", "db.close"]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
