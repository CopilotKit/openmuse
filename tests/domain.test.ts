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

test("events reject nonexistent dates instead of normalizing them into the next month", () => {
  for (const allDay of [true, false]) {
    const format = (date: string) => (allDay ? date : `${date}T10:00:00+08:00`);
    for (const date of ["2026-02-29", "2026-02-30", "2026-04-31", "2100-02-29"]) {
      for (const field of ["start", "end"] as const) {
        assert.equal(
          eventDraftSchema.safeParse({
            ...event,
            allDay,
            start: format("2000-01-01"),
            end: format("2200-01-01"),
            [field]: format(date),
          }).success,
          false,
          `${field} must reject ${format(date)}`,
        );
      }
    }
  }
});

test("events accept valid leap days, month ends, and explicit offsets", () => {
  for (const suffix of [
    "",
    "T10:00Z",
    "T10:00+05:30",
    "T10:00:00Z",
    "T10:00:00.123+08:00",
    "T10:00:00-07:00",
  ]) {
    for (const [start, end] of [
      ["2000-02-29", "2000-03-01"],
      ["2024-02-29", "2024-03-01"],
      ["2026-04-30", "2026-05-01"],
    ]) {
      assert.equal(
        eventDraftSchema.safeParse({
          ...event,
          allDay: suffix === "",
          start: start + suffix,
          end: end + suffix,
        }).success,
        true,
        `${start + suffix} to ${end + suffix} must remain valid`,
      );
    }
  }
});

test("timed events reject 24:00 instead of moving the appointment to the next day", () => {
  for (const time of ["24:00", "24:00:00", "24:00:00.000"]) {
    for (const offset of ["Z", "-07:00", "+05:30"]) {
      for (const field of ["start", "end"] as const) {
        assert.equal(
          eventDraftSchema.safeParse({
            ...event,
            start: "2000-01-01T10:00:00Z",
            end: "2200-01-01T10:00:00Z",
            [field]: `2026-10-10T${time}${offset}`,
          }).success,
          false,
          `${field} must reject ${time}${offset}`,
        );
      }
    }
  }
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

test("drafts drop invisible characters so the review card shows what is sent", () => {
  const hidden = "\u200B\u202E\u2066\u2069\u2060\uFEFF\u{E0041}";
  const draft = emailDraftSchema.parse({
    ...email,
    subject: `Your${hidden} visit`,
    body: `See you${hidden} soon.`,
  });
  assert.equal(draft.subject, "Your visit");
  assert.equal(draft.body, "See you soon.");
  const created = eventDraftSchema.parse({
    ...event,
    title: `Museum${hidden} visit`,
    location: `Hall${hidden} A`,
    description: `Bring${hidden} tickets`,
  });
  assert.deepEqual(
    [created.title, created.location, created.description],
    ["Museum visit", "Hall A", "Bring tickets"],
  );
  // A subject made only of invisible characters is empty once they are dropped.
  assert.equal(emailDraftSchema.safeParse({ ...email, subject: hidden }).success, false);
});

test("drafts keep joiners and directional marks that real text uses", () => {
  const body = "Family 👨\u200D👩\u200D👧, می\u200Cخواهم, \u200Fשלום\u200E";
  assert.equal(emailDraftSchema.parse({ ...email, body }).body, body);
});
