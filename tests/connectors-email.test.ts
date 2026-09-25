import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { Hono } from "hono";
import { z } from "zod";
import { ActionService } from "../apps/server/src/actions.ts";
import { createApp } from "../apps/server/src/app.ts";
import { Auth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { emailRoutes } from "../apps/server/src/connectors/email/routes.ts";
import {
  emailAccountCreateSchema,
  emailMessageQuerySchema,
} from "../apps/server/src/connectors/email/schemas.ts";
import {
  type EmailFactories,
  EmailService,
  type FetchedMessage,
  MAX_MESSAGE_BYTES,
  smtpOptions,
  toFetched,
} from "../apps/server/src/connectors/email/service.ts";
import { applyWorkSignature } from "../apps/server/src/connectors/email/signature.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { Files } from "../apps/server/src/files.ts";
import { GoogleAuth } from "../apps/server/src/google-auth.ts";
import { createUser } from "../apps/server/src/users.ts";
import { WorkspaceService } from "../apps/server/src/workspace.ts";

const PASSWORD = "s3cret-imap-password";

const messages: FetchedMessage[] = [
  {
    uid: 1,
    flags: [],
    subject: "Quarterly report",
    from: [{ name: "Boss", address: "boss@example.com" }],
    to: [{ address: "you@example.com" }],
    cc: [],
    date: "2026-09-20T10:00:00.000Z",
    messageId: "<q1@example.com>",
    text: "Here is the quarterly report you asked for.",
  },
  {
    uid: 2,
    flags: ["\\Seen"],
    subject: "Lunch tomorrow?",
    from: [{ address: "sam@example.com" }],
    to: [{ address: "you@example.com" }],
    cc: [],
    date: "2026-09-21T12:00:00.000Z",
    text: "Want to grab lunch tomorrow at noon?",
  },
];

const sent: { to: string[]; subject: string; text: string }[] = [];
const seenPasswords: string[] = [];

const fakeFactories: EmailFactories = {
  imap: async (account) => {
    // The password is available in memory for the operation only.
    seenPasswords.push(account.password);
    return {
      listMailboxes: async () => ["INBOX", "Sent"],
      // Mirrors the real imapflow implementation: the query runs server-side
      // over the whole folder and pages are newest-first.
      pageMessages: async (_folder, query, page, pageSize) => {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const matched = messages.filter((item) => {
          if (!words.length) return true;
          const haystack =
            `${item.subject} ${item.from.map((entry) => `${entry.name ?? ""} ${entry.address ?? ""}`).join(" ")} ${item.text}`.toLowerCase();
          return words.every((word) => haystack.includes(word));
        });
        const sorted = [...matched].sort((a, b) => b.uid - a.uid);
        const start = (page - 1) * pageSize;
        return { total: matched.length, messages: sorted.slice(start, start + pageSize) };
      },
      message: async (_folder, uid) => messages.find((item) => item.uid === uid) ?? null,
      close: async () => {},
    };
  },
  smtp: (account) => {
    seenPasswords.push(account.password);
    return {
      verify: async () => {},
      send: async (options) => {
        sent.push({ to: options.to, subject: options.subject, text: options.text });
        return "<sent-1@example.com>";
      },
      close: async () => {},
    };
  },
};

let db: Store, directory: string, config: Config;
before(async () => {
  db = await createStore();
  directory = await mkdtemp(join(tmpdir(), "openmuse-email-test-"));
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
  password: PASSWORD,
  imapHost: "imap.example.com",
  smtpHost: "smtp.example.com",
};

test("email accounts store encrypted passwords and serve metadata only", async () => {
  const email = new EmailService(db, config, fakeFactories);
  const created = await email.createAccount("owner-1", accountInput);
  assert.equal(created.emailAddress, "you@example.com");
  assert.equal(created.imap.port, 993);
  assert.equal(created.smtp.port, 465);
  assert.ok(!("secret" in created));
  const stored = await db.get<{ secret: string }>("owner-1", "email-accounts", created.id);
  assert.ok(stored?.secret && !stored.secret.includes(PASSWORD));

  const listed = await email.listAccounts("owner-1");
  assert.equal(listed.length, 1);
  assert.ok(!JSON.stringify(listed).includes(PASSWORD));

  const updated = await email.updateAccount("owner-1", created.id, { label: "Work 2" });
  assert.equal(updated.label, "Work 2");

  const result = await email.testConnection("owner-1", created.id);
  assert.deepEqual({ imap: result.imap, smtp: result.smtp }, { imap: true, smtp: true });
  assert.deepEqual(await email.folders("owner-1", created.id), ["INBOX", "Sent"]);

  await email.deleteAccount("owner-1", created.id);
  assert.deepEqual(await email.listAccounts("owner-1"), []);
});

test("page lists newest-first with server-side search and bounded bodies", async () => {
  const email = new EmailService(db, config, fakeFactories);
  const created = await email.createAccount("owner-2", accountInput);

  const all = await email.page("owner-2", created.id, {
    folder: "INBOX",
    query: "",
    page: 1,
    pageSize: 20,
  });
  assert.equal(all.total, 2);
  assert.equal(all.page, 1);
  assert.equal(all.pageSize, 20);
  assert.equal(all.items.length, 2);
  assert.equal(all.items[0].uid, 2); // newest first
  assert.equal(all.items[0].unread, false);
  assert.equal(all.items[1].uid, 1);
  assert.equal(all.items[1].unread, true);
  assert.ok(all.items[0].snippet.length <= 240);
  assert.ok(!JSON.stringify(all).includes(PASSWORD));

  const filtered = await email.page("owner-2", created.id, {
    folder: "INBOX",
    query: "lunch",
    page: 1,
    pageSize: 20,
  });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].subject, "Lunch tomorrow?");

  const limited = await email.page("owner-2", created.id, {
    folder: "INBOX",
    query: "",
    page: 1,
    pageSize: 1,
  });
  assert.equal(limited.total, 2);
  assert.equal(limited.items.length, 1);

  const message = await email.read("owner-2", created.id, "INBOX", 1);
  assert.equal(message.subject, "Quarterly report");
  assert.ok(message.body.length <= 12000);
  assert.ok(!JSON.stringify(message).includes(PASSWORD));
});

