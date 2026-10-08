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
