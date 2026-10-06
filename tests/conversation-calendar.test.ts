import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { EventSchemas, EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import type { CalendarEvent } from "../packages/domain/src/index.ts";
import { encryptSecret } from "../packages/integrations/src/vault.ts";
import { browserFixture } from "./helpers/browser.ts";
import { modelFixture } from "./helpers/model.ts";

const range = {
  timeMin: "2026-10-10T13:00:00-07:00",
  timeMax: "2026-10-10T17:00:00-07:00",
};
const visit: CalendarEvent = {
  id: "visit",
  calendarId: "primary",
  title: "Museum visit",
  start: "2026-10-10T12:00:00-07:00",
  end: "2026-10-10T14:00:00-07:00",
  allDay: false,
  timeZone: "America/Los_Angeles",
  location: "Community museum",
  description: "Meet at the entrance.",
  attendees: [],
};

async function fixture(
  t: TestContext,
  google?: (request: Request) => Response | Promise<Response>,
) {
  const browser = await browserFixture(t, () => {
    throw new Error("Calendar reads must not use the browser");
  });
  const config = {
    ...browser.config,
    mode: google ? ("live" as const) : ("sample" as const),
    agentBackend: "model" as const,
    model: "openai/fixture",
    encryptionKey: randomBytes(32).toString("base64"),
  };
  if (google) {
    const fetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      return new URL(request.url).hostname === "www.googleapis.com"
        ? google(request)
        : fetch(input, init);
    });
    await browser.db.put("local-user", "credentials", {
      id: "google",
      connectionId: "calendar-connection",
      secret: encryptSecret(
        JSON.stringify({
          connectionId: "calendar-connection",
          accessToken: "synthetic-calendar-token",
          expiresAt: Date.now() + 3600000,
          scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
          account: "reader@example.com",
        }),
        config.encryptionKey,
      ),
    });
  }
  const server = await createApp(browser.db, config);
  t.after(() => server.agent.stop());
  return {
    ...browser,
    ...server,
    conversation: new ConversationAgent(config, server.agent, "local-user"),
  };
}

async function read(conversation: ConversationAgent) {
  const input: RunAgentInput = {
    threadId: "calendar-chat",
    runId: randomUUID(),
    messages: [
      { id: randomUUID(), role: "user", content: "What is on my calendar that afternoon?" },
    ],
    tools: [],
    context: [],
    state: {},
  };
  const events = (await lastValueFrom(conversation.run(input).pipe(toArray()))).map((event) =>
    EventSchemas.parse(event),
  );
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(
    result && result.type === EventType.TOOL_CALL_RESULT,
    "Expected a calendar tool result",
  );
  return JSON.parse(result.content);
}

test("chat reads overlapping primary calendar events for its owner without creating work", async (t) => {
  const { requests } = await modelFixture(t, (index) =>
    index === 0 ? { name: "read_calendar", arguments: range } : undefined,
  );
  const f = await fixture(t);
  await f.db.put("local-user", "events", visit);
  await f.db.put("another-owner", "events", { ...visit, title: "PRIVATE FOREIGN EVENT" });
  await f.db.put("local-user", "events", { ...visit, id: "other", calendarId: "shared" });
  await f.db.put("local-user", "events", { ...visit, id: "past", end: range.timeMin });
  await f.db.put("local-user", "events", { ...visit, id: "later", start: range.timeMax });
  const actions = await f.db.list("local-user", "actions");
  assert.deepEqual(await read(f.conversation), {
    calendarId: "primary",
    ...range,
    events: [
      {
        id: visit.id,
        calendarId: "primary",
        title: visit.title,
        start: visit.start,
        end: visit.end,
        allDay: false,
        timeZone: visit.timeZone,
        location: visit.location,
        description: visit.description,
      },
    ],
    truncated: false,
  });
  assert.equal(requests.length, 2);
  assert.match(requests[0].body, /For calendar questions, use read_calendar/);
  assert.ok(requests[1].body.includes("Museum visit"));
  assert.ok(!requests[1].body.includes("PRIVATE FOREIGN EVENT"));
  assert.equal((await f.db.list("local-user", "tasks")).length, 0);
  assert.deepEqual(await f.db.list("local-user", "actions"), actions);
});