test("pagination walks the whole mailbox and fails closed past the end", async () => {
  // 60-message mailbox: uid 1 is the oldest, uid 60 the newest.
  const many: FetchedMessage[] = Array.from({ length: 60 }, (_, i) => ({
    uid: i + 1,
    flags: [],
    subject: `Note ${i + 1}`,
    from: [{ address: "news@example.com" }],
    to: [{ address: "you@example.com" }],
    cc: [],
    text: `Body ${i + 1}`,
  }));
  const bigFactories: EmailFactories = {
    imap: async () => ({
      listMailboxes: async () => ["INBOX"],
      pageMessages: async (_folder, _query, page, pageSize) => {
        const sorted = [...many].sort((a, b) => b.uid - a.uid);
        const start = (page - 1) * pageSize;
        return { total: many.length, messages: sorted.slice(start, start + pageSize) };
      },
      message: async () => null,
      close: async () => {},
    }),
    smtp: fakeFactories.smtp,
  };
  const email = new EmailService(db, config, bigFactories);
  const created = await email.createAccount("owner-8", accountInput);

  const first = await email.page("owner-8", created.id, {
    folder: "INBOX",
    query: "",
    page: 1,
    pageSize: 25,
  });
  assert.equal(first.total, 60);
  assert.equal(first.items.length, 25);
  assert.equal(first.items[0].uid, 60);
  assert.equal(first.items[24].uid, 36);

  const last = await email.page("owner-8", created.id, {
    folder: "INBOX",
    query: "",
    page: 3,
    pageSize: 25,
  });
  assert.equal(last.total, 60);
  assert.equal(last.items.length, 10);
  assert.equal(last.items[0].uid, 10);
  assert.equal(last.items[9].uid, 1);

  // Past the end: empty page, full total, no error.
  const beyond = await email.page("owner-8", created.id, {
    folder: "INBOX",
    query: "",
    page: 4,
    pageSize: 25,
  });
  assert.equal(beyond.total, 60);
  assert.deepEqual(beyond.items, []);

  // pageSize is clamped to the service maximum.
  const clamped = await email.page("owner-8", created.id, {
    folder: "INBOX",
    query: "",
    page: 1,
    pageSize: 500,
  });
  assert.equal(clamped.pageSize, 50);
  assert.equal(clamped.items.length, 50);

  // Degenerate input fails closed instead of crashing.
  const zero = await email.page("owner-8", created.id, {
    folder: "INBOX",
    query: "",
    page: 0,
    pageSize: 0,
  });
  assert.equal(zero.page, 1);
  assert.equal(zero.pageSize, 20);
});

