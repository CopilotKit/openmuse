import { AppError } from "../../errors.ts";
import type { EncryptedAuthState } from "./auth-state.ts";
import { whatsappJidSchema } from "./schemas.ts";

/**
 * Baileys bridge: socket management for the WhatsApp sidecar.
 *
 * The Baileys package (@whiskeysockets/baileys) is loaded LAZILY via
 * loadBaileys() so the API process never touches it — only the sidecar
 * (whatsapp-entry.ts) constructs BaileysBridge. Tests use FakeBridge
 * (defined in the test file); no test ever opens a real WhatsApp socket.
 *
 * Structural Baileys types below are verified against
 * @whiskeysockets/baileys@7.0.0-rc14 (see /tmp tarball inspection notes in
 * the README); the module is validated at load time and a clear 503 is
 * thrown when the package is not installed.
 */

export type BridgeState = "idle" | "pairing" | "connected" | "needs_repair";

/** Inbound message stripped to metadata before the agent ever sees it. */
export interface StrippedMessage {
  fromJid: string;
  chatJid: string;
  text: string;
  hasMedia: boolean;
  messageId: string;
  timestamp: number;
}

export interface BridgeCallbacks {
  onQr(qr: string): unknown;
  onStatus(state: BridgeState, detail?: { jid?: string; reason?: string }): unknown;
  onMessage(message: StrippedMessage): unknown;
}

/**
 * Control surface the service uses. BaileysBridge implements it with a real
 * socket (sidecar); HttpSidecarBridge implements it over localhost HTTP (API
 * process). Inbound events only fire on the sidecar's bridge.
 */
