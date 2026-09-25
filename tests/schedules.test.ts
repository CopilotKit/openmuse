import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import {
  type AgentTask,
  type Schedule,
  scheduleInputSchema,
} from "../packages/domain/src/agent.ts";
import { CronError, nextCronRun } from "../packages/domain/src/cron.ts";
import { modelFixture } from "./helpers/model.ts";

// ---- cron parsing ----
test("cron: next daily fire is timezone-aware", () => {
  // 2026-09-22T12:00:00Z is 07:00 CDT; next 08:00 CDT is 13:00Z.
  const next = nextCronRun("0 8 * * *", "America/Chicago", new Date("2026-09-22T12:00:00Z"));
  assert.equal(next.toISOString(), "2026-09-22T13:00:00.000Z");
});
test("cron: fire times are strictly after the reference instant", () => {
  // Exactly on a */15 boundary; must return the next boundary, not this one.
  const next = nextCronRun("*/15 * * * *", "America/Chicago", new Date("2026-09-22T12:00:00Z"));
  assert.equal(next.toISOString(), "2026-09-22T12:15:00.000Z");
});
test("cron: weekly and monthly expressions resolve", () => {
  // 2026-09-22 is a Tuesday; next Monday 09:00 CDT is 2026-09-28T14:00:00Z.
  const monday = nextCronRun("0 9 * * 1", "America/Chicago", new Date("2026-09-22T12:00:00Z"));
  assert.equal(monday.toISOString(), "2026-09-28T14:00:00.000Z");
  // Next 1st of month 14:30 CDT is 2026-10-01T19:30:00Z.
  const monthly = nextCronRun("30 14 1 * *", "America/Chicago", new Date("2026-09-22T12:00:00Z"));
  assert.equal(monthly.toISOString(), "2026-10-01T19:30:00.000Z");
});
test("cron: leap-day expression fires on the next Feb 29", () => {
  // 2028-02-29 00:00 CST is 06:00Z.
  const next = nextCronRun("0 0 29 2 *", "America/Chicago", new Date("2028-02-01T00:00:00Z"));
  assert.equal(next.toISOString(), "2028-02-29T06:00:00.000Z");
});
test("cron: rejects bad expressions and timezones", () => {
  assert.throws(
    () => nextCronRun("not a cron", "America/Chicago", new Date()),
    /Expected 5 fields/,
  );
  assert.throws(() => nextCronRun("61 * * * *", "America/Chicago", new Date()), /out of range/);
  assert.throws(
    () => nextCronRun("*/0 * * * *", "America/Chicago", new Date()),
    /step must be >= 1/,
  );
  assert.throws(
    () => nextCronRun("0 8 * * *", "Mars/Olympus_Mons", new Date()),
    /Unknown timezone/,
  );
  assert.throws(() => nextCronRun("0 0 30 2 *", "UTC", new Date()), CronError);
});
test("scheduleInputSchema validates cron and defaults the timezone", () => {
  const parsed = scheduleInputSchema.parse({
    title: "Morning check",
    prompt: "Check the weather and tell me.",
    cron: "0 8 * * *",
  });
  assert.equal(parsed.timezone, "America/Chicago");
  assert.throws(
    () =>
      scheduleInputSchema.parse({
        title: "Bad",
        prompt: "Do it.",
        cron: "whenever",
      }),
    /Expected 5 fields/,
  );
});

// ---- service lifecycle ----
const makeApp = async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-schedules-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    model: "openai/fixture",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  return { directory, db, server };
};
const stop = async (harness: Awaited<ReturnType<typeof makeApp>>) => {
  await harness.server.agent.stop();
  await harness.db.close();
  await rm(harness.directory, { recursive: true, force: true });
};

