/**
 * Thin plugin wrapper for the WhatsApp connector. No service/route/tool
 * logic is rewritten here — the existing modules are only constructed and
 * registered with the plugin host.
 *
 * The plugin's service uses HttpSidecarBridge: the API process never holds
 * a Baileys socket (two sockets would kick each other off WhatsApp). The
 * real socket lives in the sidecar process (whatsapp-entry.ts), which
 * constructs its own WhatsAppService with BaileysBridge directly.
 */
import type { PluginActivation, PluginContext, WorkerToolHost } from "../../plugins/plugin-api.ts";
import { HttpSidecarBridge } from "./bridge.ts";
import { whatsappRoutes } from "./routes.ts";
import { WhatsAppService } from "./service.ts";
import {
  whatsappSearchRecentChatTool,
  whatsappSearchRecentWorkerTool,
  whatsappSendChatTool,
  whatsappSendWorkerTool,
} from "./tools.ts";

export async function activate(ctx: PluginContext): Promise<PluginActivation> {
  const bridge = new HttpSidecarBridge(
    ctx.config.whatsappSidecarUrl,
    ctx.config.whatsappSidecarToken,
  );
  const service = new WhatsAppService(ctx.db, ctx.config, bridge);
  ctx.registerTools({
    whatsapp_send: {
      chat: (owner: string) => [whatsappSendChatTool(service, owner)],
      worker: (host: WorkerToolHost) => whatsappSendWorkerTool(service, host),
    },
    whatsapp_search_recent: {
      chat: (owner: string) => [whatsappSearchRecentChatTool(service, owner)],
      worker: (host: WorkerToolHost) => whatsappSearchRecentWorkerTool(service, host),
    },
  });
  ctx.registerDataBinding("pairing_status", async (owner) => service.getStatus(owner));
  return { service, routes: whatsappRoutes(service) };
}