export interface WhatsAppBridge {
  readonly state: BridgeState;
  startPairing(owner: string): Promise<void>;
  stopPairing(owner: string): Promise<void>;
  sendText(toJid: string, text: string, idempotencyKey?: string): Promise<{ messageId: string }>;
  markRead(chatJid: string, messageId: string): Promise<void>;
  logout(owner: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Inbound normalization (pure; unit-tested with fake payloads)
// ---------------------------------------------------------------------------

const STATUS_JID = "status@broadcast";

interface RawMessageKey {
  remoteJid?: string;
  fromMe?: boolean;
  id?: string;
  participant?: string;
}

interface RawMessage {
  key?: RawMessageKey;
  message?: Record<string, unknown>;
  messageTimestamp?: number | { low?: number };
  pushName?: string;
}

const textOf = (message: Record<string, unknown> | undefined): string => {
  if (!message || typeof message !== "object") return "";
  if (typeof message.conversation === "string") return message.conversation;
  const extended = message.extendedTextMessage as { text?: unknown } | undefined;
  if (extended && typeof extended.text === "string") return extended.text;
  // Captions count as text; the media itself is never forwarded.
  for (const key of ["imageMessage", "videoMessage", "documentMessage", "audioMessage"]) {
    const media = message[key] as { caption?: unknown } | undefined;
    if (media && typeof media.caption === "string" && media.caption.trim()) return media.caption;
  }
  return "";
};

const hasMediaOf = (message: Record<string, unknown> | undefined): boolean => {
  if (!message || typeof message !== "object") return false;
  return ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"].some(
    (key) => message[key] !== undefined && message[key] !== null,
  );
};

/**
 * Normalize one raw messages.upsert entry. Returns null for anything the
 * connector must ignore: own messages, status broadcasts, newsletters,
 * and malformed entries. Display/push names are dropped — the JID is the
 * only identity.
 */
export function normalizeInboundMessage(raw: unknown): StrippedMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const { key, message, messageTimestamp } = raw as RawMessage;
  const remoteJid = key?.remoteJid;
  const messageId = key?.id;
  if (!remoteJid || !messageId || key?.fromMe) return null;
  if (remoteJid === STATUS_JID || remoteJid.endsWith("@newsletter")) return null;
  const text = textOf(message).slice(0, 8192);
  if (!text && !hasMediaOf(message)) return null;
  const timestamp =
    typeof messageTimestamp === "number"
      ? messageTimestamp
      : (messageTimestamp?.low ?? Math.floor(Date.now() / 1000));
  return {
    // In groups the sender is the participant; otherwise the chat itself.
    fromJid: key?.participant ?? remoteJid,
    chatJid: remoteJid,
    text,
    hasMedia: hasMediaOf(message),
    messageId,
    timestamp: Number(timestamp) || Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// Lazy Baileys loading (structural types; validated at runtime)
// ---------------------------------------------------------------------------

interface ILoggerLike {
  level: string;
  child(obj: Record<string, unknown>): ILoggerLike;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

interface ConnectionUpdate {
  connection?: "open" | "close" | "connecting";
  qr?: string;
  lastDisconnect?: { error?: unknown };
}

interface WASocketLike {
  ev: {
    on(event: "connection.update", listener: (update: ConnectionUpdate) => void): void;
    on(event: "messages.upsert", listener: (upsert: { messages: unknown[] }) => void): void;
    on(event: "creds.update", listener: () => void): void;
    off(event: string, listener: (...args: unknown[]) => void): void;
  };
  user?: { id?: string };
  sendMessage(
    jid: string,
    content: { text: string },
  ): Promise<{ key?: { id?: string } } | undefined>;
  readMessages(keys: { remoteJid?: string; id?: string; fromMe?: boolean }[]): Promise<void>;
  logout(msg?: string): Promise<void>;
  end(error?: Error): void;
}

interface BaileysModule {
  makeWASocket(config: {
    version?: [number, number, number];
    auth: { creds: unknown; keys: unknown };
    printQRInTerminal: boolean;
    browser: [string, string, string];
    syncFullHistory: boolean;
    markOnlineOnConnect: boolean;
    logger: ILoggerLike;
  }): WASocketLike;
  initAuthCreds(): unknown;
  fetchLatestBaileysVersion(): Promise<{ version: [number, number, number]; isLatest: boolean }>;
  DisconnectReason: Record<string, number>;
}

const BAILEYS_SPECIFIER: string = "@whiskeysockets/baileys";

async function loadBaileys(): Promise<BaileysModule> {
  let loaded: unknown;
  try {
    loaded = await import(BAILEYS_SPECIFIER);
  } catch {
    throw new AppError(
      "Baileys is not installed. Run pnpm install on the deployment host, then restart the WhatsApp sidecar.",
      503,
    );
  }
  const mod = loaded as Partial<BaileysModule>;
  if (
    typeof mod.makeWASocket !== "function" ||
    typeof mod.initAuthCreds !== "function" ||
    typeof mod.fetchLatestBaileysVersion !== "function" ||
    !mod.DisconnectReason
  ) {
    throw new AppError("The installed Baileys package has an unexpected shape", 500);
  }
  return mod as BaileysModule;
}

const silentLogger = (): ILoggerLike => {
  const noop = () => undefined;
  const logger: ILoggerLike = {
    level: "silent",
    child: () => logger,
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
  return logger;
};

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;

// ---------------------------------------------------------------------------
// BaileysBridge — real socket; constructed only in the sidecar process
// ---------------------------------------------------------------------------

export class BaileysBridge implements WhatsAppBridge {
  state: BridgeState = "idle";
  private sock: WASocketLike | null = null;
  private mod: BaileysModule | null = null;
  private stopped = true;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners: { event: string; listener: (...args: unknown[]) => void }[] = [];
  private readonly authStateFor: (owner: string) => Promise<EncryptedAuthState>;
  private readonly callbacks: BridgeCallbacks;
  private owner: string | null;

  constructor(
    authStateFor: (owner: string) => Promise<EncryptedAuthState>,
    callbacks: BridgeCallbacks,
    owner: string | null = null,
  ) {
    this.authStateFor = authStateFor;
    this.callbacks = callbacks;
    this.owner = owner;
  }

  async startPairing(owner: string): Promise<void> {
    if (this.state === "connected") throw new AppError("WhatsApp is already connected", 409);
    if (this.state === "pairing" && this.owner === owner) return;
    if (this.state === "pairing") throw new AppError("Another pairing is in progress", 409);
    this.owner = owner;
    this.stopped = false;
    this.reconnectAttempts = 0;
    this.state = "pairing";
    await this.callbacks.onStatus("pairing");
    await this.connect();
  }

  async stopPairing(owner: string): Promise<void> {
    if (this.owner !== owner) throw new AppError("No pairing in progress for this owner", 404);
    this.stopped = true;
    this.clearReconnectTimer();
    this.teardownSocket();
    this.owner = null;
    this.state = "idle";
    await this.callbacks.onStatus("idle");
  }

  async sendText(toJid: string, text: string): Promise<{ messageId: string }> {
    whatsappJidSchema.parse(toJid);
    if (!this.sock || this.state !== "connected")
      throw new AppError("WhatsApp is not connected", 409);
    const sent = await this.sock.sendMessage(toJid, { text });
    return { messageId: sent?.key?.id ?? "" };
  }

  async markRead(chatJid: string, messageId: string): Promise<void> {
    if (!this.sock) return;
    await this.sock
      .readMessages([{ remoteJid: chatJid, id: messageId, fromMe: false }])
      .catch(() => undefined);
  }

  async logout(owner: string): Promise<void> {
    if (this.owner !== owner) throw new AppError("No WhatsApp session for this owner", 404);
    this.stopped = true;
    this.clearReconnectTimer();
    try {
      await this.sock?.logout();
    } catch {
      // Already dead — fall through to teardown.
    }
    this.teardownSocket();
    this.owner = null;
    this.state = "idle";
    await this.callbacks.onStatus("idle");
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private teardownSocket(): void {
    if (this.sock) {
      for (const { event, listener } of this.listeners) {
        try {
          this.sock.ev.off(event, listener);
        } catch {
          // ignore
        }
      }
      this.listeners.length = 0;
      try {
        this.sock.end();
      } catch {
        // ignore
      }
      this.sock = null;
    }
  }

  private on(
    event: "connection.update" | "messages.upsert" | "creds.update",
    listener: (...args: never[]) => void,
  ): void {
    const ev = this.sock?.ev;
    if (ev) (ev.on as (name: string, fn: (...args: never[]) => void) => void)(event, listener);
    this.listeners.push({ event, listener: listener as (...args: unknown[]) => void });
  }

  private async connect(): Promise<void> {
    const owner = this.owner;
    if (!owner || this.stopped) return;
    if (!this.mod) this.mod = await loadBaileys();
    const mod = this.mod;
    const authState = await this.authStateFor(owner);
    let version: [number, number, number] | undefined;
    try {
      version = (await mod.fetchLatestBaileysVersion()).version;
    } catch {
      version = undefined; // offline version check: Baileys falls back internally
    }
    // The mutable creds object the socket is built with; creds.update
    // carries a partial which is merged here before persisting the envelope.
    const liveCreds = (authState.creds ?? mod.initAuthCreds()) as Record<string, unknown>;
    const sock = mod.makeWASocket({
      version,
      auth: { creds: liveCreds, keys: authState.keys },
      printQRInTerminal: false,
      browser: ["OpenMuse", "Chrome", "1.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      logger: silentLogger(),
    });
    this.sock = sock;

    this.on("creds.update", (partial) => {
      // Persist encrypted creds on every update; never log them.
      if (partial && typeof partial === "object") Object.assign(liveCreds, partial);
      void authState.saveCreds(liveCreds).catch(() => undefined);
    });

    this.on("connection.update", (raw) => {
      void this.handleConnectionUpdate(raw as ConnectionUpdate, authState).catch(() => undefined);
    });

    this.on("messages.upsert", (raw) => {
      const upsert = raw as { messages?: unknown[] };
      for (const item of upsert.messages ?? []) {
        const stripped = normalizeInboundMessage(item);
        if (stripped)
          void Promise.resolve(this.callbacks.onMessage(stripped)).catch(() => undefined);
      }
    });
  }

  private loggedOut(update: ConnectionUpdate): boolean {
    const statusCode = (
      update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
    )?.output?.statusCode;
    return statusCode === this.mod?.DisconnectReason.loggedOut || statusCode === 401;
  }

  private async handleConnectionUpdate(
    update: ConnectionUpdate,
    authState: EncryptedAuthState,
  ): Promise<void> {
    // The QR is a short-lived secret: hand it to the callback (which stores
    // it server-side for the pairing UI) and never log it.
    if (update.qr) await this.callbacks.onQr(update.qr);
    if (update.connection === "open") {
      this.reconnectAttempts = 0;
      this.state = "connected";
      const jid = this.sock?.user?.id;
      await this.callbacks.onStatus("connected", jid ? { jid } : undefined);
      return;
    }
    if (update.connection === "close") {
      const wasPairing = this.state === "pairing";
      this.teardownSocket();
      if (this.stopped) return;
      if (this.loggedOut(update)) {
        // Session revoked on the phone (or banned): the creds are dead.
        await authState.wipe().catch(() => undefined);
        this.state = "needs_repair";
        this.owner = null;
        await this.callbacks.onStatus("needs_repair", { reason: "logged out" });
        return;
      }
      if (wasPairing) {
        // Never auto-retry a failed pairing: the user must start over with a
        // fresh QR after explicit consent.
        this.state = "idle";
        this.owner = null;
        await this.callbacks.onStatus("idle", { reason: "pairing closed" });
        return;
      }
      // Transient drop on a live session: backoff reconnect.
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
      this.reconnectAttempts += 1;
      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.connect().catch(() => undefined);
      }, delay);
    }
  }
}

// ---------------------------------------------------------------------------
// HttpSidecarBridge — API-process control client for the sidecar admin API
// ---------------------------------------------------------------------------

export class HttpSidecarBridge implements WhatsAppBridge {
  readonly state: BridgeState = "idle";
  private readonly baseUrl: string | undefined;
  private readonly token: string | undefined;

  constructor(baseUrl: string | undefined, token: string | undefined) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  private async call<T>(path: string, body: unknown): Promise<T> {
    if (!this.baseUrl || !this.token)
      throw new AppError(
        "The WhatsApp sidecar is not configured (WHATSAPP_SIDECAR_URL / WHATSAPP_SIDECAR_TOKEN)",
        503,
      );
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new AppError("The WhatsApp sidecar is unreachable", 502);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      throw new AppError(
        text || "The WhatsApp sidecar rejected the request",
        res.status === 404 ? 404 : 502,
      );
    }
    return (await res.json()) as T;
  }

  startPairing(owner: string): Promise<void> {
    return this.call("/admin/pair/start", { owner }).then(() => undefined);
  }
  stopPairing(owner: string): Promise<void> {
    return this.call("/admin/pair/stop", { owner }).then(() => undefined);
  }
  sendText(toJid: string, text: string, idempotencyKey?: string): Promise<{ messageId: string }> {
    whatsappJidSchema.parse(toJid);
    return this.call<{ messageId: string }>("/admin/send", { toJid, text, idempotencyKey });
  }
  markRead(chatJid: string, messageId: string): Promise<void> {
    return this.call("/admin/mark-read", { chatJid, messageId }).then(() => undefined);
  }
  logout(owner: string): Promise<void> {
    return this.call("/admin/logout", { owner }).then(() => undefined);
  }
}
