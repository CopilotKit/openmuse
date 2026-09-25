import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { Config } from "../apps/server/src/config.ts";
import { createEncryptedAuthState } from "../apps/server/src/connectors/whatsapp/auth-state.ts";
import {
  type BridgeCallbacks,
  normalizeInboundMessage,
  type StrippedMessage,
  type WhatsAppBridge,
} from "../apps/server/src/connectors/whatsapp/bridge.ts";
import { WhatsAppService } from "../apps/server/src/connectors/whatsapp/service.ts";
import type { Store } from "../apps/server/src/db.ts";
import { createStore } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";

/**
 * Fake bridge only — no Baileys import, no WhatsApp server contact, no QR
 * scanned. The callbacks are wired to the service exactly the way
 * whatsapp-entry.ts wires the real BaileysBridge.
 */

const OWNER = "owner-wa";
const ALLOWED_JID = "15551234567@s.whatsapp.net";
const STRANGER_JID = "19998887777@s.whatsapp.net";

type BridgeState = "idle" | "pairing" | "connected" | "needs_repair";

class FakeBridge implements WhatsAppBridge {
  state: BridgeState = "idle";
  readonly sent: { toJid: string; text: string }[] = [];
  readonly read: { chatJid: string; messageId: string }[] = [];
  /** Call order log: "route" entries are pushed by the test router. */
  readonly order: string[] = [];
  failSend = false;

  constructor(private readonly cb: BridgeCallbacks) {}

  async startPairing(_owner: string): Promise<void> {
    this.state = "pairing";
    await this.cb.onStatus("pairing");
    await this.cb.onQr("FAKE-QR-STRING");
  }
  async stopPairing(_owner: string): Promise<void> {
    this.state = "idle";
    await this.cb.onStatus("idle");
  }
  async sendText(toJid: string, text: string): Promise<{ messageId: string }> {
    if (this.failSend) throw new AppError("send failed", 502);
    this.sent.push({ toJid, text });
    return { messageId: "fake-mid-1" };
  }
  async markRead(chatJid: string, messageId: string): Promise<void> {
    this.read.push({ chatJid, messageId });
  }
  async logout(_owner: string): Promise<void> {
    this.state = "idle";
    await this.cb.onStatus("idle");
  }

  // Test drivers (what the real socket would do):
  async emitConnected(jid: string): Promise<void> {
    this.state = "connected";
    await this.cb.onStatus("connected", { jid });
  }
  async emitNeedsRepair(): Promise<void> {
    this.state = "needs_repair";
    await this.cb.onStatus("needs_repair", { reason: "test logout" });
  }
  async emitMessage(message: StrippedMessage): Promise<void> {
    await this.cb.onMessage(message);
  }
}

interface Fixture {
  db: Store;
  service: WhatsAppService;
  bridge: FakeBridge;
  routed: { owner: string; input: unknown }[];
  proposed: { owner: string; input: unknown }[];
}

async function fixture(t: { after: (fn: () => Promise<void> | void) => void }): Promise<Fixture> {
  const db = await createStore();
  t.after(() => db.close());
  const config = { encryptionKey: randomBytes(32).toString("base64") } as Config;
  const routed: Fixture["routed"] = [];
  const proposed: Fixture["proposed"] = [];
  let service!: WhatsAppService;
  const bridge = new FakeBridge({
    onQr: (qr) => service.reportQr(OWNER, qr),
    onStatus: (state, detail) => service.reportConnection(OWNER, state, detail),
    onMessage: (message) => service.handleInbound(OWNER, message),
  });
  service = new WhatsAppService(db, config, bridge, {
    router: {
      createTask: async (owner: string, input: unknown) => {
        routed.push({ owner, input });
        bridge.order.push("route");
        return { id: "task-1" };
      },
    },
    proposer: async (owner: string, input: unknown) => {
      proposed.push({ owner, input });
      return { id: "proposal-1", title: "Send WhatsApp", status: "awaiting_review" };
    },
  });
  // Mark-read ordering is asserted through the bridge's read log vs the
  // router's order log (route must come first).
  const origMarkRead = bridge.markRead.bind(bridge);
  bridge.markRead = async (chatJid: string, messageId: string) => {
    bridge.order.push("markRead");
    await origMarkRead(chatJid, messageId);
  };
  return { db, service, bridge, routed, proposed };
}