test("search matches messages beyond the most recent 50", async () => {
  // Regression test for "I only see a few emails": the old implementation
  // scanned the newest 50 messages client-side, so an older match was
  // invisible. The query must run server-side over the whole folder.
  const many: FetchedMessage[] = Array.from({ length: 60 }, (_, i) => ({
    uid: i + 1,
    flags: [],
    subject: i === 2 ? "Ancient quarterly report" : `Note ${i + 1}`,
    from: [{ address: "news@example.com" }],
    to: [{ address: "you@example.com" }],
    cc: [],
    text: `Body ${i + 1}`,
  }));
  const bigFactories: EmailFactories = {
    imap: async () => ({
      listMailboxes: async () => ["INBOX"],
      pageMessages: async (_folder, query, page, pageSize) => {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const matched = many.filter((item) =>
          words.every((word) => `${item.subject} ${item.text}`.toLowerCase().includes(word)),
        );
        const sorted = [...matched].sort((a, b) => b.uid - a.uid);
        const start = (page - 1) * pageSize;
        return { total: matched.length, messages: sorted.slice(start, start + pageSize) };
      },
      message: async () => null,
      close: async () => {},
    }),
    smtp: fakeFactories.smtp,
  };
  const email = new EmailService(db, config, bigFactories);
  const created = await email.createAccount("owner-8b", accountInput);
  const result = await email.page("owner-8b", created.id, {
    folder: "INBOX",
    query: "quarterly",
    page: 1,
    pageSize: 20,
  });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].uid, 3);
  assert.equal(result.items[0].subject, "Ancient quarterly report");
});

test("message query schema fails closed on bad pagination input", () => {
  assert.throws(() => emailMessageQuerySchema.parse({ page: 0 }), z.ZodError);
  assert.throws(() => emailMessageQuerySchema.parse({ page: -2 }), z.ZodError);
  assert.throws(() => emailMessageQuerySchema.parse({ pageSize: 0 }), z.ZodError);
  assert.throws(() => emailMessageQuerySchema.parse({ pageSize: 51 }), z.ZodError);
  assert.throws(() => emailMessageQuerySchema.parse({ page: "abc" }), z.ZodError);
  assert.throws(() => emailMessageQuerySchema.parse({ folder: "" }), z.ZodError);
  const defaults = emailMessageQuerySchema.parse({});
  assert.equal(defaults.page, 1);
  assert.equal(defaults.pageSize, 20);
  assert.equal(defaults.folder, "INBOX");
});

