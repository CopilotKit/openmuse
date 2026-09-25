import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";
import type { Config } from "../apps/server/src/config.ts";
import { MirrorStore } from "../apps/server/src/connectors/email/mirror.ts";
import {
  type EmailFactories,
  EmailService,
  type FetchedMessage,
  type ImapSyncConnection,
  type ResolvedEmailAccount,
} from "../apps/server/src/connectors/email/service.ts";
import { syncFolderMirror } from "../apps/server/src/connectors/email/sync.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

/** In-memory fake mailbox backing the fake sync IMAP factory. */
interface FakeStoredMessage {
  flags: string[];
  subject: string;
  from: { name?: string; address: string };
  to: { address: string }[];
  text: string;
  date: string;
  messageId: string;
}

class FakeMailbox {
  uidValidity = 7;
  uidNext = 1;
  readonly messages = new Map<number, FakeStoredMessage>();

  add(message: FakeStoredMessage): number {
    const uid = this.uidNext++;
    this.messages.set(uid, message);
    return uid;
  }

  reset(newValidity: number) {
    this.uidValidity = newValidity;
    this.uidNext = 1;
    this.messages.clear();
  }

  toFetched(uid: number, stored: FakeStoredMessage): FetchedMessage {
    return {
      uid,
      flags: [...stored.flags],
      subject: stored.subject,
      from: [{ name: stored.from.name, address: stored.from.address }],
      to: stored.to.map((entry) => ({ address: entry.address })),
      cc: [],
      date: stored.date,
      messageId: stored.messageId,
      text: stored.text,
    };
  }
}

const inbox = new FakeMailbox();
const sentBox = new FakeMailbox();
const mailboxes: Record<string, FakeMailbox> = { INBOX: inbox, Sent: sentBox };

const msg = (
  subject: string,
  text: string,
  date: string,
  flags: string[] = [],
): FakeStoredMessage => ({
  flags,
  subject,
  from: { name: "Sender", address: "sender@example.com" },
  to: [{ address: "you@example.com" }],
  text,
  date,
  messageId: `<${date}@example.com>`,
});

function fakeSyncConnection(mailboxes: Record<string, FakeMailbox>): ImapSyncConnection {
  return {
    openFolder: async (folder) => {
      const mailbox = mailboxes[folder];
      if (!mailbox) throw new Error(`no such folder: ${folder}`);
      return {
        uidValidity: mailbox.uidValidity,
        uidNext: mailbox.uidNext,
        exists: mailbox.messages.size,
        fetchRange: async (startUid, endUid) => {
          const out: FetchedMessage[] = [];
          for (const [uid, stored] of [...mailbox.messages.entries()].sort((a, b) => a[0] - b[0])) {
            if (uid >= startUid && uid <= endUid) out.push(mailbox.toFetched(uid, stored));
          }
          return out;
        },
        listUids: async () => [...mailbox.messages.keys()].sort((a, b) => a - b),
        fetchFlags: async (startUid, endUid) => {
          const rows: { uid: number; flags: string[] }[] = [];
          for (const [uid, stored] of mailbox.messages) {
            if (uid >= startUid && uid <= endUid) rows.push({ uid, flags: [...stored.flags] });
          }
          return rows.sort((a, b) => a.uid - b.uid);
        },
        release: async () => {},
      };
    },
    close: async () => {},
  };
}

const accountInput = {
  label: "Work",
  emailAddress: "you@example.com",
  username: "you@example.com",
  password: "fake-test-password",
  imapHost: "imap.example.com",
  smtpHost: "smtp.example.com",
};

let db: Store;
let config: Config;
let accountId: string;

const syncFactories: EmailFactories = {
  imap: async () => ({
    listMailboxes: async () => ["INBOX"],
    pageMessages: async () => ({ total: 0, messages: [] }),
    message: async () => null,
    close: async () => {},
  }),
  smtp: () => ({
    verify: async () => {},
    send: async () => "<sent@example.com>",
    close: async () => {},
  }),
  imapSync: async (_account: ResolvedEmailAccount) => fakeSyncConnection(mailboxes),
};

before(async () => {
  db = await createStore();
  config = {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: "/tmp/openmuse-email-mirror-test",
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    accessKey: "test-access-key",
    encryptionKey: randomBytes(32).toString("base64"),
  };
  const email = new EmailService(db, config, syncFactories);
  accountId = (await email.createAccount("owner-1", accountInput)).id;
});