test("chat distinguishes a disconnected calendar from a connected empty range", async (t) => {
  await modelFixture(t, (index) =>
    index % 2 === 0 ? { name: "read_calendar", arguments: range } : undefined,
  );
  const f = await fixture(t);
  await f.db.put("local-user", "settings", { id: "google", enabled: false });
  assert.match((await read(f.conversation)).error, /disconnected/i);
  assert.deepEqual(await f.workspace.events("local-user", range), []);
  await f.db.put("local-user", "settings", { id: "google", enabled: true });
  assert.deepEqual(await read(f.conversation.clone()), {
    calendarId: "primary",
    ...range,
    events: [],
    truncated: false,
  });
});

test("chat rejects missing, ambiguous, reversed and excessive calendar ranges", async (t) => {
  let arguments_: object = range;
  await modelFixture(t, (index) =>
    index % 2 === 0 ? { name: "read_calendar", arguments: arguments_ } : undefined,
  );
  const f = await fixture(t);
  for (const invalid of [
    { timeMin: range.timeMin },
    { ...range, timeMin: "2026-10-10T13:00:00" },
    { ...range, timeMin: "tomorrow" },
    { ...range, timeMin: "2026-02-30T13:00:00Z" },
    { ...range, timeMax: range.timeMin },
    { timeMin: range.timeMax, timeMax: range.timeMin },
    { timeMin: "2026-01-01T00:00:00Z", timeMax: "2027-01-03T00:00:00Z" },
  ]) {
    arguments_ = invalid;
    assert.equal(typeof (await read(f.conversation)).error, "string", JSON.stringify(invalid));
  }
  arguments_ = { timeMin: "2026-01-01T00:00:00Z", timeMax: "2027-01-02T00:00:00Z" };
  assert.equal((await read(f.conversation)).truncated, false);
});

test("chat preserves Google all-day dates and time zones and reports a sparse partial page", async (t) => {
  const { requests } = await modelFixture(t, (index) =>
    index === 0 ? { name: "read_calendar", arguments: range } : undefined,
  );
  const calls: URL[] = [];
  const f = await fixture(t, (request) => {
    assert.equal(request.method, "GET");
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-calendar-token");
    const url = new URL(request.url);
    calls.push(url);
    assert.equal(url.pathname, "/calendar/v3/calendars/primary/events");
    assert.equal(url.searchParams.get("timeMin"), range.timeMin);
    assert.equal(url.searchParams.get("timeMax"), range.timeMax);
    assert.equal(url.searchParams.get("maxResults"), "100");
    assert.equal(url.searchParams.get("singleEvents"), "true");
    assert.equal(url.searchParams.get("orderBy"), "startTime");
    return Response.json({
      timeZone: "America/Los_Angeles",
      nextPageToken: "next-page",
      items: [
        {
          id: "holiday",
          summary: "Museum day",
          start: { date: "2026-10-10" },
          end: { date: "2026-10-11" },
        },
        {
          id: visit.id,
          summary: visit.title,
          start: { dateTime: visit.start, timeZone: visit.timeZone },
          end: { dateTime: visit.end },
          location: visit.location,
          description: visit.description,
        },
      ],
    });
  });
  const result = await read(f.conversation);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.events[0], {
    id: "holiday",
    calendarId: "primary",
    title: "Museum day",
    start: "2026-10-10",
    end: "2026-10-11",
    allDay: true,
    timeZone: "America/Los_Angeles",
    location: "",
    description: "",
  });
  assert.equal(result.events[1].start, visit.start);
  assert.equal(result.events[1].timeZone, visit.timeZone);
  assert.equal(calls.length, 1);
  assert.ok(requests[1].body.includes("Museum day"));
});

test("chat bounds event count and text and marks both kinds of truncation", async (t) => {
  await modelFixture(t, (index) =>
    index % 2 === 0 ? { name: "read_calendar", arguments: range } : undefined,
  );
  const f = await fixture(t);
  await f.db.put("local-user", "events", {
    ...visit,
    title: "T".repeat(501),
    location: "L".repeat(501),
    description: "D".repeat(2001),
  });
  const text = await read(f.conversation);
  assert.equal(text.truncated, true);
  assert.equal(text.events[0].title.length, 500);
  assert.equal(text.events[0].location.length, 500);
  assert.equal(text.events[0].description.length, 2000);
  await f.db.put("local-user", "events", visit);
  for (let i = 0; i < 19; i++)
    await f.db.put("local-user", "events", { ...visit, id: `visit-${i}` });
  const complete = await read(f.conversation);
  assert.equal(complete.events.length, 20);
  assert.equal(complete.truncated, false);
  await f.db.put("local-user", "events", { ...visit, id: "one-more" });
  const partial = await read(f.conversation);
  assert.equal(partial.events.length, 20);
  assert.equal(partial.truncated, true);
});