test("messages route returns a paginated page object and never the password", async () => {
  const many: FetchedMessage[] = Array.from({ length: 60 }, (_, i) => ({
    uid: i + 1,
    flags: [],
    subject: `Note ${i + 1}`,
    from: [{ address: "news@example.com" }],
    to: [{ address: "you@example.com" }],
    cc: [],
    text: `Body ${i + 1}`,
  }));
  const bigFactories: EmailFactories = {
    imap: async () => ({
      listMailboxes: async () => ["INBOX", "Sent"],
      pageMessages: async (_folder, _query, page, pageSize) => {
        const sorted = [...many].sort((a, b) => b.uid - a.uid);
        const start = (page - 1) * pageSize;
        return { total: many.length, messages: sorted.slice(start, start + pageSize) };
      },
      message: async () => null,
      close: async () => {},
    }),
    smtp: fakeFactories.smtp,
  };
  const email = new EmailService(db, config, bigFactories);
  const created = await email.createAccount("owner-9", accountInput);

  // Mount the real route tree with the same zod->422 mapping as the app.
  const app = new Hono<{ Variables: { owner: string } }>();
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: "bad request" }, 422);
    throw error;
  });
  app.use("*", async (c, next) => {
    c.set("owner", "owner-9");
    await next();
  });
  app.route("/", emailRoutes(email));

  const response = await app.request(`/${created.id}/messages?folder=INBOX&page=2&pageSize=25`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.total, 60);
  assert.equal(body.page, 2);
  assert.equal(body.pageSize, 25);
  assert.equal(body.items.length, 25);
  assert.equal(body.items[0].uid, 35);
  assert.ok(!("secret" in body));
  assert.ok(!JSON.stringify(body).includes(PASSWORD));

  const folders = await app.request(`/${created.id}/folders`);
  assert.equal(folders.status, 200);
  assert.deepEqual(await folders.json(), ["INBOX", "Sent"]);

  // Bad pagination input fails closed with 422, not a 500.
  const bad = await app.request(`/${created.id}/messages?page=0`);
  assert.equal(bad.status, 422);
});

test("send signs work-account mail as Work User and leaves other accounts alone", async () => {
  assert.equal(applyWorkSignature("Hello", "work@example.com"), "Hello\n\nWork User");
  assert.equal(applyWorkSignature("Hello", "Work@Example.com"), "Hello\n\nWork User");
  assert.equal(applyWorkSignature("Hello", "personal@example.com"), "Hello");
  assert.equal(applyWorkSignature("Hello\n\nWork User", "work@example.com"), "Hello\n\nWork User");

  const email = new EmailService(db, config, fakeFactories);
  const work = await email.createAccount("owner-10", {
    ...accountInput,
    label: "Work Titan",
    emailAddress: "work@example.com",
  });
  await email.send("owner-10", work.id, {
    to: ["sam@example.com"],
    cc: [],
    bcc: [],
    subject: "Hi",
    body: "Hello there",
  });
  assert.ok(sent.at(-1)?.text.endsWith("\n\nWork User"));

  const personal = await email.createAccount("owner-11", {
    ...accountInput,
    label: "Personal",
    emailAddress: "personal@example.com",
  });
  await email.send("owner-11", personal.id, {
    to: ["sam@example.com"],
    cc: [],
    bcc: [],
    subject: "Hi",
    body: "Hello there",
  });
  assert.equal(sent.at(-1)?.text, "Hello there");
});

test("protocol failures are safe and never leak the password", async () => {
  const failing: EmailFactories = {
    imap: async () => {
      throw new Error("Invalid credentials (Failure)");
    },
    smtp: (_account) => {
      const boom = async (): Promise<never> => {
        throw new Error("Connection refused");
      };
      return { verify: boom, send: boom, close: async () => {} };
    },
  };
  const email = new EmailService(db, config, failing);
  const created = await email.createAccount("owner-3", accountInput);
  const result = await email.testConnection("owner-3", created.id);
  assert.equal(result.imap, false);
  assert.equal(result.smtp, false);
  assert.ok(result.imapDetail?.startsWith("IMAP:"));
  assert.ok(!JSON.stringify(result).includes(PASSWORD));
  await assert.rejects(() => email.folders("owner-3", created.id), /IMAP:/);
});