after(async () => {
  await db.close();
});

function makeService() {
  return new EmailService(db, config, syncFactories);
}

test("initial sync populates the mirror newest-first", async () => {
  inbox.add(msg("Quarterly report", "Here is the quarterly report.", "2026-09-20T10:00:00.000Z"));
  inbox.add(msg("Lunch tomorrow?", "Want to grab lunch at noon?", "2026-09-21T12:00:00.000Z"));
  inbox.add(
    msg("Laptop order", "Please order 7 laptops for Heather Ridge.", "2026-09-22T09:00:00.000Z"),
  );

  const email = makeService();
  const reports = await email.syncMirrors("owner-1", accountId);
  assert.equal(reports.length, 2); // INBOX + Sent (Sent is empty)
  const inboxReport = reports.find((report) => report.folder === "INBOX");
  assert.equal(inboxReport?.added, 3);
  assert.equal(inboxReport?.deleted, 0);
  assert.equal(inboxReport?.resynced, false);

  const mirror = new MirrorStore(db);
  assert.equal(await mirror.count("owner-1", accountId, "INBOX"), 3);

  const page = await email.page("owner-1", accountId, {
    folder: "INBOX",
    query: "",
    page: 1,
    pageSize: 20,
  });
  assert.equal(page.total, 3);
  assert.ok(page.syncedAt);
  // Newest first: the laptop order (Sep 22) comes before the Sep 20 report.
  assert.deepEqual(
    page.items.map((item) => item.subject),
    ["Laptop order", "Lunch tomorrow?", "Quarterly report"],
  );
});

test("incremental sync adds only new UIDs", async () => {
  inbox.add(msg("AMEX receipt", "Your recent AMEX charge summary.", "2026-09-23T08:00:00.000Z"));
  inbox.add(msg("Follow-up", "Circling back on the proposal.", "2026-09-23T09:00:00.000Z"));

  const email = makeService();
  const reports = await email.syncMirrors("owner-1", accountId);
  const inboxReport = reports.find((report) => report.folder === "INBOX");
  assert.equal(inboxReport?.added, 2);

  const mirror = new MirrorStore(db);
  assert.equal(await mirror.count("owner-1", accountId, "INBOX"), 5);

  const page = await email.page("owner-1", accountId, {
    folder: "INBOX",
    query: "",
    page: 1,
    pageSize: 2,
  });
  assert.equal(page.total, 5);
  assert.deepEqual(
    page.items.map((item) => item.subject),
    ["Follow-up", "AMEX receipt"],
  );
});

test("server deletions are removed from the mirror", async () => {
  // Delete the oldest message (uid 1, "Quarterly report") server-side.
  inbox.messages.delete(1);

  const email = makeService();
  const reports = await email.syncMirrors("owner-1", accountId);
  const inboxReport = reports.find((report) => report.folder === "INBOX");
  assert.equal(inboxReport?.deleted, 1);

  const mirror = new MirrorStore(db);
  assert.equal(await mirror.count("owner-1", accountId, "INBOX"), 4);
  const page = await email.page("owner-1", accountId, {
    folder: "INBOX",
    query: "",
    page: 1,
    pageSize: 20,
  });
  assert.ok(!page.items.some((item) => item.subject === "Quarterly report"));
});

test("flag refresh updates unread state", async () => {
  // Mark "Lunch tomorrow?" (uid 2) as seen server-side.
  const lunch = inbox.messages.get(2);
  assert.ok(lunch);
  lunch.flags = ["\\Seen"];

  const email = makeService();
  await email.syncMirrors("owner-1", accountId);

  const page = await email.page("owner-1", accountId, {
    folder: "INBOX",
    query: "",
    page: 1,
    pageSize: 20,
  });
  const item = page.items.find((entry) => entry.subject === "Lunch tomorrow?");
  assert.ok(item);
  assert.equal(item.unread, false);
});

test("full-text search finds subject and body terms locally", async () => {
  const email = makeService();
  const bySubject = await email.page("owner-1", accountId, {
    folder: "INBOX",
    query: "laptops",
    page: 1,
    pageSize: 20,
  });
  assert.equal(bySubject.total, 1);
  assert.equal(bySubject.items[0]?.subject, "Laptop order");

  const byBody = await email.page("owner-1", accountId, {
    folder: "INBOX",
    query: "AMEX charge",
    page: 1,
    pageSize: 20,
  });
  assert.equal(byBody.total, 1);
  assert.equal(byBody.items[0]?.subject, "AMEX receipt");
});

