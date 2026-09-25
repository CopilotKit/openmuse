import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import type { Config } from "../apps/server/src/config.ts";
import { telegramRoutes } from "../apps/server/src/connectors/telegram/routes.ts";
import { TelegramService } from "../apps/server/src/connectors/telegram/service.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

const TEST_KEY = Buffer.alloc(32, 1).toString("base64");
const TEST_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ";
const OWNER_CHAT_ID = "987654321";

test("connectors / telegram", async (t) => {
  let tempDir: string;
  let db: Store;
  let config: Config;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "telegram-test-"));
    db = await createStore({ dataDir: tempDir });
    config = {
      encryptionKey: TEST_KEY,
    } as unknown as Config;
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await t.test(
    "saves config with valid token, encrypts at rest, and serves metadata only",
    async () => {
      const calls: { url: string; body?: unknown }[] = [];
      const mockFetch = async (
        url: string | URL | Request,
        _init?: RequestInit,
      ): Promise<Response> => {
        const urlStr = url.toString();
        calls.push({ url: urlStr });
        if (urlStr.includes("/getMe")) {
          return new Response(JSON.stringify({ ok: true, result: { username: "TestMuseBot" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };

      const service = new TelegramService(db, config, mockFetch as unknown as typeof fetch);

      const initialStatus = await service.getStatus("test-owner");
      assert.equal(initialStatus.enabled, false);
      assert.equal(initialStatus.running, false);

      const updated = await service.saveConfig("test-owner", {
        botToken: TEST_TOKEN,
        ownerChatId: OWNER_CHAT_ID,
        enabled: false, // keep false so it doesn't background-poll in this test
      });

      assert.equal(updated.enabled, false);
      assert.equal(updated.ownerChatId, OWNER_CHAT_ID);
      assert.equal(updated.botUsername, "TestMuseBot");
      // Ensure plaintext token is never leaked in status
      assert.equal("botToken" in (updated as Record<string, unknown>), false);

      // Verify stored DB record is encrypted
      const stored = await db.get<Record<string, unknown>>(
        "test-owner",
        "telegram-config",
        "default",
      );
      assert.ok(stored);
      assert.ok(stored.botTokenEncrypted);
      assert.notEqual(stored.botTokenEncrypted, TEST_TOKEN);
    },
  );

  await t.test("rejects saveConfig if bot token verification fails", async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    };

    const service = new TelegramService(db, config, mockFetch as unknown as typeof fetch);

    await assert.rejects(
      async () => {
        await service.saveConfig("test-owner", {
          botToken: "invalid-token",
          ownerChatId: OWNER_CHAT_ID,
          enabled: false,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("Failed to verify Telegram bot token"));
        return true;
      },
    );
  });

  await t.test("testConnection sends verification message to ownerChatId", async () => {
    const sentPayloads: unknown[] = [];
    const mockFetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const urlStr = url.toString();
      if (urlStr.includes("/sendMessage")) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        sentPayloads.push(body);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const service = new TelegramService(db, config, mockFetch as unknown as typeof fetch);
    const result = await service.testConnection("test-owner");

    assert.equal(result.ok, true);
    assert.equal(sentPayloads.length, 1);
    const payload = sentPayloads[0] as { chat_id: string; text: string };
    assert.equal(payload.chat_id, OWNER_CHAT_ID);
    assert.ok(payload.text.includes("OpenMuse"));
  });

  await t.test("telegramRoutes expose status and require admin for config", async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ ok: true, result: { username: "TestMuseBot" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const service = new TelegramService(db, config, mockFetch as unknown as typeof fetch);
    const app = telegramRoutes(service);

    // GET /status is open
    const statusRes = await app.request("/status", { headers: { "x-owner": "test-owner" } });
    assert.equal(statusRes.status, 200);
    const statusJson = (await statusRes.json()) as { ownerChatId: string };
    assert.equal(statusJson.ownerChatId, OWNER_CHAT_ID);

    // POST /config with user role is rejected (403)
    const forbiddenRes = await app.request(
      "/config",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          botToken: TEST_TOKEN,
          ownerChatId: OWNER_CHAT_ID,
          enabled: true,
        }),
      },
      {
        role: "user",
        owner: "test-owner",
      },
    );
    assert.equal(forbiddenRes.status, 403);
  });
});