test("workspace falls back to IMAP when Google is disconnected", async () => {
  const auth = new Auth(db, config, "test-signing-key");
  const files = new Files(db, config, auth);
  const email = new EmailService(db, config, fakeFactories);
  const workspace = new WorkspaceService(db, config, files, new GoogleAuth(db, config), email);
  const created = await email.createAccount("owner-4", accountInput);

  const connection = await workspace.emailConnection("owner-4");
  assert.deepEqual(connection, { id: `imap:${created.id}`, account: "you@example.com" });
  assert.equal(await workspace.emailConnected("owner-4"), true);

  const results = await workspace.searchMail("owner-4", "quarterly");
  assert.equal(results.length, 1);
  assert.equal(results[0].subject, "Quarterly report");
  assert.equal(results[0].label, "Work · INBOX");
  assert.ok(!JSON.stringify(results).includes(PASSWORD));

  const thread = await workspace.thread("owner-4", "INBOX:1");
  assert.equal(thread.length, 1);
  assert.equal(thread[0].id, "INBOX:1");

  // Approved sends route to SMTP through the pinned account.
  const receipt = await workspace.execute(
    "owner-4",
    {
      kind: "email.send",
      data: {
        to: ["sam@example.com"],
        cc: [],
        bcc: [],
        subject: "Hello",
        body: "Hi Sam",
        attachmentIds: [],
      },
    },
    `imap:${created.id}`,
  );
  assert.ok(receipt.startsWith("Sent via Work ·"));
  assert.deepEqual(sent.at(-1)?.to, ["sam@example.com"]);

  // A removed account can no longer execute.
  await email.deleteAccount("owner-4", created.id);
  await assert.rejects(
    () =>
      workspace.execute(
        "owner-4",
        {
          kind: "email.send",
          data: {
            to: ["sam@example.com"],
            cc: [],
            bcc: [],
            subject: "Hello",
            body: "Hi Sam",
            attachmentIds: [],
          },
        },
        `imap:${created.id}`,
      ),
    /removed/,
  );
});

test("action flow approves email.send for IMAP accounts without Google", async () => {
  const actions = new ActionService(db, {
    execute: async () => "sent",
    connected: async () => false,
    connection: async () => null,
    emailConnected: async () => true,
    emailConnection: async () => ({ id: "imap:account-1", account: "you@example.com" }),
  });
  const proposal = await actions.propose("owner-5", {
    kind: "email.send",
    data: {
      to: ["sam@example.com"],
      cc: [],
      bcc: [],
      subject: "Visit",
      body: "See attached.",
      attachmentIds: [],
    },
  });
  assert.equal(proposal.status, "awaiting_review");
  assert.equal(proposal.connectionId, "imap:account-1");
  assert.equal(proposal.account, "you@example.com");
  const decided = await actions.decide("owner-5", proposal.id, proposal.hash, "approve");
  assert.equal(decided.status, "succeeded");
});

test("email account routes serve metadata only", async (t) => {
  const { app, auth, agent } = await createApp(db, {
    ...config,
    workerUrl: undefined,
    workerToken: undefined,
  });
  t.after(() => agent.stop());
  const { token } = await auth.session({ accessKey: "test-access-key" });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const created = await app.request("/api/email-accounts", {
    method: "POST",
    headers,
    body: JSON.stringify(accountInput),
  });
  assert.equal(created.status, 201);
  const account = await created.json();
  assert.ok(!("secret" in account));
  assert.ok(!JSON.stringify(account).includes(PASSWORD));

  const listed = await app.request("/api/email-accounts", { headers });
  assert.equal((await listed.json()).length, 1);

  const removed = await app.request(`/api/email-accounts/${account.id}`, {
    method: "DELETE",
    headers,
  });
  assert.equal(removed.status, 200);
});

test("toFetched stubs oversized messages in list mode without parsing", async () => {
  // Garbage bytes: if simpleParser ever ran on this buffer the test would see
  // a parse result (or a throw) instead of the stub below.
  const oversized = Buffer.alloc(MAX_MESSAGE_BYTES + 1, 0x41);
  const result = await toFetched(7, new Set(["\\Seen"]), oversized);
  assert.equal(result.uid, 7);
  assert.deepEqual(result.flags, ["\\Seen"]);
  assert.equal(result.subject, "");
  assert.deepEqual(result.from, []);
  assert.deepEqual(result.to, []);
  assert.equal(result.messageId, undefined);
  assert.match(result.text, /exceeds the 5 ?MiB/i);
});

