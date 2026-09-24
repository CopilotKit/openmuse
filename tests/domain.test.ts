import assert from "node:assert/strict";
import test from "node:test";
import {
  emailDraftSchema,
  eventDraftSchema,
  proposalSchema,
} from "../packages/domain/src/index.ts";

const email = {
  to: ["reader@example.com"],
  subject: "Your visit",
  body: "See you soon.",
};
const event = {
  title: "Museum visit",
  start: "2026-10-10T10:00:00-07:00",
  end: "2026-10-10T14:00:00-07:00",
};

test("email drafts default cc, bcc, and attachmentIds to empty arrays", () => {
  const parsed = emailDraftSchema.parse(email);
  assert.deepEqual(parsed.cc, []);
  assert.deepEqual(parsed.bcc, []);
  assert.deepEqual(parsed.attachmentIds, []);
});

test("email drafts reject a subject containing a line break", () => {
  assert.equal(emailDraftSchema.safeParse({ ...email, subject: "Visit\nplan" }).success, false);
  assert.equal(emailDraftSchema.safeParse({ ...email, subject: "Visit\rplan" }).success, false);
});

test("email drafts enforce recipient, cc/bcc, and attachment limits", () => {
  assert.equal(emailDraftSchema.safeParse({ ...email, to: [] }).success, false);
  assert.equal(
    emailDraftSchema.safeParse({
      ...email,
      cc: Array.from({ length: 51 }, (_, i) => `person${i}@example.com`),
    }).success,
    false,
  );
  assert.equal(
    emailDraftSchema.safeParse({
      ...email,
      attachmentIds: Array.from({ length: 11 }, (_, i) => `file-${i}`),
    }).success,
    false,
  );
});

test("email drafts reject malformed addresses", () => {
  assert.equal(emailDraftSchema.safeParse({ ...email, to: ["not-an-email"] }).success, false);
});

test("timed events require an explicit UTC offset", () => {
  assert.equal(eventDraftSchema.parse(event).timeZone, "America/Los_Angeles");
  assert.equal(
    eventDraftSchema.safeParse({ ...event, start: "2026-10-10T10:00:00" }).success,
    false,
  );
  assert.equal(
    eventDraftSchema.safeParse({ ...event, start: "2026-10-10T10:00:00Z" }).success,
    true,
  );
});

test("all-day events reject a full timestamp in place of a date", () => {
  const allDay = { ...event, allDay: true, start: "2026-10-10", end: "2026-10-11" };
  assert.equal(eventDraftSchema.parse(allDay).allDay, true);
  assert.equal(
    eventDraftSchema.safeParse({ ...allDay, start: "2026-10-10T00:00:00Z" }).success,
    false,
  );
});

test("events reject an end at or before the start", () => {
  assert.equal(
    eventDraftSchema.safeParse({ ...event, end: "2026-10-09T10:00:00-07:00" }).success,
    false,
  );
  assert.equal(eventDraftSchema.safeParse({ ...event, end: event.start }).success, false);
});

test("events default calendarId, location, and description", () => {
  const parsed = eventDraftSchema.parse(event);
  assert.equal(parsed.calendarId, "primary");
  assert.equal(parsed.location, "");
  assert.equal(parsed.description, "");
});

test("proposal schema discriminates on kind and validates nested data", () => {
  assert.equal(proposalSchema.safeParse({ kind: "email.send", data: email }).success, true);
  assert.equal(
    proposalSchema.safeParse({ kind: "email.send", data: { ...email, subject: "" } }).success,
    false,
  );
  assert.equal(proposalSchema.safeParse({ kind: "unknown.kind", data: {} }).success, false);
});
