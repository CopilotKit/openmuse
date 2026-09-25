import { decryptSecret, encryptSecret } from "../../../../../packages/integrations/src/vault.ts";
import type { Config } from "../../config.ts";
import type { Store } from "../../db.ts";
import { loadSoul } from "../../engine/soul.ts";
import { AppError } from "../../errors.ts";
import { chatComplete } from "../email/ai.ts";
import type { TelegramConfigInput, TelegramStatus } from "./schemas.ts";

const KIND = "telegram-config";
const CONFIG_ID = "default";

interface StoredTelegramConfig {
  id: string;
  botTokenEncrypted: string;
  ownerChatId: string;
  enabled: boolean;
  botUsername?: string;
  updatedAt: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; username?: string };
    chat: { id: number | string; type: string };
    date: number;
    text?: string;
  };
}

export class TelegramService {
  private abortController: AbortController | null = null;
  private isRunning = false;
  private lastError: string | null = null;
  private lastSeenAt: string | null = null;
  private cachedUsername: string | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly db: Store,
    private readonly config: Config,
    customFetch?: typeof fetch,
  ) {
    this.fetchImpl = customFetch ?? fetch;
  }

  private requireKey(): string {
    if (!this.config.encryptionKey) {
      throw new AppError("TOKEN_ENCRYPTION_KEY is not configured on the server", 503);
    }
    return this.config.encryptionKey;
  }

  private async getStored(owner: string): Promise<StoredTelegramConfig | null> {
    return await this.db.get<StoredTelegramConfig>(owner, KIND, CONFIG_ID);
  }

  async getStatus(owner: string): Promise<TelegramStatus> {
    const stored = await this.getStored(owner);
    if (!stored) {
      return {
        enabled: false,
        running: false,
      };
    }
    return {
      enabled: stored.enabled,
      running: this.isRunning,
      ownerChatId: stored.ownerChatId,
      botUsername: this.cachedUsername ?? stored.botUsername,
      lastSeenAt: this.lastSeenAt ?? undefined,
      error: this.lastError ?? undefined,
    };
  }

  async saveConfig(owner: string, input: TelegramConfigInput): Promise<TelegramStatus> {
    const key = this.requireKey();
    const token = input.botToken.trim();
    const ownerChatId = input.ownerChatId.trim();

    // Validate the token by querying Telegram getMe
    let botUsername: string | undefined;
    try {
      const meRes = await this.fetchImpl(`https://api.telegram.org/bot${token}/getMe`);
      const meJson = (await meRes.json()) as {
        ok: boolean;
        result?: { username?: string };
        description?: string;
      };
      if (!meJson.ok || !meJson.result?.username) {
        throw new Error(meJson.description || "Invalid bot token");
      }
      botUsername = meJson.result.username;
      this.cachedUsername = botUsername;
    } catch (e) {
      throw new AppError(
        `Failed to verify Telegram bot token: ${e instanceof Error ? e.message : String(e)}`,
        400,
      );
    }

    const stored: StoredTelegramConfig = {
      id: CONFIG_ID,
      botTokenEncrypted: encryptSecret(token, key),
      ownerChatId,
      enabled: input.enabled,
      botUsername,
      updatedAt: new Date().toISOString(),
    };

    await this.db.put(owner, KIND, stored);

    if (stored.enabled) {
      this.startPolling(owner);
    } else {
      this.stopPolling();
    }

    return this.getStatus(owner);
  }

  async testConnection(
    owner: string,
  ): Promise<{ ok: boolean; message: string; botUsername?: string }> {
    const stored = await this.getStored(owner);
    if (!stored) {
      throw new AppError("Telegram connector is not configured", 400);
    }
    const token = decryptSecret(stored.botTokenEncrypted, this.requireKey());
    const res = await this.sendMessageWithToken(
      token,
      stored.ownerChatId,
      "👋 Hello from OpenMuse! Telegram integration is connected and healthy.",
    );
    return {
      ok: res.ok,
      message: res.ok ? "Test message sent successfully" : (res.error ?? "Failed to send message"),
      botUsername: stored.botUsername,
    };
  }

  async sendMessage(owner: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const stored = await this.getStored(owner);
    if (!stored) {
      return { ok: false, error: "Telegram is not configured" };
    }
    const token = decryptSecret(stored.botTokenEncrypted, this.requireKey());
    return await this.sendMessageWithToken(token, stored.ownerChatId, text);
  }

  private async sendMessageWithToken(
    token: string,
    chatId: string,
    text: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
        }),
      });
      const data = (await res.json()) as { ok: boolean; description?: string };
      if (!data.ok) {
        return { ok: false, error: data.description || "Telegram API returned not ok" };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  startPolling(owner: string): void {
    if (this.isRunning) return;
    this.stopPolling();

    this.abortController = new AbortController();
    this.isRunning = true;
    this.lastError = null;

    void this.pollLoop(owner, this.abortController.signal);
  }

  stopPolling(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.isRunning = false;
  }

  private async pollLoop(owner: string, signal: AbortSignal): Promise<void> {
    let offset = 0;

    while (!signal.aborted) {
      try {
        const stored = await this.getStored(owner);
        if (!stored?.enabled) {
          this.isRunning = false;
          break;
        }

        const token = decryptSecret(stored.botTokenEncrypted, this.requireKey());
        const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=20`;

        const res = await this.fetchImpl(url, { signal });
        if (!res.ok) {
          this.lastError = `Telegram poll returned HTTP ${res.status}`;
          await this.delay(5000, signal);
          continue;
        }

        const data = (await res.json()) as {
          ok: boolean;
          result?: TelegramUpdate[];
          description?: string;
        };
        if (!data.ok || !data.result) {
          this.lastError = data.description || "Invalid getUpdates response";
          await this.delay(5000, signal);
          continue;
        }

        for (const update of data.result) {
          offset = update.update_id + 1;
          if (update.message) {
            await this.handleMessage(owner, token, stored.ownerChatId, update.message);
          }
        }
      } catch (e) {
        if (signal.aborted) break;
        this.lastError = e instanceof Error ? e.message : String(e);
        await this.delay(5000, signal);
      }
    }
    this.isRunning = false;
  }

  private async handleMessage(
    _owner: string,
    token: string,
    allowedChatId: string,
    msg: NonNullable<TelegramUpdate["message"]>,
  ): Promise<void> {
    const chatId = String(msg.chat.id);
    if (chatId !== allowedChatId) {
      // Unauthorized user messaging the bot
      await this.sendMessageWithToken(token, chatId, "Unauthorized: this OpenMuse bot is private.");
      return;
    }

    this.lastSeenAt = new Date().toISOString();
    const text = (msg.text || "").trim();
    if (!text) return;

    if (text === "/start" || text === "/help") {
      await this.sendMessageWithToken(
        token,
        chatId,
        "👋 Hello! I am Muse, your OpenMuse personal AI assistant.\n\nSend me any message, question, or request and I will help you!",
      );
      return;
    }

    if (text === "/status") {
      await this.sendMessageWithToken(
        token,
        chatId,
        "✅ Muse is online, healthy, and connected to your server.",
      );
      return;
    }

    // Process general prompt using the agent's core chatComplete with Soul prompt
    try {
      const soul = loadSoul();
      const reply = await chatComplete(soul, text);
      await this.sendMessageWithToken(token, chatId, reply);
    } catch (e) {
      await this.sendMessageWithToken(
        token,
        chatId,
        `⚠️ Error generating reply: ${e instanceof Error ? e.message : "AI service unavailable"}`,
      );
    }
  }

  private async delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