test("toFetched throws for oversized messages in single-message mode", async () => {
  const oversized = Buffer.alloc(MAX_MESSAGE_BYTES + 1);
  await assert.rejects(() => toFetched(7, [], oversized, "throw"), /exceeds the 5 ?MiB/i);
});

test("toFetched parses a normal small message", async () => {
  const raw = Buffer.from(
    "From: Boss <boss@example.com>\r\n" +
      "To: you@example.com\r\n" +
      "Subject: Tiny\r\n" +
      "Message-ID: <tiny-1@example.com>\r\n" +
      "Date: Mon, 22 Sep 2026 10:00:00 +0000\r\n" +
      "\r\n" +
      "Hello there",
  );
  const result = await toFetched(3, ["\\Seen"], raw);
  assert.equal(result.subject, "Tiny");
  assert.deepEqual(result.from, [{ name: "Boss", address: "boss@example.com" }]);
  assert.equal(result.messageId, "<tiny-1@example.com>");
  assert.match(result.text, /Hello there/);
  assert.deepEqual(result.flags, ["\\Seen"]);
});

test("toFetched parses a message exactly at the size cap", async () => {
  const head = Buffer.from("Subject: Padded\r\n\r\n");
  const raw = Buffer.concat([head, Buffer.alloc(MAX_MESSAGE_BYTES - head.length, 0x20)]);
  assert.equal(raw.byteLength, MAX_MESSAGE_BYTES);
  const result = await toFetched(9, [], raw);
  assert.equal(result.subject, "Padded");
});

test("service stubs oversized messages in lists and errors on single fetch", async () => {
  const oversized = Buffer.alloc(MAX_MESSAGE_BYTES + 1);
  const rawFactories: EmailFactories = {
    imap: async () => ({
      listMailboxes: async () => ["INBOX"],
      // Mirrors the real factory: list mode stubs, single-message mode throws.
      pageMessages: async () => ({ total: 1, messages: [await toFetched(11, [], oversized)] }),
      message: async () => await toFetched(11, [], oversized, "throw"),
      close: async () => {},
    }),
    smtp: (_account) => ({
      verify: async () => {},
      send: async () => "<x@y>",
      close: async () => {},
    }),
  };
  const email = new EmailService(db, config, rawFactories);
  const created = await email.createAccount("owner-6", accountInput);

  const list = await email.page("owner-6", created.id, {
    folder: "INBOX",
    query: "",
    page: 1,
    pageSize: 20,
  });
  assert.equal(list.total, 1);
  assert.equal(list.items.length, 1);
  assert.match(list.items[0].snippet, /exceeds the 5 ?MiB/i);

  // The 413 AppError passes through read() instead of being wrapped as "IMAP:".
  await assert.rejects(() => email.read("owner-6", created.id, "INBOX", 11), /exceeds the 5 ?MiB/i);
});

test("send rejects a malicious inReplyTo before touching the transport", async () => {
  const email = new EmailService(db, config, fakeFactories);
  const created = await email.createAccount("owner-7", accountInput);
  const sentBefore = sent.length;
  await assert.rejects(
    () =>
      email.send("owner-7", created.id, {
        to: ["sam@example.com"],
        cc: [],
        bcc: [],
        subject: "Hi",
        body: "Hello",
        inReplyTo: "<abc@def.com>\r\nBcc: intruder@evil.example",
      }),
    /Invalid Message-ID/,
  );
  assert.equal(sent.length, sentBefore);

  // A valid Message-ID still sends.
  const receipt = await email.send("owner-7", created.id, {
    to: ["sam@example.com"],
    cc: [],
    bcc: [],
    subject: "Hi",
    body: "Hello",
    inReplyTo: "<abc@def.com>",
  });
  assert.equal(receipt.messageId, "<sent-1@example.com>");
});

