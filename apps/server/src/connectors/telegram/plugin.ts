import type { PluginActivation, PluginContext, WorkerToolHost } from "../../plugins/plugin-api.ts";
import { telegramRoutes } from "./routes.ts";
import { TelegramService } from "./service.ts";
import { telegramSendMessageChatTool, telegramSendMessageWorkerTool } from "./tools.ts";

export async function activate(ctx: PluginContext): Promise<PluginActivation> {
  const service = new TelegramService(ctx.db, ctx.config);

  ctx.registerTools({
    telegram_send_message: {
      chat: (owner: string) => [telegramSendMessageChatTool(service, owner)],
      worker: (host: WorkerToolHost) => telegramSendMessageWorkerTool(service, host),
    },
  });

  ctx.registerDataBinding("telegram_status", async (owner) => service.getStatus(owner));

  // If enabled on startup, kick off polling loop
  void service.getStatus("default").then((status) => {
    if (status.enabled) {
      service.startPolling("default");
    }
  });

  return { service, routes: telegramRoutes(service) };
}