test("createSchedule stores an active schedule and queues its task", async () => {
  const harness = await makeApp();
  try {
    const schedule = await harness.server.agent.createSchedule("owner", {
      title: "Morning weather",
      prompt: "Check the weather and tell me.",
      cron: "0 8 * * *",
      timezone: "America/Chicago",
    });
    assert.equal(schedule.status, "active");
    assert.equal(schedule.runs, 0);
    assert.ok(new Date(schedule.nextRunAt).getTime() > Date.now());
    const task = await harness.server.agent.getTask("owner", schedule.taskId);
    assert.equal(task.kind, "scheduled");
    assert.equal(task.status, "queued");
    const workspace = await harness.server.agent.snapshot("owner");
    assert.ok(workspace.schedules.some((s) => s.id === schedule.id));
  } finally {
    await stop(harness);
  }
});
test("createSchedule is idempotent under the same key", async () => {
  const harness = await makeApp();
  try {
    const first = await harness.server.agent.createSchedule(
      "owner",
      { title: "Weekly", prompt: "Weekly digest.", cron: "0 9 * * 1" },
      "weekly-key",
    );
    const second = await harness.server.agent.createSchedule(
      "owner",
      { title: "Weekly", prompt: "Weekly digest.", cron: "0 9 * * 1" },
      "weekly-key",
    );
    assert.equal(first.id, second.id);
    assert.equal((await harness.db.list<Schedule>("owner", "schedules")).length, 1);
  } finally {
    await stop(harness);
  }
});
test("controlSchedule moves the schedule and its task through pause/resume/stop/run", async () => {
  const harness = await makeApp();
  try {
    const schedule = await harness.server.agent.createSchedule("owner", {
      title: "Hourly ping",
      prompt: "Ping.",
      cron: "0 * * * *",
    });
    const taskOf = async () =>
      harness.server.agent.getTask("owner", schedule.taskId) as Promise<AgentTask>;
    let controlled = await harness.server.agent.controlSchedule("owner", schedule.id, "pause");
    assert.equal(controlled.status, "paused");
    assert.equal((await taskOf()).status, "paused");
    controlled = await harness.server.agent.controlSchedule("owner", schedule.id, "resume");
    assert.equal(controlled.status, "active");
    assert.equal((await taskOf()).status, "queued");
    controlled = await harness.server.agent.controlSchedule("owner", schedule.id, "run");
    assert.equal((await taskOf()).status, "queued");
    controlled = await harness.server.agent.controlSchedule("owner", schedule.id, "stop");
    assert.equal(controlled.status, "stopped");
    assert.equal((await taskOf()).status, "cancelled");
    await assert.rejects(
      harness.server.agent.controlSchedule("owner", schedule.id, "resume"),
      /Create a new schedule/,
    );
  } finally {
    await stop(harness);
  }
});
test("invalid cron is rejected by createSchedule", async () => {
  const harness = await makeApp();
  try {
    await assert.rejects(
      harness.server.agent.createSchedule("owner", {
        title: "Bad",
        prompt: "Never runs.",
        cron: "61 * * * *",
      }),
      /out of range/,
    );
  } finally {
    await stop(harness);
  }
});

// ---- full run through the model worker ----
test("a scheduled run executes its prompt, notifies, and reschedules", async (t) => {
  const harness = await makeApp();
  const calls = [
    { name: "finish_task", arguments: { summary: "Weather checked: sunny, 72 degrees." } },
  ];
  const { requests } = await modelFixture(t, (index) => calls[index]);
  try {
    const schedule = await harness.server.agent.createSchedule("owner", {
      title: "Morning weather",
      prompt: "Check the weather and tell me.",
      cron: "*/5 * * * *",
      timezone: "America/Chicago",
    });
    const firstFire = schedule.nextRunAt;
    await harness.server.agent.worker.tick();
    const task = await harness.server.agent.getTask("owner", schedule.taskId);
    assert.equal(task.status, "scheduled", task.error ?? task.question);
    assert.equal(task.result, "Weather checked: sunny, 72 degrees.");
    const updated = await harness.db.get<Schedule>("owner", "schedules", schedule.id);
    assert.equal(updated?.runs, 1);
    assert.ok(updated?.lastRunAt);
    assert.ok(
      new Date(updated?.nextRunAt ?? 0).getTime() > new Date(firstFire).getTime(),
      `nextRunAt advanced past the first fire (${firstFire} -> ${updated?.nextRunAt})`,
    );
    const workspace = await harness.server.agent.snapshot("owner");
    assert.ok(
      workspace.notifications.some(
        (n) => n.title === "Morning weather" && n.body.includes("sunny"),
      ),
      "run outcome surfaced as a notification",
    );
    assert.ok(
      requests.length > 0 && requests.every((request) => request.path === "/v1/responses"),
      "the scheduled run called the model",
    );
    assert.ok(
      requests[0].body.includes('"name":"finish_task"'),
      "the scheduled run exposes the worker tool set",
    );
  } finally {
    await stop(harness);
  }
});

// ---- API routes ----
test("schedule API routes create and control schedules", async () => {
  const harness = await makeApp();
  try {
    const session = await harness.server.app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(session.status, 200);
    const token = (await session.json()).token;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const created = await harness.server.app.request("/api/agent/schedules", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Evening news",
        prompt: "Summarize the day's headlines.",
        cron: "0 20 * * *",
        timezone: "America/Chicago",
      }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const schedule = (await created.json()) as Schedule;
    assert.equal(schedule.status, "active");
    const bad = await harness.server.app.request("/api/agent/schedules", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Bad", prompt: "x", cron: "61 * * * *" }),
    });
    assert.equal(bad.status, 422);
    const paused = await harness.server.app.request(`/api/agent/schedules/${schedule.id}/control`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "pause" }),
    });
    assert.equal(paused.status, 200, await paused.clone().text());
    assert.equal(((await paused.json()) as Schedule).status, "paused");
    const snapshot = await harness.server.app.request("/api/agent", { headers });
    assert.equal(snapshot.status, 200);
    assert.ok(
      ((await snapshot.json()) as { schedules: Schedule[] }).schedules.some(
        (s) => s.id === schedule.id,
      ),
    );
  } finally {
    await stop(harness);
  }
});
