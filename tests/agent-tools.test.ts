/**
 * Track C — chat agent tools: calendar.create/update/delete,
 * mailbox.search/read, email.send.
 *
 * No real transports are touched: IMAP/SMTP go through fake factories and
 * Google is never connected (live mode without Google falls back to the
 * local store). The fake SMTP transport records every send so the tests can
 * assert both what was sent and what was never sent.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { Auth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import {
  type EmailFactories,
  EmailService,
  type FetchedMessage,
} from "../apps/server/src/connectors/email/service.ts";
import { applyWorkSignature } from "../apps/server/src/connectors/email/signature.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import {
  type AgentToolDeps,
  buildAgentTools,
  emailSendSchema,
  mailboxReadSchema,
  mailboxSearchSchema,
  resolveCalendarAttendees,
} from "../apps/server/src/engine/calendar-mail-tools.ts";
import {
  evaluateToolPolicy,
  type ToolCallContext,
  userSaidApprove,
} from "../apps/server/src/engine/tool-policy.ts";
import { Files } from "../apps/server/src/files.ts";
import { GoogleAuth } from "../apps/server/src/google-auth.ts";
import { WorkspaceService } from "../apps/server/src/workspace.ts";
import type { CalendarEvent } from "../packages/domain/src/index.ts";

const OWNER = "owner-agent-tools";

let db: Store;
let directory: string;
let config: Config;

const sent: { to: string[]; subject: string; text: string }[] = [];
const imapAccountsSeen: string[] = [];

function fakeMessage(uid: number, subject: string): FetchedMessage {
  return {
    uid,
    flags: [],
    subject,
    from: [{ name: "Sender", address: "sender@example.com" }],
    to: [{ address: "you@example.com" }],
    cc: [],
    text: `Body of message ${uid}`,
  };
}

let inboxMessages: FetchedMessage[] = [];

const fakeFactories: EmailFactories = {
  imap: async (account) => {
    imapAccountsSeen.push(account.id);
    return {
      listMailboxes: async () => ["INBOX"],
      recentMessages: async (_folder: string, count: number) =>
        [...inboxMessages].reverse().slice(0, count),
      pageMessages: async (_folder: string, _query: string, page: number, pageSize: number) => {
        const reversed = [...inboxMessages].reverse();
        const start = (page - 1) * pageSize;
        return { total: reversed.length, messages: reversed.slice(start, start + pageSize) };
      },
      message: async (_folder: string, uid: number) =>
        inboxMessages.find((m) => m.uid === uid) ?? null,
      close: async () => {},
    };
  },
  smtp: () => ({
    verify: async () => {},
    send: async (options) => {
      sent.push({ to: options.to, subject: options.subject, text: options.text });
      return "<test-message-id@example.com>";
    },
    close: async () => {},
  }),
};

before(async () => {
  db = await createStore();
  directory = await mkdtemp(join(tmpdir(), "openmuse-agent-tools-test-"));
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
  inboxMessages = [1, 2, 3, 4, 5].map((uid) => fakeMessage(uid, `Subject ${uid}`));
});

after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

function workspaceWithEmail(email?: EmailService): WorkspaceService {
  const auth = new Auth(db, config, "test-signing-key");
  const files = new Files(db, config, auth);
  return new WorkspaceService(db, config, files, new GoogleAuth(db, config), email);
}

async function createImapAccount(
  email: EmailService,
  emailAddress: string,
): Promise<{ id: string }> {
  return email.createAccount(OWNER, {
    label: "Test",
    emailAddress,
    username: emailAddress,
    // Obviously fake credential for the fake account; never a real secret.
    password: "fake-password-for-tests-only",
    imapHost: "imap.example.com",
    smtpHost: "smtp.example.com",
  });
}

function depsFor(workspace: WorkspaceService): AgentToolDeps {
  return {
    owner: OWNER,
    workspace,
    throwIfAborted: () => {},
  };
}

function policyCtx(
  toolName: string,
  args: unknown,
  extra: Partial<ToolCallContext> = {},
): ToolCallContext {
  return {
    owner: OWNER,
    scope: "chat:req-1",
    threadId: "thread-1",
    binding: "chat:req-1:thread-1",
    toolName,
    args,
    ...extra,
  };
}

const makeSendArgs = () => ({
  emailAccountId: randomUUID(),
  to: ["friend@example.com"],
  subject: "Hello",
  body: "Hi there",
});

// ---------------------------------------------------------------------------
// Approval-word detection
// ---------------------------------------------------------------------------

test("userSaidApprove matches the owner's own approval words", () => {
  for (const text of ["yes", "Yes, send it", "approved", "go ahead", "do it", "looks good"]) {
    assert.equal(userSaidApprove(text), true, text);
  }
  assert.equal(userSaidApprove("yesterday I sent it"), false);
  assert.equal(userSaidApprove("let me think about it"), false);
  assert.equal(userSaidApprove("not yet"), false);
  assert.equal(userSaidApprove(undefined), false);
  assert.equal(userSaidApprove(42), false);
});

// ---------------------------------------------------------------------------
// Policy: email.send is always gated, approval binds the exact call
// ---------------------------------------------------------------------------

test("email.send without approval requires approval and never sends", async () => {
  const verdict = await evaluateToolPolicy(policyCtx("email_send", makeSendArgs()));
  assert.equal(verdict.kind, "requireApproval");
});

test("approval words alone do not authorize a send", async () => {
  const verdict = await evaluateToolPolicy(
    policyCtx("email_send", makeSendArgs(), { ownerApprovalWords: true }),
  );
  assert.equal(verdict.kind, "requireApproval");
});

test("approval words after a presented call authorize exactly that call, once", async () => {
  const args = makeSendArgs();
  // Turn 1: the agent presents the call; policy gates it and records it.
  const gated = await evaluateToolPolicy(policyCtx("email_send", args));
  assert.equal(gated.kind, "requireApproval");
  // Turn 2: the owner's own "yes" authorizes the exact presented call.
  const allowed = await evaluateToolPolicy(
    policyCtx("email_send", args, { ownerApprovalWords: true }),
  );
  assert.equal(allowed.kind, "allow");
  // One-time use: a second "yes" authorizes nothing.
  const again = await evaluateToolPolicy(
    policyCtx("email_send", args, { ownerApprovalWords: true }),
  );
  assert.equal(again.kind, "requireApproval");
});

test("approval words do not authorize a changed call", async () => {
  const args = makeSendArgs();
  const gated = await evaluateToolPolicy(policyCtx("email_send", args));
  assert.equal(gated.kind, "requireApproval");
  // Same thread, same approval words, but the subject changed after approval.
  const changed = await evaluateToolPolicy(
    policyCtx(
      "email_send",
      { ...args, subject: "Different subject" },
      { ownerApprovalWords: true },
    ),
  );
  assert.equal(changed.kind, "requireApproval");
});

test("approval words do not authorize a different recipient account", async () => {
  const args = makeSendArgs();
  const gated = await evaluateToolPolicy(policyCtx("email_send", args));
  assert.equal(gated.kind, "requireApproval");
  const swapped = await evaluateToolPolicy(
    policyCtx(
      "email_send",
      { ...args, emailAccountId: randomUUID() },
      { ownerApprovalWords: true },
    ),
  );
  assert.equal(swapped.kind, "requireApproval");
});

// ---------------------------------------------------------------------------
// Policy: calendar gating follows attendee notification
// ---------------------------------------------------------------------------

const createArgs = {
  title: "Lunch",
  start: "2026-09-24T12:00:00-05:00",
  end: "2026-09-24T13:00:00-05:00",
};

test("calendar.create without attendees is allowed; with attendees is gated", async () => {
  const plain = await evaluateToolPolicy(policyCtx("calendar_create", createArgs));
  assert.equal(plain.kind, "allow");
  const withAttendees = await evaluateToolPolicy(
    policyCtx("calendar_create", { ...createArgs, attendees: ["sam@example.com"] }),
  );
  assert.equal(withAttendees.kind, "requireApproval");
});

test("calendar.update/delete gate on the stored event's attendees", async () => {
  const withAttendees = { resolveEventAttendees: async () => ["sam@example.com"] };
  const updateGated = await evaluateToolPolicy(
    policyCtx("calendar_update", { eventId: "evt-1", title: "New" }, withAttendees),
  );
  assert.equal(updateGated.kind, "requireApproval");
  const deleteGated = await evaluateToolPolicy(
    policyCtx("calendar_delete", { eventId: "evt-1" }, withAttendees),
  );
  assert.equal(deleteGated.kind, "requireApproval");

  const none = { resolveEventAttendees: async () => [] as readonly string[] };
  const updateAllowed = await evaluateToolPolicy(
    policyCtx("calendar_update", { eventId: "evt-2", title: "New" }, none),
  );
  assert.equal(updateAllowed.kind, "allow");
  const deleteAllowed = await evaluateToolPolicy(
    policyCtx("calendar_delete", { eventId: "evt-2" }, none),
  );
  assert.equal(deleteAllowed.kind, "allow");
});

test("calendar gate fails closed when attendees cannot be determined", async () => {
  const unknown = { resolveEventAttendees: async () => undefined };
  const verdict = await evaluateToolPolicy(
    policyCtx("calendar_update", { eventId: "evt-9", title: "New" }, unknown),
  );
  assert.equal(verdict.kind, "requireApproval");
});

test("mailbox.search and mailbox.read are allowed; unknown tools are denied", async () => {
  assert.equal(
    (
      await evaluateToolPolicy(
        policyCtx("mailbox_search", { emailAccountId: "google", query: "x" }),
      )
    ).kind,
    "allow",
  );
  assert.equal(
    (
      await evaluateToolPolicy(
        policyCtx("mailbox_read", { emailAccountId: "google", messageId: "abc" }),
      )
    ).kind,
    "allow",
  );
  const denied = await evaluateToolPolicy(policyCtx("email.nuke", {}));
  assert.equal(denied.kind, "deny");
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

test("emailSendSchema rejects CR/LF subjects and reply ids", () => {
  assert.equal(
    emailSendSchema.safeParse({ ...makeSendArgs(), subject: "Hi\r\nBcc: evil@x.com" }).success,
    false,
  );
  assert.equal(
    emailSendSchema.safeParse({ ...makeSendArgs(), inReplyTo: "<a@b>\r\nX: y" }).success,
    false,
  );
  assert.equal(emailSendSchema.safeParse(makeSendArgs()).success, true);
});

test("mailbox schemas require the right identifier per backend", () => {
  const uuid = randomUUID();
  assert.equal(
    mailboxReadSchema.safeParse({ emailAccountId: "google", messageId: "abc123" }).success,
    true,
  );
  assert.equal(mailboxReadSchema.safeParse({ emailAccountId: "google" }).success, false);
  assert.equal(
    mailboxReadSchema.safeParse({ emailAccountId: uuid, folder: "INBOX", uid: 12 }).success,
    true,
  );
  assert.equal(mailboxReadSchema.safeParse({ emailAccountId: uuid }).success, false);
  assert.equal(mailboxReadSchema.safeParse({ emailAccountId: "nope", uid: 1 }).success, false);

  assert.equal(
    mailboxSearchSchema.safeParse({ emailAccountId: uuid, query: "x", limit: 0 }).success,
    false,
  );
  assert.equal(
    mailboxSearchSchema.safeParse({ emailAccountId: uuid, query: "x", limit: 51 }).success,
    false,
  );
  const parsed = mailboxSearchSchema.safeParse({ emailAccountId: uuid, query: "x" });
  assert.equal(parsed.success && parsed.data.limit, 20);
});

// ---------------------------------------------------------------------------
// Work signature
// ---------------------------------------------------------------------------

test("work email is signed Work User, never Owner", () => {
  assert.equal(applyWorkSignature("Hello", "work@example.com"), "Hello\n\nWork User");
  // An existing Work User sign-off is kept as-is.
  assert.equal(applyWorkSignature("Hello\n\nWork User", "work@example.com"), "Hello\n\nWork User");
  // A trailing Owner sign-off is corrected, not duplicated.
  assert.equal(applyWorkSignature("Hello\n\nOwner", "work@example.com"), "Hello\n\nWork User");
  assert.equal(applyWorkSignature("Hello\n\nOwner User", "work@example.com"), "Hello\n\nWork User");
  // Mentions elsewhere in the body are untouched.
  assert.equal(
    applyWorkSignature("Owner will join us\n\nRegards", "work@example.com"),
    "Owner will join us\n\nRegards\n\nWork User",
  );
  // Non-work accounts are untouched.
  assert.equal(applyWorkSignature("Hello", "personal@example.com"), "Hello");
  assert.equal(applyWorkSignature("Hello\n\nOwner", "personal@example.com"), "Hello\n\nOwner");
});

// ---------------------------------------------------------------------------
// Account isolation: explicit accounts, never silent fallback
// ---------------------------------------------------------------------------

test("mailbox.search on an unknown account fails instead of falling back", async () => {
  const email = new EmailService(db, config, fakeFactories);
  const workspace = workspaceWithEmail(email);
  await assert.rejects(
    () =>
      workspace.searchMailbox(OWNER, randomUUID(), {
        query: "hello",
        limit: 10,
      }),
    /not found/,
  );
});

test("mailbox.search pages one explicit IMAP account with a cursor", async () => {
  imapAccountsSeen.length = 0;
  const email = new EmailService(db, config, fakeFactories);
  const workspace = workspaceWithEmail(email);
  const account = await createImapAccount(email, "you@example.com");

  const page1 = await workspace.searchMailbox(OWNER, account.id, { query: "Subject", limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.ok(page1.nextCursor, "first page has a cursor");
  // The exact account was used — no fallback.
  assert.deepEqual(imapAccountsSeen, [account.id]);

  const page2 = await workspace.searchMailbox(OWNER, account.id, {
    query: "Subject",
    limit: 2,
    cursor: page1.nextCursor,
  });
  assert.equal(page2.items.length, 2);
  assert.notDeepEqual(
    page2.items.map((i) => i.uid),
    page1.items.map((i) => i.uid),
  );

  const page3 = await workspace.searchMailbox(OWNER, account.id, {
    query: "Subject",
    limit: 2,
    cursor: page2.nextCursor,
  });
  assert.equal(page3.items.length, 1);
  assert.equal(page3.nextCursor, undefined);

  await assert.rejects(
    () => workspace.searchMailbox(OWNER, account.id, { query: "x", limit: 2, cursor: "junk" }),
    /cursor/i,
  );
});

test("mailbox.read returns one explicit message", async () => {
  const email = new EmailService(db, config, fakeFactories);
  const workspace = workspaceWithEmail(email);
  const account = await createImapAccount(email, "you@example.com");

  const message = await workspace.readMailboxMessage(OWNER, account.id, {
    folder: "INBOX",
    uid: 3,
  });
  assert.equal(message.uid, 3);
  assert.equal(message.subject, "Subject 3");
  assert.ok(message.body.includes("Body of message 3"));

  await assert.rejects(
    () => workspace.readMailboxMessage(OWNER, account.id, { folder: "INBOX", uid: 999 }),
    /not found/i,
  );
});

test("mailbox.search on google without a connection fails closed", async () => {
  const email = new EmailService(db, config, fakeFactories);
  const workspace = workspaceWithEmail(email);
  await assert.rejects(
    () => workspace.searchMailbox(OWNER, "google", { query: "hello", limit: 10 }),
    /not connected/i,
  );
});

// ---------------------------------------------------------------------------
// Send hardening: CR/LF rejected before transport, signature applied
// ---------------------------------------------------------------------------

test("EmailService.send rejects a CR/LF subject before touching the transport", async () => {
  sent.length = 0;
  const email = new EmailService(db, config, fakeFactories);
  const account = await createImapAccount(email, "you@example.com");
  await assert.rejects(
    () =>
      email.send(OWNER, account.id, {
        to: ["a@example.com"],
        cc: [],
        bcc: [],
        subject: "Hi\r\nBcc: evil@example.com",
        body: "x",
      }),
    /single line/,
  );
  assert.equal(sent.length, 0);
});

test("EmailService.send signs the work account Work User", async () => {
  sent.length = 0;
  const email = new EmailService(db, config, fakeFactories);
  const account = await createImapAccount(email, "work@example.com");
  await email.send(OWNER, account.id, {
    to: ["a@example.com"],
    cc: [],
    bcc: [],
    subject: "Hello",
    body: "Just checking in",
  });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.endsWith("\n\nWork User"));
});

// ---------------------------------------------------------------------------
// Tool handlers (sample-mode execution: no Google, no real sends)
// ---------------------------------------------------------------------------

function sampleWorkspace(): WorkspaceService {
  return workspaceWithEmail(new EmailService(db, config, fakeFactories));
}

function findTool(deps: AgentToolDeps, name: string): (args: unknown) => Promise<unknown> {
  const tool = buildAgentTools(deps).find((t) => t.name === name);
  assert.ok(tool?.execute, `tool ${name} exists`);
  return tool.execute as (args: unknown) => Promise<unknown>;
}

test("calendar.create/update/delete handlers round-trip the local store", async () => {
  const deps = depsFor(sampleWorkspace());
  const create = findTool(deps, "calendar_create");
  const created = (await create({
    title: "Dentist",
    start: "2026-09-24T10:00:00-05:00",
    end: "2026-09-24T11:00:00-05:00",
    timeZone: "America/Chicago",
  })) as { created: boolean; result: string };
  assert.equal(created.created, true);
  const id = created.result.split("·")[1].trim();

  // The confirmation gate sees the stored attendees.
  const attendees = await resolveCalendarAttendees(deps, { eventId: id });
  assert.deepEqual(attendees, []);

  const update = findTool(deps, "calendar_update");
  const updated = (await update({ eventId: id, title: "Dentist (moved)" })) as {
    updated: boolean;
  };
  assert.equal(updated.updated, true);
  const stored = await db.get<CalendarEvent>(OWNER, "events", id);
  assert.equal(stored?.title, "Dentist (moved)");
  // Untouched fields survive the partial update.
  assert.equal(stored?.start, "2026-09-24T10:00:00-05:00");

  const del = findTool(deps, "calendar_delete");
  const deleted = (await del({ eventId: id })) as { deleted: boolean };
  assert.equal(deleted.deleted, true);
  assert.equal(await db.get<CalendarEvent>(OWNER, "events", id), null);
});

test("calendar handlers report their own errors in the { error } shape", async () => {
  const deps = depsFor(sampleWorkspace());
  const update = findTool(deps, "calendar_update");
  const missing = (await update({ eventId: "nope", title: "x" })) as { error: string };
  assert.match(missing.error, /not found/i);

  const create = findTool(deps, "calendar_create");
  const invalid = (await create({ title: "", start: "x", end: "y" })) as {
    error: string;
  };
  assert.ok(invalid.error);
});

test("email.send handler sends through the exact IMAP account with the work signature", async () => {
  sent.length = 0;
  const email = new EmailService(db, config, fakeFactories);
  const workspace = workspaceWithEmail(email);
  const account = await createImapAccount(email, "work@example.com");
  const deps = depsFor(workspace);
  const send = findTool(deps, "email_send");
  const result = (await send({
    emailAccountId: account.id,
    to: ["friend@example.com"],
    subject: "Hi",
    body: "Hello",
  })) as { sent: boolean; account: string };
  assert.equal(result.sent, true);
  assert.equal(result.account, account.id);
  // The fake transport recorded exactly one send, signed Work User.
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, "Hi");
  assert.ok(sent[0].text.endsWith("\n\nWork User"));
});

test("resolveCalendarAttendees fails closed on unreadable events", async () => {
  const deps = depsFor(sampleWorkspace());
  assert.equal(await resolveCalendarAttendees(deps, { eventId: "missing" }), undefined);
  assert.equal(await resolveCalendarAttendees(deps, { nope: 1 }), undefined);
});

test("every registered tool name matches the provider-safe pattern", async () => {
  // DeepSeek (and other providers) reject tool names that do not match
  // ^[a-zA-Z0-9_-]+$ — dots caused a live `Invalid 'tools[26].name'` 400.
  const deps = depsFor(sampleWorkspace());
  const tools = buildAgentTools(deps);
  assert.ok(tools.length > 0, "expected at least one tool");
  const pattern = /^[a-zA-Z0-9_-]+$/;
  for (const tool of tools) {
    assert.ok(
      pattern.test(tool.name),
      `tool name ${JSON.stringify(tool.name)} does not match ^[a-zA-Z0-9_-]+$`,
    );
  }
});