const inbound = (over: Partial<StrippedMessage> = {}): StrippedMessage => ({
  fromJid: STRANGER_JID,
  chatJid: STRANGER_JID,
  text: "hello from a stranger",
  hasMedia: false,
  messageId: "msg-1",
  timestamp: 1_700_000_000,
  ...over,
});

// ---------------------------------------------------------------------------
// Pairing lifecycle
// ---------------------------------------------------------------------------

test("pairing is refused until the ban-risk opt-in", async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(service.startPairing(OWNER), (error: unknown) => {
    assert.ok(error instanceof AppError && error.status === 403);
    return true;
  });
});

test("failed pairing start rolls back fully (no stale QR)", async (t) => {
  const { service, bridge } = await fixture(t);
  await service.recordConsent(OWNER, true);
  // Simulate a bridge that emits a QR and then throws mid-pairing.
  const original = bridge.startPairing.bind(bridge);
  bridge.startPairing = async (owner: string) => {
    await original(owner); // emits FAKE-QR-STRING via onQr
    throw new Error("socket blew up");
  };
  await assert.rejects(service.startPairing(OWNER), /socket blew up/);
  const status = await service.getStatus(OWNER);
  assert.equal(status.status, "not_paired");
  const qr = await service.getQr(OWNER);
  assert.equal(qr.qr, null, "stale QR must not linger after rollback");
  assert.equal(qr.status, "not_paired");
});

test("consent → pairing → QR → connected; status never exposes the QR", async (t) => {
  const { service } = await fixture(t);
  await service.recordConsent(OWNER, true);
  const started = await service.startPairing(OWNER);
  assert.equal(started.status, "pairing");
  assert.equal(started.consented, true);

  const qr = await service.getQr(OWNER);
  assert.equal(qr.qr, "FAKE-QR-STRING");
  assert.equal(qr.status, "pairing");
  assert.ok(qr.expiresAt, "QR carries an expiry");

  const status = await service.getStatus(OWNER);
  assert.ok(!("qr" in status), "getStatus must never expose the QR string");

  await service.reportConnection(OWNER, "connected", { jid: "15550001111@s.whatsapp.net" });
  const connected = await service.getStatus(OWNER);
  assert.equal(connected.status, "connected");
  assert.equal(connected.jid, "15550001111@s.whatsapp.net");

  const noQr = await service.getQr(OWNER);
  assert.equal(noQr.qr, null, "QR is cleared once connected");
});

test("withdrawing consent blocks pairing again", async (t) => {
  const { service } = await fixture(t);
  await service.recordConsent(OWNER, true);
  await service.recordConsent(OWNER, false);
  const status = await service.getStatus(OWNER);
  assert.equal(status.consented, false);
  await assert.rejects(service.startPairing(OWNER), /opt-in/);
});

// ---------------------------------------------------------------------------
// Inbound normalization (pure)
// ---------------------------------------------------------------------------

