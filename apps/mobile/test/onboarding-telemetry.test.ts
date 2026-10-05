import assert from "node:assert/strict";
import { test } from "node:test";
import { createOnboardingTelemetry, hasFreshAnswer } from "../src/onboarding-telemetry";

function fixture() {
  let value: string | null = null,
    sequence = 0,
    disabled = false,
    status = 503,
    now = 100000;
  const sent: { id: string; event: unknown }[] = [];
  const options = {
    storage: {
      read: async () => value,
      write: async (v: string) => {
        value = v;
      },
      remove: async () => {
        value = null;
      },
    },
    randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    now: () => now,
    disabled: () => disabled,
    platform: "web" as const,
    version: "0.1.0",
    send: async (id: string, event: unknown) => {
      sent.push({ id, event });
      return status;
    },
  };
  return {
    options,
    sent,
    get value() {
      return value;
    },
    set value(v) {
      value = v;
    },
    set disabled(v: boolean) {
      disabled = v;
    },
    set status(v: number) {
      status = v;
    },
    get now() {
      return now;
    },
    set now(v: number) {
      now = v;
    },
  };
}
test("durable identity, stable retries and once-only abandonment survive restart", async () => {
  const f = fixture(),
    a = createOnboardingTelemetry(f.options);
  await a.start();
  await a.stepViewed("welcome");
  await a.flush();
  a.close();
  const original = JSON.parse(f.value || "{}");
  const b = createOnboardingTelemetry(f.options);
  await b.start();
  assert.equal(JSON.parse(f.value || "{}").installation_id, original.installation_id);
  assert.equal(
    JSON.parse(f.value || "{}").queue.filter(
      (x: { envelope: { event: string } }) => x.envelope.event === "oss.onboarding.setup_abandoned",
    ).length,
    1,
  );
  f.now += 10000;
  f.status = 202;
  await b.flush();
  assert.equal(f.sent[0].id, f.sent[1].id);
  assert.deepEqual(JSON.parse(f.value || "{}").queue, []);
  b.close();
});
test("closed persistence, bounded queue, concurrent mutations, activation dedupe and optout", async () => {
  const f = fixture(),
    a = createOnboardingTelemetry(f.options);
  await a.start();
  await Promise.all(Array.from({ length: 270 }, () => a.setupFailed("connect", "network")));
  assert.equal(JSON.parse(f.value || "{}").queue.length, 256);
  await a.activated();
  await a.activated();
  assert.equal(
    JSON.parse(f.value || "{}").queue.filter(
      (x: { envelope: { event: string } }) => x.envelope.event === "oss.onboarding.activated",
    ).length,
    1,
  );
  f.disabled = true;
  await a.flush();
  assert.equal(f.value, null);
  assert.equal(f.sent.length, 0);
  a.close();
  const g = fixture();
  g.value = JSON.stringify({ version: 1, installation_id: "secret", queue: [], prompt: "private" });
  const b = createOnboardingTelemetry(g.options);
  await b.start();
  assert.equal(g.value?.includes("private"), false);
  b.close();
});
test("storage failure suppresses sends and fresh answers exclude replay and empty output", async () => {
  const f = fixture();
  f.options.storage.write = async () => {
    throw Error("disk");
  };
  const a = createOnboardingTelemetry(f.options);
  await a.start();
  await a.stepViewed("welcome");
  await a.flush();
  assert.equal(f.sent.length, 0);
  a.close();
  const before = [{ id: "a", role: "assistant", content: "old" }];
  assert.equal(hasFreshAnswer(before, before), false);
  assert.equal(
    hasFreshAnswer(before, [...before, { id: "b", role: "assistant", content: "" }]),
    false,
  );
  assert.equal(hasFreshAnswer(before, [{ id: "a", role: "assistant", content: "old new" }]), true);
});
test("retry attempts expire without tight loops and reject persisted private properties", async () => {
  const f = fixture(),
    a = createOnboardingTelemetry(f.options);
  await a.start();
  await a.stepViewed("welcome");
  for (let i = 0; i < 12; i++) {
    await a.flush();
    f.now += 61000;
  }
  assert.equal(f.sent.length, 10);
  assert.equal(JSON.parse(f.value || "{}").queue.length, 0);
  a.close();
  const original = JSON.parse(f.value || "{}");
  original.queue = [
    {
      envelope: {
        event: "oss.onboarding.activated",
        properties: { prompt: "private" },
        event_id: original.installation_id,
        ts: 1,
        global_properties: {
          accessibility_title: "OpenMuse",
          platform: "web",
          app_version: "0.1.0",
        },
        package: { name: "openmuse-client", version: "0.1.0" },
      },
      attempts: 0,
      next: 0,
      created: 1,
    },
  ];
  f.value = JSON.stringify(original);
  const b = createOnboardingTelemetry(f.options);
  await b.start();
  assert.equal(f.value?.includes("private"), false);
  b.close();
});
test("pending link retains event UUID across offline restart and server optout purges", async () => {
  const f = fixture();
  let linkStatus = false;
  const ids: string[] = [];
  const options = {
    ...f.options,
    link: async (body: { event_id: string }) => {
      ids.push(body.event_id);
      if (!linkStatus) throw Error("offline");
      return { enabled: false, linked: false };
    },
  };
  const a = createOnboardingTelemetry(options);
  await a.start();
  await a.linkSession();
  await a.flush();
  a.close();
  f.now += 61000;
  const b = createOnboardingTelemetry(options);
  await b.start();
  linkStatus = true;
  await b.flush();
  assert.equal(ids[0], ids[1]);
  assert.equal(f.value, null);
  b.close();
});
test("real local HTTP delivery replays a durable offline event with unchanged identity", async () => {
  const { createServer } = await import("node:http");
  const received: { id: unknown; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({ id: req.headers["x-copilotkit-telemetry-id"], body });
      res.writeHead(202);
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const f = fixture();
  let online = false;
  const options = {
    ...f.options,
    send: async (id: string, event: unknown) => {
      if (!online) throw Error("offline");
      return (
        await fetch(`http://127.0.0.1:${address.port}`, {
          method: "POST",
          headers: { "X-CopilotKit-Telemetry-Id": id },
          body: JSON.stringify(event),
        })
      ).status;
    },
  };
  const a = createOnboardingTelemetry(options);
  await a.start();
  await a.stepViewed("welcome");
  await a.flush();
  const persisted = JSON.parse(f.value || "{}");
  a.close();
  const b = createOnboardingTelemetry(options);
  try {
    online = true;
    f.now += 61000;
    await b.start();
    await b.flush();
    assert.equal(received[0].id, persisted.installation_id);
    assert.equal(JSON.parse(received[0].body).event_id, persisted.queue[0].envelope.event_id);
    assert.equal(JSON.parse(f.value || "{}").queue.length, 0);
  } finally {
    b.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("recording persists while a delivery is pending and later ready items are not starved", async () => {
  const f = fixture();
  let release: (status: number) => void = () => {};
  let begin: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    begin = resolve;
  });
  let first = true;
  const options = {
    ...f.options,
    send: async () => {
      if (first) {
        first = false;
        begin();
        return new Promise<number>((resolve) => {
          release = resolve;
        });
      }
      return 503;
    },
  };
  const a = createOnboardingTelemetry(options);
  await a.start();
  await a.stepViewed("welcome");
  const flushing = a.flush();
  await entered;
  await a.activated();
  assert.equal(JSON.parse(f.value || "{}").activated, true);
  release(202);
  await flushing;
  assert.equal(JSON.parse(f.value || "{}").queue[0].envelope.event, "oss.onboarding.activated");
  a.close();
  const g = fixture(),
    b = createOnboardingTelemetry(g.options);
  await b.start();
  await Promise.all(Array.from({ length: 17 }, () => b.setupFailed("connect", "network")));
  await b.flush();
  assert.equal(g.sent.length, 16);
  await b.flush();
  assert.equal(g.sent.length, 17);
  b.close();
});