test("sample calendar overlap uses all-day event zones across UTC dates and daylight saving", async (t) => {
  let arguments_: object = {
    timeMin: "2026-10-10T20:00:00-07:00",
    timeMax: "2026-10-10T21:00:00-07:00",
  };
  await modelFixture(t, (index) =>
    index % 2 === 0 ? { name: "read_calendar", arguments: arguments_ } : undefined,
  );
  const f = await fixture(t);
  const holiday = { ...visit, allDay: true, start: "2026-10-10", end: "2026-10-11" };
  await f.db.put("local-user", "events", holiday);
  assert.equal((await read(f.conversation)).events[0]?.id, visit.id);
  arguments_ = { timeMin: "2026-10-11T00:00:00-07:00", timeMax: "2026-10-11T01:00:00-07:00" };
  assert.deepEqual((await read(f.conversation)).events, []);
  await f.db.put("local-user", "events", { ...holiday, timeZone: "Asia/Tokyo" });
  arguments_ = { timeMin: "2026-10-09T23:00:00Z", timeMax: "2026-10-10T00:00:00Z" };
  assert.equal((await read(f.conversation)).events[0]?.id, visit.id);
  await f.db.put("local-user", "events", { ...holiday, start: "2026-11-01", end: "2026-11-02" });
  arguments_ = { timeMin: "2026-11-01T23:00:00-08:00", timeMax: "2026-11-02T00:00:00-08:00" };
  assert.equal((await read(f.conversation)).events[0]?.id, visit.id);
  arguments_ = { timeMin: "2026-11-02T00:00:00-08:00", timeMax: "2026-11-02T01:00:00-08:00" };
  assert.deepEqual((await read(f.conversation)).events, []);
});

test("chat reports Google permission, server and network failures without claiming empty success", async (t) => {
  let failure: "permission" | "server" | "network" = "permission";
  const { requests } = await modelFixture(t, (index) =>
    index % 2 === 0 ? { name: "read_calendar", arguments: range } : undefined,
  );
  let reads = 0;
  const f = await fixture(t, () => {
    reads++;
    if (failure === "network") throw new TypeError("Calendar connection interrupted");
    return Response.json(
      {
        error: {
          message: failure === "permission" ? "Calendar scope denied" : "Calendar unavailable",
        },
      },
      { status: failure === "permission" ? 403 : 503 },
    );
  });
  for (const [kind, expected] of [
    ["permission", /403.*scope denied/],
    ["server", /503.*unavailable/],
    ["network", /Could not reach Google/],
  ] as const) {
    failure = kind;
    const result = await read(f.conversation);
    assert.match(result.error, expected);
    assert.equal("events" in result, false);
  }
  assert.equal(reads, 3);
  assert.ok(requests[1].body.includes("Calendar scope denied"));
  assert.ok(requests[3].body.includes("Calendar unavailable"));
  assert.equal((await f.db.list("local-user", "tasks")).length, 0);
  assert.equal((await f.db.list("local-user", "actions")).length, 0);
});

test("chat clipping preserves Unicode characters at the output boundary", async (t) => {
  await modelFixture(t, (index) =>
    index === 0 ? { name: "read_calendar", arguments: range } : undefined,
  );
  const f = await fixture(t);
  await f.db.put("local-user", "events", {
    ...visit,
    title: `${"T".repeat(499)}🚀`,
    location: `${"L".repeat(499)}🚀`,
    description: `${"D".repeat(1999)}🚀`,
  });
  const result = await read(f.conversation);
  assert.equal(result.truncated, true);
  assert.equal(result.events[0].title, "T".repeat(499));
  assert.equal(result.events[0].location, "L".repeat(499));
  assert.equal(result.events[0].description, "D".repeat(1999));
});