test("normalizeInboundMessage ignores own/status/newsletter/malformed, drops push names", () => {
  const base = {
    key: { remoteJid: ALLOWED_JID, id: "m1", fromMe: false },
    message: { conversation: "hi" },
    messageTimestamp: 1_700_000_000,
  };
  const ok = normalizeInboundMessage(base);
  assert.ok(ok);
  assert.equal(ok.fromJid, ALLOWED_JID);
  assert.equal(ok.chatJid, ALLOWED_JID);
  assert.ok(!("pushName" in ok), "push/display names are dropped");

  assert.equal(normalizeInboundMessage({ ...base, key: { ...base.key, fromMe: true } }), null);
  assert.equal(
    normalizeInboundMessage({ ...base, key: { ...base.key, remoteJid: "status@broadcast" } }),
    null,
  );
  assert.equal(
    normalizeInboundMessage({ ...base, key: { ...base.key, remoteJid: "123@newsletter" } }),
    null,
  );
  assert.equal(normalizeInboundMessage({ key: {} }), null);
  assert.equal(normalizeInboundMessage(null), null);

  // Group message: sender is the participant, chat is the group.
  const group = normalizeInboundMessage({
    key: { remoteJid: "120363@g.us", participant: ALLOWED_JID, id: "m2" },
    message: { conversation: "group hi" },
    messageTimestamp: 1_700_000_001,
  });
  assert.ok(group);
  assert.equal(group.fromJid, ALLOWED_JID);
  assert.equal(group.chatJid, "120363@g.us");

  // Media-only message: no text, but flagged.
  const media = normalizeInboundMessage({
    key: { remoteJid: ALLOWED_JID, id: "m3" },
    message: { imageMessage: { caption: "" } },
    messageTimestamp: 1_700_000_002,
  });
  assert.ok(media);
  assert.equal(media.hasMedia, true);

  // Empty text-only payloads are ignored.
  assert.equal(
    normalizeInboundMessage({ key: { remoteJid: ALLOWED_JID, id: "m4" }, message: {} }),
    null,
  );

  // Push name present in the raw payload is discarded.
  const withName = normalizeInboundMessage({ ...base, pushName: "Evil Impersonator" });
  assert.ok(withName && !("pushName" in withName));
});

// ---------------------------------------------------------------------------
// Inbound pipeline: default-deny, routing, read receipts
// ---------------------------------------------------------------------------

test("unknown senders are recorded but never routed (default-deny)", async (t) => {
  const { service, routed, bridge } = await fixture(t);
  const result = await service.handleInbound(OWNER, inbound());
  assert.deepEqual(result, { recorded: true, routed: false });
  assert.equal(routed.length, 0, "router must not run for unknown senders");
  assert.equal(bridge.read.length, 0, "denied messages are never marked read");
  const records = await service.searchRecent(OWNER, { query: "", limit: 10 });
  assert.equal(records.length, 1);
  assert.equal(records[0].routed, false);
  assert.ok(!("pushName" in records[0]), "stored records are metadata-only");
});

test("allowed sender routes to the agent and is marked read only after routing", async (t) => {
  const { service, routed, bridge } = await fixture(t);
  await service.addRule(OWNER, { jid: STRANGER_JID, action: "allow", label: "friend" });
  const result = await service.handleInbound(OWNER, inbound());
  assert.deepEqual(result, { recorded: true, routed: true });
  assert.equal(routed.length, 1);
  const task = routed[0].input as { prompt: string };
  assert.ok(
    task.prompt.includes("untrusted"),
    "routed tasks frame inbound text as untrusted third-party content",
  );
  assert.ok(task.prompt.includes(STRANGER_JID));

  assert.deepEqual(bridge.order, ["route", "markRead"], "markRead runs only after routing");
  assert.deepEqual(bridge.read, [{ chatJid: STRANGER_JID, messageId: "msg-1" }]);

  const records = await service.searchRecent(OWNER, { query: "", limit: 10 });
  assert.equal(records[0].routed, true);
});

test("deny wins over allow", async (t) => {
  const { service, routed } = await fixture(t);
  await service.addRule(OWNER, { jid: STRANGER_JID, action: "allow" });
  await service.addRule(OWNER, { jid: STRANGER_JID, action: "deny" });
  const result = await service.handleInbound(OWNER, inbound());
  assert.equal(result.routed, false);
  assert.equal(routed.length, 0);
});

