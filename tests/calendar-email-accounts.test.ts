import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { Auth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { type EmailFactories, EmailService } from "../apps/server/src/connectors/email/service.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { buildAgentTools } from "../apps/server/src/engine/calendar-mail-tools.ts";
import { Files } from "../apps/server/src/files.ts";
import { GoogleAuth } from "../apps/server/src/google-auth.ts";
import { WorkspaceService } from "../apps/server/src/workspace.ts";
import type { CalendarEvent } from "../packages/domain/src/index.ts";
import { eventDraftSchema } from "../packages/domain/src/index.ts";

// Obviously fake credential for the fake account; never a real secret.
const FAKE_PASSWORD = "fake-test-password-not-a-secret";

const sent: { to: string[]; subject: string; text: string }[] = [];

const fakeFactories: EmailFactories = {
  imap: async () => ({
    listMailboxes: async () => ["INBOX"],
    pageMessages: async () => ({ total: 0, messages: [] }),
    message: async () => null,
    close: async () => {},
  }),
  smtp: () => ({
    verify: async () => {},
    send: async (options) => {
      sent.push({ to: options.to, subject: options.subject, text: options.text });
      return "<invite-1@example.com>";
    },
    close: async () => {},
  }),
};

let db: Store;
let directory: string;
let config: Config;

before(async () => {
  db = await createStore();
  directory = await mkdtemp(join(tmpdir(), "openmuse-calendar-email-test-"));
  config = {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    accessKey: "test-access-key",
    encryptionKey: randomBytes(32).toString("base64"),
  };
});

after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

const accountInput = {
  label: "Work",
  emailAddress: "you@example.com",
  username: "you@example.com",
  password: FAKE_PASSWORD,
  imapHost: "imap.example.com",
  smtpHost: "smtp.example.com",
};

function workspaceWithEmail(email?: EmailService) {
  const auth = new Auth(db, config, "test-signing-key");
  const files = new Files(db, config, auth);
  return new WorkspaceService(db, config, files, new GoogleAuth(db, config), email);
}

const baseDraft = {
  calendarId: "primary",
  title: "Planning session",
  start: "2026-09-24T10:00:00-05:00",
  end: "2026-09-24T11:00:00-05:00",
  allDay: false,
  timeZone: "America/Chicago",
  location: "Room 3",
  description: "Q4 planning",
  attendees: ["sam@example.com"],
};

test("eventDraftSchema accepts an email-account UUID or 'google', rejects junk", async () => {
  const uuid = randomUUID();
  const withUuid = eventDraftSchema.safeParse({ ...baseDraft, emailAccountId: uuid });
  assert.equal(withUuid.success, true);
  assert.equal(withUuid.success && withUuid.data.emailAccountId, uuid);

  const withGoogle = eventDraftSchema.safeParse({ ...baseDraft, emailAccountId: "google" });
  assert.equal(withGoogle.success, true);
  assert.equal(withGoogle.success && withGoogle.data.emailAccountId, "google");

  const omitted = eventDraftSchema.safeParse({ ...baseDraft });
  assert.equal(omitted.success, true);
  assert.equal(omitted.success && omitted.data.emailAccountId, undefined);

  const junk = eventDraftSchema.safeParse({ ...baseDraft, emailAccountId: "not-an-account" });
  assert.equal(junk.success, false);
});

test("live mode without Google falls back to a local calendar", async () => {
  const email = new EmailService(db, config, fakeFactories);
  const workspace = workspaceWithEmail(email);
  const calendars = await workspace.calendars("owner-local");
  assert.deepEqual(
    calendars.map((c) => ({ id: c.id, name: c.name })),
    [{ id: "primary", name: "Local" }],
  );
  assert.deepEqual(await workspace.events("owner-local"), []);

  // prepare() must not try to pin a Google target version.
  const prepared = await workspace.prepare("owner-local", {
    kind: "calendar.update",
    data: { ...baseDraft, eventId: "evt-1" },
  });
  assert.equal(prepared.input.kind, "calendar.update");

  // create → update → delete all work against the local store.
  const createResult = await workspace.execute("owner-local", {
    kind: "calendar.create",
    data: { ...baseDraft, attendees: [] },
  });
  const createdId = createResult.split("·")[1].trim();
  assert.ok(createResult.startsWith("Saved to local calendar"));

  const stored = await db.get<CalendarEvent>("owner-local", "events", createdId);
  assert.equal(stored?.title, "Planning session");

  const listed = await workspace.events("owner-local", { calendarId: "primary" });
  assert.equal(listed.length, 1);

  await workspace.execute("owner-local", {
    kind: "calendar.update",
    data: { ...baseDraft, eventId: createdId, title: "Renamed session", attendees: [] },
  });
  const renamed = await db.get<CalendarEvent>("owner-local", "events", createdId);
  assert.equal(renamed?.title, "Renamed session");

  const deleteResult = await workspace.execute("owner-local", {
    kind: "calendar.delete",
    data: { calendarId: "primary", eventId: createdId, title: "Renamed session" },
  });
  assert.equal(deleteResult, "Removed from local calendar");
  assert.deepEqual(await workspace.events("owner-local"), []);
});

test("emailAccountId round-trips through create/update proposals", async () => {
  const email = new EmailService(db, config, fakeFactories);
  const workspace = workspaceWithEmail(email);
  const account = await email.createAccount("owner-roundtrip", accountInput);

  const created = await workspace.execute("owner-roundtrip", {
    kind: "calendar.create",
    data: { ...baseDraft, attendees: [], emailAccountId: account.id },
  });
  const id = created.split("·")[1].trim();
  const first = await db.get<CalendarEvent>("owner-roundtrip", "events", id);
  assert.equal(first?.emailAccountId, account.id);

  const other = await email.createAccount("owner-roundtrip", {
    ...accountInput,
    label: "Personal",
    emailAddress: "me@example.com",
    username: "me@example.com",
  });
  await workspace.execute("owner-roundtrip", {
    kind: "calendar.update",
    data: { ...baseDraft, eventId: id, attendees: [], emailAccountId: other.id },
  });
  const updated = await db.get<CalendarEvent>("owner-roundtrip", "events", id);
  assert.equal(updated?.emailAccountId, other.id);
});

test("invite is sent from the selected account on create", async () => {
  const email = new EmailService(db, config, fakeFactories);
  const workspace = workspaceWithEmail(email);
  const account = await email.createAccount("owner-invite", accountInput);
  sent.length = 0;

  const result = await workspace.execute("owner-invite", {
    kind: "calendar.create",
    data: { ...baseDraft, emailAccountId: account.id },
  });
  assert.ok(result.includes("invite sent via Work"));

  assert.equal(sent.length, 1);
  const invite = sent[0];
  assert.deepEqual(invite.to, ["sam@example.com"]);
  assert.equal(invite.subject, "Invitation: Planning session");
  assert.ok(invite.text.includes("Planning session"));
  assert.ok(invite.text.includes("2026-09-24T10:00:00-05:00"));
  assert.ok(invite.text.includes("America/Chicago"));
  assert.ok(invite.text.includes("Room 3"));
  assert.ok(invite.text.includes("Q4 planning"));
  assert.ok(!invite.text.includes(FAKE_PASSWORD));
});

test("imap:-prefixed ids resolve to the same account", async () => {
  const email = new EmailService(db, config, fakeFactories);
  const workspace = workspaceWithEmail(email);
  const account = await email.createAccount("owner-imap", accountInput);
  sent.length = 0;

  const result = await workspace.execute("owner-imap", {
    kind: "calendar.create",
    data: { ...baseDraft, emailAccountId: `imap:${account.id}` },
  });
  assert.ok(result.includes("invite sent via Work"));
  assert.equal(sent.length, 1);
});

test("no invite is sent when there are no attendees", async () => {
  const email = new EmailService(db, config, fakeFactories);
  const workspace = workspaceWithEmail(email);
  const account = await email.createAccount("owner-noatt", accountInput);
  sent.length = 0;

  const result = await workspace.execute("owner-noatt", {
    kind: "calendar.create",
    data: { ...baseDraft, attendees: [], emailAccountId: account.id },
  });
  assert.ok(!result.includes("invite sent"));
  assert.equal(sent.length, 0);
});

test("no invite is sent when no account is chosen", async () => {
  const email = new EmailService(db, config, fakeFactories);
  const workspace = workspaceWithEmail(email);
  sent.length = 0;

  const result = await workspace.execute("owner-noacct", {
    kind: "calendar.create",
    data: { ...baseDraft },
  });
  assert.ok(!result.includes("invite sent"));
  assert.equal(sent.length, 0);
});

test("execution is refused when the chosen account was removed", async () => {
  const email = new EmailService(db, config, fakeFactories);
  const workspace = workspaceWithEmail(email);
  const account = await email.createAccount("owner-removed", accountInput);
  await email.deleteAccount("owner-removed", account.id);

  await assert.rejects(
    () =>
      workspace.execute("owner-removed", {
        kind: "calendar.create",
        data: { ...baseDraft, emailAccountId: account.id },
      }),
    /was removed/,
  );
});

test("'google' invites fail closed when Google is disconnected", async () => {
  const email = new EmailService(db, config, fakeFactories);
  const workspace = workspaceWithEmail(email);
  await assert.rejects(
    () =>
      workspace.execute("owner-gdis", {
        kind: "calendar.create",
        data: { ...baseDraft, emailAccountId: "google" },
      }),
    /Google is disconnected/,
  );
});

test("invite subjects are stripped of CR/LF (header-injection safe)", async () => {
  const email = new EmailService(db, config, fakeFactories);
  const workspace = workspaceWithEmail(email);
  const account = await email.createAccount("owner-crlf", accountInput);
  sent.length = 0;

  await workspace.execute("owner-crlf", {
    kind: "calendar.create",
    data: {
      ...baseDraft,
      title: "Party\r\nBcc: attacker@example.com",
      emailAccountId: account.id,
    },
  });
  assert.equal(sent.length, 1);
  assert.ok(!/[\r\n]/.test(sent[0].subject));
  assert.ok(sent[0].subject.startsWith("Invitation: Party"));
});

test("google path does not double-send invites (google notifies natively)", async () => {
  const email = new EmailService(db, config, fakeFactories);
  const workspace = workspaceWithEmail(email);
  const account = await email.createAccount("owner-googlepath", accountInput);
  sent.length = 0;

  // Fake a connected Google account: tokens resolve, GoogleClient is stubbed.
  (workspace as unknown as { googleAuth: { tokens: unknown } }).googleAuth.tokens = async () => ({
    connectionId: "conn-1",
    accessToken: "fake-access-token",
    expiresAt: Date.now() + 3600_000,
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    account: "you@gmail.com",
  });
  const googleCalls: unknown[] = [];
  (workspace as unknown as { google: unknown }).google = () => ({
    createEvent: async (data: Record<string, unknown>) => {
      googleCalls.push(data);
      return { ...data, id: "google-event-1" };
    },
  });

  const result = await workspace.execute(
    "owner-googlepath",
    { kind: "calendar.create", data: { ...baseDraft, emailAccountId: account.id } },
    "conn-1",
  );

  assert.equal(googleCalls.length, 1);
  assert.equal(sent.length, 0, "no extra email invite on the Google path");
  assert.ok(!result.includes("invite sent"));
  assert.ok(result.includes("Google Calendar event"));
  // The chosen account is still persisted on the local copy.
  const stored = await db.get<CalendarEvent>("owner-googlepath", "events", "google-event-1");
  assert.equal(stored?.emailAccountId, account.id);
});

test("emailAccounts lists IMAP accounts with kind and work/personal designation, no secrets", async () => {
  const email = new EmailService(db, config, fakeFactories);
  const workspace = workspaceWithEmail(email);
  const created = await email.createAccount("owner-accts", {
    ...accountInput,
    imapHost: "imap.titan.email",
    smtpHost: "smtp.titan.email",
  });
  const accounts = await workspace.emailAccounts("owner-accts");
  const titan = accounts.find((a) => a.id === created.id);
  assert.ok(titan, "Titan account is listed");
  assert.equal(titan.kind, "titan");
  assert.equal(titan.designation, "work");
  assert.equal(titan.address, "you@example.com");
  assert.ok(!("secret" in titan), "no encrypted secret in listing");
  assert.ok(!("password" in titan), "no password in listing");
});

test("email_accounts_list tool is registered; calendar descriptions explain the sending-account mapping", async () => {
  const workspace = workspaceWithEmail();
  const tools = buildAgentTools({
    owner: "owner-tools",
    workspace,
    throwIfAborted: () => {},
  });
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("email_accounts_list"), "email_accounts_list is registered");
  const create = tools.find((t) => t.name === "calendar_create");
  const update = tools.find((t) => t.name === "calendar_update");
  assert.ok(create && update, "calendar tools are registered");
  for (const tool of [create, update]) {
    assert.ok(
      tool.description.includes("email_accounts_list"),
      `${tool.name} points the agent at email_accounts_list`,
    );
  }
  assert.ok(
    create.description.includes("never a calendar choice"),
    "calendar_create says the email account is never a calendar choice",
  );
});