test("live chat validates before dispatch and never substitutes cached or another owner's calendar", async (t) => {
  let arguments_: object = { ...range, timeMax: range.timeMin };
  await modelFixture(t, (index) =>
    index % 2 === 0 ? { name: "read_calendar", arguments: arguments_ } : undefined,
  );
  let reads = 0;
  let nextPageToken: string | undefined;
  const f = await fixture(t, () => {
    reads++;
    return Response.json({ items: [], nextPageToken });
  });
  assert.equal(typeof (await read(f.conversation)).error, "string");
  assert.equal(reads, 0);
  await f.db.put("local-user", "events", { ...visit, title: "PRIVATE CACHED EVENT" });
  arguments_ = { ...range, calendarId: "shared", owner: "another-owner" };
  assert.deepEqual(await read(f.conversation), {
    calendarId: "primary",
    ...range,
    events: [],
    truncated: false,
  });
  nextPageToken = "next-page";
  assert.deepEqual(await read(f.conversation), {
    calendarId: "primary",
    ...range,
    events: [],
    truncated: true,
  });
  assert.equal(reads, 2);
  const credential = await f.db.get<{ id: string; secret: string }>(
    "local-user",
    "credentials",
    "google",
  );
  assert.ok(credential);
  await f.db.put("another-owner", "credentials", credential);
  await f.db.remove("local-user", "credentials", "google");
  assert.match((await read(f.conversation)).error, /disconnected/i);
  assert.equal(reads, 2);
});

test("valid all-day sample events survive a skipped midnight and unrelated range queries", async (t) => {
  let arguments_: object = {
    timeMin: "2026-09-06T01:00:00-03:00",
    timeMax: "2026-09-06T02:00:00-03:00",
  };
  await modelFixture(t, (index) =>
    index % 2 === 0 ? { name: "read_calendar", arguments: arguments_ } : undefined,
  );
  const f = await fixture(t);
  await f.db.put("local-user", "events", {
    ...visit,
    allDay: true,
    start: "2026-09-06",
    end: "2026-09-07",
    timeZone: "America/Santiago",
  });
  assert.equal((await read(f.conversation)).events[0]?.id, visit.id);
  arguments_ = { timeMin: "2026-09-05T23:00:00-04:00", timeMax: "2026-09-06T01:00:00-03:00" };
  assert.deepEqual((await read(f.conversation)).events, []);
  arguments_ = { timeMin: "2026-09-06T01:00:00-03:00", timeMax: "2026-09-06T01:00:00.001-03:00" };
  assert.equal((await read(f.conversation)).events[0]?.id, visit.id);
  arguments_ = range;
  assert.deepEqual((await read(f.conversation)).events, []);
  const { token } = await f.auth.session();
  const response = await f.app.request(`/api/calendar/events?${new URLSearchParams(range)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
});

test("all-day sample date comparisons preserve ISO years before 1000", async (t) => {
  let arguments_: object = range;
  await modelFixture(t, (index) =>
    index % 2 === 0 ? { name: "read_calendar", arguments: arguments_ } : undefined,
  );
  const f = await fixture(t);
  for (const year of ["0000", "0001", "0099", "0999"]) {
    await f.db.put("local-user", "events", {
      ...visit,
      allDay: true,
      start: `${year}-10-10`,
      end: `${year}-10-11`,
      timeZone: "UTC",
    });
    arguments_ = { timeMin: `${year}-10-10T12:00:00Z`, timeMax: `${year}-10-10T13:00:00Z` };
    assert.equal((await read(f.conversation)).events[0]?.id, visit.id, year);
    arguments_ = { timeMin: `${year}-10-11T00:00:00Z`, timeMax: `${year}-10-11T01:00:00Z` };
    assert.deepEqual((await read(f.conversation)).events, [], year);
  }
});

test("all-day sample overlap follows local dates past the last RFC3339 year", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "read_calendar",
          arguments: { timeMin: "9999-12-30T00:00:00Z", timeMax: "9999-12-31T23:00:00Z" },
        }
      : undefined,
  );
  const f = await fixture(t);
  await f.db.put("local-user", "events", {
    ...visit,
    allDay: true,
    start: "9999-12-30",
    end: "9999-12-31",
    timeZone: "Pacific/Kiritimati",
  });
  assert.equal((await read(f.conversation)).events[0]?.id, visit.id);
});