test("group message routes when the participant is allowed", async (t) => {
  const { service, routed } = await fixture(t);
  await service.addRule(OWNER, { jid: ALLOWED_JID, action: "allow" });
  const result = await service.handleInbound(
    OWNER,
    inbound({ fromJid: ALLOWED_JID, chatJid: "120363@g.us", messageId: "g1" }),
  );
  assert.equal(result.routed, true);
  assert.equal(routed.length, 1);
});

test("duplicate inbound messages are not re-routed", async (t) => {
  const { service, routed } = await fixture(t);
  await service.addRule(OWNER, { jid: STRANGER_JID, action: "allow" });
  const first = await service.handleInbound(OWNER, inbound());
  const second = await service.handleInbound(OWNER, inbound());
  assert.equal(first.routed, true);
  assert.deepEqual(second, { recorded: true, routed: false, duplicate: true });
  assert.equal(routed.length, 1);
});

test("invalid JIDs are rejected before any routing", async (t) => {
  const { service, routed } = await fixture(t);
  await service.addRule(OWNER, { jid: STRANGER_JID, action: "allow" });
  await assert.rejects(service.handleInbound(OWNER, inbound({ fromJid: "not-a-jid" })), /jid/i);
  assert.equal(routed.length, 0);
});

// ---------------------------------------------------------------------------
// Logout / repair wipes the encrypted envelope
// ---------------------------------------------------------------------------

test("needs_repair wipes the encrypted auth envelope", async (t) => {
  const { db, service, bridge } = await fixture(t);
  // Seed an envelope; the service must wipe it on needs_repair even though
  // this fake bridge never wiped anything itself.
  const seeder = await createEncryptedAuthState(
    db,
    { encryptionKey: randomBytes(32).toString("base64") } as Config,
    OWNER,
  );
  await seeder.saveCreds({ me: { id: "1@s.whatsapp.net" } });
  assert.ok(await db.get(OWNER, "whatsapp-auth", "creds"), "envelope seeded");
  await bridge.emitNeedsRepair();
  assert.equal(await db.get(OWNER, "whatsapp-auth", "creds"), null, "envelope wiped");
  const status = await service.getStatus(OWNER);
  assert.equal(status.status, "needs_repair");
  assert.equal(status.jid, undefined);
});

test("logout wipes the envelope and notifies", async (t) => {
  const { db, service } = await fixture(t);
  const seeded = await createEncryptedAuthState(
    db,
    { encryptionKey: randomBytes(32).toString("base64") } as Config,
    OWNER,
  );
  await seeded.saveCreds({ me: { id: "1@s.whatsapp.net" } });
  const status = await service.logout(OWNER);
  assert.equal(status.status, "not_paired");
  assert.equal(status.jid, undefined);
  assert.equal(await db.get(OWNER, "whatsapp-auth", "creds"), null, "envelope wiped on logout");
  const notes = await db.list<{ title: string }>(OWNER, "notifications");
  assert.ok(notes.some((n) => n.title === "WhatsApp disconnected"));
});

// ---------------------------------------------------------------------------
// Outbound: reviewed actions only, allow-list gated
// ---------------------------------------------------------------------------

test("proposeSend delegates a whatsapp.send proposal (never sends)", async (t) => {
  const { service, proposed, bridge } = await fixture(t);
  const receipt = await service.proposeSend(OWNER, { toJid: ALLOWED_JID, text: "hi" });
  assert.equal(receipt.id, "proposal-1");
  assert.equal(proposed.length, 1);
  assert.deepEqual(proposed[0].input, {
    kind: "whatsapp.send",
    data: { toJid: ALLOWED_JID, text: "hi" },
  });
  assert.equal(bridge.sent.length, 0, "proposing must never send");
});

test("executeApprovedSend refuses non-allow-listed recipients", async (t) => {
  const { service, bridge } = await fixture(t);
  await service.recordConsent(OWNER, true);
  await bridge.emitConnected("15550001111@s.whatsapp.net");
  await assert.rejects(
    service.executeApprovedSend(OWNER, { toJid: STRANGER_JID, text: "hi" }, "wa:pairing"),
    (error: unknown) => {
      assert.ok(error instanceof AppError && error.status === 403);
      return true;
    },
  );
  assert.equal(bridge.sent.length, 0);
});