test("multi-match search returns newest messages first", async () => {
  inbox.add(msg("Laptop accessories", "Order laptop bags too.", "2026-09-23T08:00:00.000Z"));
  inbox.add(msg("Old laptop quote", "An old quote for laptops.", "2026-09-19T08:00:00.000Z"));

  const email = makeService();
  await email.syncMirrors("owner-1", accountId);

  const page = await email.page("owner-1", accountId, {
    folder: "INBOX",
    query: "laptops",
    page: 1,
    pageSize: 20,
  });
  // All three match "laptops"; newest first regardless of relevance rank.
  assert.deepEqual(
    page.items.map((item) => item.subject),
    ["Laptop accessories", "Laptop order", "Old laptop quote"],
  );
});

test("uidvalidity change triggers a full resync", async () => {
  inbox.reset(99);
  inbox.add(
    msg("Brand new mailbox", "Everything after a server rebuild.", "2026-09-23T10:00:00.000Z"),
  );

  const email = makeService();
  const reports = await email.syncMirrors("owner-1", accountId);
  const inboxReport = reports.find((report) => report.folder === "INBOX");
  assert.equal(inboxReport?.resynced, true);
  assert.equal(inboxReport?.added, 1);

  const mirror = new MirrorStore(db);
  assert.equal(await mirror.count("owner-1", accountId, "INBOX"), 1);
  const page = await email.page("owner-1", accountId, {
    folder: "INBOX",
    query: "",
    page: 1,
    pageSize: 20,
  });
  assert.equal(page.total, 1);
  assert.equal(page.items[0]?.subject, "Brand new mailbox");
});

test("read serves the mirrored body without touching IMAP", async () => {
  const email = makeService();
  const message = await email.read("owner-1", accountId, "INBOX", 1);
  assert.equal(message.subject, "Brand new mailbox");
  assert.ok(message.body.includes("server rebuild"));
  assert.deepEqual(message.to, ["you@example.com"]);
});

test("page falls back to live IMAP when the mirror is empty", async () => {
  // A fresh owner/account pair has no mirror rows at all.
  const email = makeService();
  const created = await email.createAccount("owner-2", accountInput);
  const live: FetchedMessage[] = [
    {
      uid: 50,
      flags: [],
      subject: "Live only",
      from: [{ address: "live@example.com" }],
      to: [],
      cc: [],
      text: "Served from the live connection.",
    },
  ];
  const liveFactories: EmailFactories = {
    ...syncFactories,
    imap: async () => ({
      listMailboxes: async () => ["INBOX"],
      pageMessages: async () => ({ total: 1, messages: live }),
      message: async () => live[0] ?? null,
      close: async () => {},
    }),
  };
  const liveEmail = new EmailService(db, config, liveFactories);
  const page = await liveEmail.page("owner-2", created.id, {
    folder: "INBOX",
    query: "",
    page: 1,
    pageSize: 20,
  });
  assert.equal(page.total, 1);
  assert.equal(page.items[0]?.subject, "Live only");
  assert.equal(page.syncedAt, null);
});

test("syncMirrors without an imapSync factory fails closed", async () => {
  const noSync: EmailFactories = {
    imap: syncFactories.imap,
    smtp: syncFactories.smtp,
  };
  const email = new EmailService(db, config, noSync);
  await assert.rejects(() => email.syncMirrors("owner-1", accountId), /IMAP sync is not supported/);
});

test("syncFolderMirror is safe to re-run with no changes", async () => {
  const email = makeService();
  const account = { password: "unused" } as ResolvedEmailAccount;
  const logs: string[] = [];
  const first = await syncFolderMirror({
    owner: "owner-1",
    accountId,
    folder: "INBOX",
    account,
    factories: { imapSync: syncFactories.imapSync! },
    store: db,
    mirror: new MirrorStore(db),
    log: (message) => logs.push(message),
  });
  const second = await syncFolderMirror({
    owner: "owner-1",
    accountId,
    folder: "INBOX",
    account,
    factories: { imapSync: syncFactories.imapSync! },
    store: db,
    mirror: new MirrorStore(db),
    log: (message) => logs.push(message),
  });
  assert.equal(first.added, 0);
  assert.equal(second.added, 0);
  assert.equal(second.deleted, 0);
  assert.ok(logs.length > 0);
  void email;
});