test("account host validation rejects SSRF and malformed targets", () => {
  // Valid public DNS hosts pass.
  assert.ok(
    emailAccountCreateSchema.safeParse({ ...accountInput }).success,
    "imap.example.com / smtp.example.com are valid",
  );
  assert.ok(
    emailAccountCreateSchema.safeParse({
      ...accountInput,
      imapHost: "imap.titan.email",
      smtpHost: "smtp.titan.email",
    }).success,
    "Titan hosts are valid",
  );

  // Loopback, private ranges, IP literals, and reserved suffixes must fail.
  const bad = [
    { imapHost: "localhost", smtpHost: "smtp.example.com" },
    { imapHost: "127.0.0.1", smtpHost: "smtp.example.com" },
    { imapHost: "10.0.0.5", smtpHost: "smtp.example.com" },
    { imapHost: "192.168.1.1", smtpHost: "smtp.example.com" },
    { imapHost: "169.254.169.254", smtpHost: "smtp.example.com" },
    { imapHost: "8.8.8.8", smtpHost: "smtp.example.com" },
    { imapHost: "smtp://imap.example.com", smtpHost: "smtp.example.com" },
    { imapHost: "imap.example.com:993", smtpHost: "smtp.example.com" },
    { imapHost: "mail.server.local", smtpHost: "smtp.example.com" },
    { imapHost: "imap.example.com", smtpHost: "[::1]" },
  ];
  for (const overrides of bad) {
    const parsed = emailAccountCreateSchema.safeParse({ ...accountInput, ...overrides });
    assert.ok(!parsed.success, `expected rejection for ${JSON.stringify(overrides)}`);
  }
});

test("SMTP transport requires STARTTLS whenever implicit TLS is off", () => {
  const implicit = smtpOptions({
    smtp: { host: "smtp.example.com", port: 465, secure: true },
    username: "u",
    password: "p",
  });
  assert.equal(implicit.secure, true);
  assert.equal(implicit.requireTLS, false, "465 keeps implicit TLS and no STARTTLS guard");

  const starttls = smtpOptions({
    smtp: { host: "smtp.example.com", port: 587, secure: false },
    username: "u",
    password: "p",
  });
  assert.equal(starttls.secure, false);
  assert.equal(starttls.requireTLS, true, "587/STARTTLS must be mandatory, never opportunistic");
});

// --- Compose-box AI helpers: AI reply drafts + grammar fixes ---

/** Replace the model endpoint with a stub; restores the original after the test. */
function stubModel(
  t: { after: (fn: () => void) => void },
  replyText: string,
  opts?: { ok?: boolean },
): { url: string; body: any }[] {
  const originalFetch = globalThis.fetch;
  const seen: { url: string; body: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    if (opts?.ok === false) return { ok: false, status: 500, json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: replyText } }] }),
    };
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return seen;
}

