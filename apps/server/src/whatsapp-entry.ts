import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { loadServerSecrets } from "./config/server-secrets.ts";
import { readConfig } from "./config.ts";
import { createEncryptedAuthState } from "./connectors/whatsapp/auth-state.ts";
import { BaileysBridge, type StrippedMessage } from "./connectors/whatsapp/bridge.ts";
import { whatsappJidSchema } from "./connectors/whatsapp/schemas.ts";
import { WhatsAppService } from "./connectors/whatsapp/service.ts";
import { createStore } from "./db.ts";
import { AppError } from "./errors.ts";

/**
 * WhatsApp sidecar: the only process that holds a Baileys socket.
 *
 * Mirrors worker-entry.ts. Requires DATABASE_URL, TOKEN_ENCRYPTION_KEY and
 * WHATSAPP_SIDECAR_TOKEN. The admin surface is localhost-only, bearer-token
 * authenticated, and has CORS closed (no cors middleware). Inbound messages
 * are stripped by the bridge and forwarded to the API process
 * (POST /internal/whatsapp/inbound) for allow/deny filtering and agent
 * routing; the sidecar marks them read only after the API acknowledges.
 *
 * Single-instance: the sidecar holds a DB lease (whatsapp-lease). A second
 * sidecar exits at boot while the lease is live — two sockets would kick
 * each other off WhatsApp.
 *
 * NOTE: starting this process does NOT connect to WhatsApp. A socket opens
 * only after the owner opts in and starts pairing from the app; no QR is
 * generated and no session is created before that.
 */

// Vault bootstrap (TRACK C, see index.ts): connect with the .env bootstrap
// values, materialize vault secrets into process.env, then read the config.
const db = await createStore({ databaseUrl: process.env.DATABASE_URL });
await loadServerSecrets(db, process.env.TOKEN_ENCRYPTION_KEY);
const config = readConfig();
if (!config.databaseUrl)
  throw new Error("The WhatsApp sidecar requires DATABASE_URL (shared with the API).");
if (!config.encryptionKey) throw new Error("The WhatsApp sidecar requires TOKEN_ENCRYPTION_KEY.");
const sidecarToken = process.env.WHATSAPP_SIDECAR_TOKEN;
if (!sidecarToken) throw new Error("The WhatsApp sidecar requires WHATSAPP_SIDECAR_TOKEN.");
const port = Number(process.env.WHATSAPP_SIDECAR_PORT ?? 8791);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("WHATSAPP_SIDECAR_PORT must be a valid port");

const LEASE_TTL_MS = 60_000;
const LEASE_RENEW_MS = 20_000;
const ACTIVE_KIND = "whatsapp-sidecar";
const ACTIVE_ID = "active";

const holder = randomUUID();

let service: WhatsAppService;
let activeOwner: string | null = null;

const rememberActiveOwner = async (owner: string | null): Promise<void> => {
  activeOwner = owner;
  if (owner) await db.put("sidecar", ACTIVE_KIND, { id: ACTIVE_ID, owner });
  else await db.remove("sidecar", ACTIVE_KIND, ACTIVE_ID).catch(() => undefined);
};

/** Forward a stripped message to the API for filtering + routing. */
const forwardInbound = async (owner: string, message: StrippedMessage): Promise<boolean> => {
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/internal/whatsapp/inbound`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sidecarToken}`,
      },
      body: JSON.stringify({ owner, message }),
    });
    return res.ok;
  } catch {
    return false;
  }
};

const bridge = new BaileysBridge((owner) => createEncryptedAuthState(db, config, owner), {
  onQr: (qr) => {
    if (activeOwner) return service.reportQr(activeOwner, qr);
  },
  onStatus: (state, detail) => {
    if (activeOwner) return service.reportConnection(activeOwner, state, detail);
    if (state === "idle" || state === "needs_repair") return rememberActiveOwner(null);
  },
  onMessage: async (message) => {
    if (!activeOwner) return;
    // The API filters, records and routes the message; the service marks
    // it read only after routing (inside handleInbound). Forwarding here
    // is fire-and-forget: a failed forward leaves the message unread so
    // nothing is silently dropped.
    await forwardInbound(activeOwner, message);
  },
});
service = new WhatsAppService(db, config, bridge);

// --- admin API ---------------------------------------------------------------