test("executeApprovedSend sends to allow-listed recipients while connected", async (t) => {
  const { service, bridge } = await fixture(t);
  await service.recordConsent(OWNER, true);
  await service.addRule(OWNER, { jid: ALLOWED_JID, action: "allow" });
  await bridge.emitConnected("15550001111@s.whatsapp.net");
  const receipt = await service.executeApprovedSend(
    OWNER,
    { toJid: ALLOWED_JID, text: "hello" },
    "wa:pairing",
  );
  assert.ok(receipt.includes("Sent via WhatsApp"));
  assert.deepEqual(bridge.sent, [{ toJid: ALLOWED_JID, text: "hello" }]);
});

test("executeApprovedSend refuses when disconnected or the connection changed", async (t) => {
  const { service } = await fixture(t);
  await service.recordConsent(OWNER, true);
  await service.addRule(OWNER, { jid: ALLOWED_JID, action: "allow" });
  await assert.rejects(
    service.executeApprovedSend(OWNER, { toJid: ALLOWED_JID, text: "hi" }, "wa:pairing"),
    /not connected/,
  );
  await service.reportConnection(OWNER, "connected", { jid: "15550001111@s.whatsapp.net" });
  await assert.rejects(
    service.executeApprovedSend(OWNER, { toJid: ALLOWED_JID, text: "hi" }, "imap:other"),
    /connection changed/,
  );
});

// ---------------------------------------------------------------------------
// Rules, search, lease
// ---------------------------------------------------------------------------

test("rules upsert by JID and validate JIDs", async (t) => {
  const { service } = await fixture(t);
  const first = await service.addRule(OWNER, { jid: ALLOWED_JID, action: "allow" });
  const second = await service.addRule(OWNER, { jid: ALLOWED_JID, action: "deny", label: "x" });
  assert.equal(first.id, second.id, "same JID updates the existing rule");
  assert.equal(second.action, "deny");
  const rules = await service.listRules(OWNER);
  assert.equal(rules.length, 1);
  await service.removeRule(OWNER, second.id);
  assert.deepEqual(await service.listRules(OWNER), []);
  await assert.rejects(service.removeRule(OWNER, "missing"), /not found/i);
});

test("searchRecent filters by words over JID + text", async (t) => {
  const { service } = await fixture(t);
  await service.addRule(OWNER, { jid: STRANGER_JID, action: "allow" });
  await service.addRule(OWNER, { jid: ALLOWED_JID, action: "allow" });
  await service.handleInbound(OWNER, inbound({ messageId: "a", text: "dinner plans tonight" }));
  await service.handleInbound(
    OWNER,
    inbound({ fromJid: ALLOWED_JID, chatJid: ALLOWED_JID, messageId: "b", text: "meeting notes" }),
  );
  const dinner = await service.searchRecent(OWNER, { query: "dinner", limit: 10 });
  assert.equal(dinner.length, 1);
  assert.equal(dinner[0].messageId, "a");
  const byJid = await service.searchRecent(OWNER, { query: "5551234567", limit: 10 });
  assert.equal(byJid.length, 1);
  assert.equal(byJid[0].fromJid, ALLOWED_JID);
});

test("sidecar lease admits one holder at a time", async (t) => {
  const { service } = await fixture(t);
  assert.equal(await service.acquireLease("holder-a", 60_000), true);
  assert.equal(await service.acquireLease("holder-b", 60_000), false);
  assert.equal(await service.renewLease("holder-b", 60_000), false);
  assert.equal(await service.renewLease("holder-a", 60_000), true);
  await service.releaseLease("holder-b"); // not the holder: no-op
  assert.equal(await service.acquireLease("holder-b", 60_000), false);
  await service.releaseLease("holder-a");
  assert.equal(await service.acquireLease("holder-b", 60_000), true);
});
