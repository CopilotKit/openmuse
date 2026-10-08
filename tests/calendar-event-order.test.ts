import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import type { Files } from "../apps/server/src/files.ts";
import type { GoogleAuth } from "../apps/server/src/google-auth.ts";
import { WorkspaceService } from "../apps/server/src/workspace.ts";
import type { CalendarEvent } from "../packages/domain/src/index.ts";

test("calendar reads sort timed events by instant rather than offset text", async () => {
  const db = await createStore();
  try {
    const workspace = new WorkspaceService(
      db,
      { mode: "sample", agentBackend: "sample" } as Config,
      { list: async () => [] } as unknown as Files,
      {} as GoogleAuth,
    );
    const event = (id: string, start: string, end: string): CalendarEvent => ({
      id,
      calendarId: "primary",
      title: id,
      start,
      end,
      allDay: false,
      timeZone: "UTC",
      location: "",
      description: "",
      attendees: [],
    });
    // The event with the later-looking local clock actually starts first.
    await db.put(
      "owner",
      "events",
      event("later", "2026-10-10T09:00:00-07:00", "2026-10-10T10:00:00-07:00"),
    );
    await db.put(
      "owner",
      "events",
      event("earlier", "2026-10-10T14:00:00+00:00", "2026-10-10T15:00:00+00:00"),
    );
    const ids = (events: CalendarEvent[]) => events.map(({ id }) => id);
    assert.deepEqual(ids(await workspace.events("owner")), ["earlier", "later"]);
    assert.deepEqual(ids((await workspace.snapshot("owner")).events), ["earlier", "later"]);
    assert.deepEqual(ids((await workspace.sectionSnapshot("owner", "calendar")).events ?? []), [
      "earlier",
      "later",
    ]);
  } finally {
    await db.close();
  }
});

test("calendar reads place an all-day event at the start of its own day", async () => {
  const db = await createStore();
  try {
    const workspace = new WorkspaceService(
      db,
      { mode: "sample", agentBackend: "sample" } as Config,
      { list: async () => [] } as unknown as Files,
      {} as GoogleAuth,
    );
    const event = (
      id: string,
      start: string,
      end: string,
      allDay = false,
      timeZone = "America/Los_Angeles",
    ): CalendarEvent => ({
      id,
      calendarId: "primary",
      title: id,
      start,
      end,
      allDay,
      timeZone,
      location: "",
      description: "",
      attendees: [],
    });
    await db.put(
      "owner",
      "events",
      event("evening", "2026-10-09T18:00:00-07:00", "2026-10-09T19:00:00-07:00"),
    );
    await db.put("owner", "events", event("allday", "2026-10-10", "2026-10-11", true));
    const ids = (events: CalendarEvent[]) => events.map(({ id }) => id);
    // The all-day event belongs to the morning of the 10th in its own zone,
    // so the evening meeting of the 9th comes first.
    assert.deepEqual(ids(await workspace.events("owner")), ["evening", "allday"]);
  } finally {
    await db.close();
  }
});

test("calendar reads keep a stable text order when a start does not parse", async () => {
  const db = await createStore();
  try {
    const workspace = new WorkspaceService(
      db,
      { mode: "sample", agentBackend: "sample" } as Config,
      { list: async () => [] } as unknown as Files,
      {} as GoogleAuth,
    );
    const event = (id: string, start: string, end: string): CalendarEvent => ({
      id,
      calendarId: "primary",
      title: id,
      start,
      end,
      allDay: false,
      timeZone: "UTC",
      location: "",
      description: "",
      attendees: [],
    });
    await db.put(
      "owner",
      "events",
      event("zulu", "2026-10-10T14:00:00+00:00", "2026-10-10T15:00:00+00:00"),
    );
    await db.put("owner", "events", event("junk", "not a real start", "not a real end"));
    await db.put(
      "owner",
      "events",
      event("pacific", "2026-10-10T09:00:00-07:00", "2026-10-10T10:00:00-07:00"),
    );
    const ids = (events: CalendarEvent[]) => events.map(({ id }) => id);
    // Text fallback between an unparseable start and a parseable one keeps the
    // comparison total: digits sort before letters, so the junk entry lands last.
    assert.deepEqual(ids(await workspace.events("owner")), ["zulu", "pacific", "junk"]);
  } finally {
    await db.close();
  }
});

test("compareEventStart orders by instant across offsets and zones", async () => {
  const { compareEventStart } = await import("../packages/domain/src/date-time.ts");
  const timed = (start: string, timeZone = "UTC") => ({ start, allDay: false, timeZone });
  const allDay = (date: string, timeZone: string) => ({ start: date, allDay: true, timeZone });
  const sorted = <T extends { start: string }>(events: T[]) => [...events].sort(compareEventStart);

  // The event with the later-looking local clock starts first.
  assert.deepEqual(
    sorted([timed("2026-10-10T09:00:00-07:00"), timed("2026-10-10T14:00:00+00:00")]).map(
      (e) => e.start,
    ),
    ["2026-10-10T14:00:00+00:00", "2026-10-10T09:00:00-07:00"],
  );
  // Behind UTC: the all-day event starts the 10th in its zone, after the 9th's evening.
  assert.deepEqual(
    sorted([allDay("2026-10-10", "America/Los_Angeles"), timed("2026-10-09T18:00:00-07:00")]).map(
      (e) => e.start,
    ),
    ["2026-10-09T18:00:00-07:00", "2026-10-10"],
  );
  // Ahead of UTC: the all-day event starts the 10th in its zone, before that morning's meeting.
  assert.deepEqual(
    sorted([timed("2026-10-10T09:00:00+13:00"), allDay("2026-10-10", "Pacific/Auckland")]).map(
      (e) => e.start,
    ),
    ["2026-10-10", "2026-10-10T09:00:00+13:00"],
  );
  // A date-only start is treated as all-day even without the flag.
  assert.deepEqual(
    sorted([timed("2026-10-09T23:00:00+00:00"), { start: "2026-10-10", timeZone: "UTC" }]).map(
      (e) => e.start,
    ),
    ["2026-10-09T23:00:00+00:00", "2026-10-10"],
  );
  // An unparseable start falls back to text comparison instead of scrambling the list.
  assert.deepEqual(
    sorted([
      timed("2026-10-10T14:00:00+00:00"),
      { start: "garbage" },
      timed("2026-10-10T09:00:00-07:00"),
    ]).map((e) => e.start),
    ["2026-10-10T14:00:00+00:00", "2026-10-10T09:00:00-07:00", "garbage"],
  );
});