const admin = new Hono();
admin.use("*", async (c, next) => {
  if (c.req.header("authorization") !== `Bearer ${sidecarToken}`)
    throw new AppError("Forbidden", 403);
  await next();
});
admin.onError((error, c) => {
  if (error instanceof z.ZodError) return c.json({ error: "Invalid request data" }, 422);
  if (error instanceof AppError) return c.json({ error: error.message }, error.status);
  console.error(`[whatsapp-sidecar] ${error instanceof Error ? error.message : String(error)}`);
  return c.json({ error: "Sidecar request failed" }, 502);
});

const ownerSchema = z.object({ owner: z.string().min(1).max(200) });

// Outbound sends are serialized (one at a time) and deduplicated by
// idempotency key so a retried approval cannot double-send.
let sendChain: Promise<unknown> = Promise.resolve();
const sentKeys = new Map<string, { messageId: string }>();

admin.post("/admin/pair/start", async (c) => {
  const { owner } = ownerSchema.parse(await c.req.json());
  await rememberActiveOwner(owner);
  try {
    await bridge.startPairing(owner);
  } catch (error) {
    await rememberActiveOwner(null);
    throw error;
  }
  return c.json({ ok: true });
});

admin.post("/admin/pair/stop", async (c) => {
  const { owner } = ownerSchema.parse(await c.req.json());
  await bridge.stopPairing(owner);
  await rememberActiveOwner(null);
  return c.json({ ok: true });
});

admin.post("/admin/send", async (c) => {
  const body = z
    .object({
      toJid: whatsappJidSchema,
      text: z.string().trim().min(1).max(4096),
      idempotencyKey: z.string().min(1).max(200).optional(),
    })
    .parse(await c.req.json());
  const key = body.idempotencyKey ?? randomUUID();
  const cached = sentKeys.get(key);
  if (cached) return c.json(cached);
  // The sequencing chain always resolves (errors are isolated per call) so
  // one failed send cannot poison later ones.
  const run = sendChain.catch(() => undefined).then(() => bridge.sendText(body.toJid, body.text));
  sendChain = run.catch(() => undefined);
  const receipt = await run;
  sentKeys.set(key, receipt);
  if (sentKeys.size > 500) sentKeys.delete(sentKeys.keys().next().value as string);
  return c.json(receipt);
});

admin.post("/admin/mark-read", async (c) => {
  const body = z
    .object({ chatJid: whatsappJidSchema, messageId: z.string().min(1).max(200) })
    .parse(await c.req.json());
  await bridge.markRead(body.chatJid, body.messageId);
  return c.json({ ok: true });
});

admin.post("/admin/logout", async (c) => {
  const { owner } = ownerSchema.parse(await c.req.json());
  await bridge.logout(owner);
  await rememberActiveOwner(null);
  return c.json({ ok: true });
});

admin.get("/admin/status", async (c) => {
  const active = await db.get<{ owner: string }>("sidecar", ACTIVE_KIND, ACTIVE_ID);
  return c.json({ state: bridge.state, owner: active?.owner ?? activeOwner ?? null });
});

// --- boot --------------------------------------------------------------------

const acquired = await service.acquireLease(holder, LEASE_TTL_MS);
if (!acquired) {
  console.error("[whatsapp-sidecar] another sidecar holds the lease; exiting");
  await db.close();
  process.exit(1);
}
const renewTimer = setInterval(() => {
  void service.renewLease(holder, LEASE_TTL_MS).catch(() => undefined);
}, LEASE_RENEW_MS);
renewTimer.unref();

// Resume a live session after a restart (creds are reused; no new QR).
const previous = await db.get<{ owner: string }>("sidecar", ACTIVE_KIND, ACTIVE_ID);
if (previous?.owner) {
  const status = await service.getStatus(previous.owner);
  if (status.status === "connected" || status.status === "pairing") {
    activeOwner = previous.owner;
    bridge.startPairing(previous.owner).catch((error: unknown) => {
      console.error(
        `[whatsapp-sidecar] resume failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      void rememberActiveOwner(null);
    });
  } else {
    await rememberActiveOwner(null);
  }
}

const server = serve({ fetch: admin.fetch, port, hostname: "127.0.0.1" }, () =>
  console.log(
    `[whatsapp-sidecar] admin on 127.0.0.1:${port} (no WhatsApp connection until pairing)`,
  ),
);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(renewTimer);
  server.close();
  await service.releaseLease(holder).catch(() => undefined);
  await db.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