/** Set (or clear) the model API key; restores the previous value after the test. */
function useModelKey(t: { after: (fn: () => void) => void }, key: string | undefined) {
  const prev = process.env.OPENAI_API_KEY;
  t.after(() => {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  });
  if (key === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = key;
}

test("compose AI helpers draft replies and fix grammar via the model", async (t) => {
  const { app, auth, agent } = await createApp(db, {
    ...config,
    workerUrl: undefined,
    workerToken: undefined,
  });
  t.after(() => agent.stop());
  const { token } = await auth.session({ username: "admin", password: "test-access-key" });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const seen = stubModel(t, "Mocked model output");
  useModelKey(t, "test-key");

  const replyRes = await app.request("/api/email-accounts/ai-reply", {
    method: "POST",
    headers,
    body: JSON.stringify({
      from: "boss@example.com",
      sender: "Boss",
      subject: "Quarterly report",
      body: "Please send the numbers by Friday.",
    }),
  });
  assert.equal(replyRes.status, 200);
  assert.equal((await replyRes.json()).reply, "Mocked model output");
  assert.equal(seen.length, 1);
  assert.ok(seen[0].url.endsWith("/chat/completions"), "hits the chat completions endpoint");
  const userMsg = (seen[0].body.messages as { role: string; content: string }[]).find(
    (m) => m.role === "user",
  )?.content;
  assert.ok(userMsg, "the model receives a user message");
  assert.ok(userMsg.includes("Quarterly report"), "the original subject reaches the model");
  assert.ok(userMsg.includes("boss@example.com"), "the original sender reaches the model");

  const grammarRes = await app.request("/api/email-accounts/fix-grammar", {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "i has a issue with the sync" }),
  });
  assert.equal(grammarRes.status, 200);
  assert.equal((await grammarRes.json()).text, "Mocked model output");

  const badReply = await app.request("/api/email-accounts/ai-reply", {
    method: "POST",
    headers,
    body: JSON.stringify({ from: "", body: "" }),
  });
  assert.equal(badReply.status, 422);
  const badGrammar = await app.request("/api/email-accounts/fix-grammar", {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "   " }),
  });
  assert.equal(badGrammar.status, 422);
});

test("compose AI helpers return 502 with a readable error when the model fails", async (t) => {
  const { app, auth, agent } = await createApp(db, {
    ...config,
    workerUrl: undefined,
    workerToken: undefined,
  });
  t.after(() => agent.stop());
  const { token } = await auth.session({ username: "admin", password: "test-access-key" });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  stubModel(t, "", { ok: false });
  useModelKey(t, "test-key");

  const res = await app.request("/api/email-accounts/fix-grammar", {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "hello there" }),
  });
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error?: string };
  assert.ok(typeof body.error === "string" && body.error.length > 0);
});

test("compose AI helpers return 502 when no model key is configured", async (t) => {
  const { app, auth, agent } = await createApp(db, {
    ...config,
    workerUrl: undefined,
    workerToken: undefined,
  });
  t.after(() => agent.stop());
  const { token } = await auth.session({ username: "admin", password: "test-access-key" });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  stubModel(t, "unused");
  useModelKey(t, undefined);

  const res = await app.request("/api/email-accounts/ai-reply", {
    method: "POST",
    headers,
    body: JSON.stringify({ from: "a@b.c", body: "hi" }),
  });
  assert.equal(res.status, 502);
  assert.ok(((await res.json()) as { error?: string }).error);
});

test("regular users may use compose AI helpers but not manage accounts", async (t) => {
  // Isolated store so the extra user never leaks into the shared test db.
  const userDb = await createStore();
  const userDir = await mkdtemp(join(tmpdir(), "openmuse-email-ai-role-"));
  t.after(async () => {
    await userDb.close();
    await rm(userDir, { recursive: true, force: true });
  });
  const { app, auth, agent } = await createApp(userDb, {
    ...config,
    dataDir: userDir,
    workerUrl: undefined,
    workerToken: undefined,
  });
  t.after(() => agent.stop());
  await auth.session({ accessKey: "test-access-key" }); // bootstrap the admin
  await createUser(userDb, "compose-user", "user-pass", "user");
  const { token } = await auth.session({ username: "compose-user", password: "user-pass" });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  stubModel(t, "Mocked model output");
  useModelKey(t, "test-key");

  const allowed = await app.request("/api/email-accounts/ai-reply", {
    method: "POST",
    headers,
    body: JSON.stringify({ from: "a@b.c", body: "please advise" }),
  });
  assert.equal(allowed.status, 200);
  const allowedGrammar = await app.request("/api/email-accounts/fix-grammar", {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "fix this" }),
  });
  assert.equal(allowedGrammar.status, 200);

  const forbidden = await app.request("/api/email-accounts", {
    method: "POST",
    headers,
    body: JSON.stringify(accountInput),
  });
  assert.equal(forbidden.status, 403);
});
