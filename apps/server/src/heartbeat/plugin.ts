import type { PluginActivation, PluginContext } from "../plugins/plugin-api.ts";
import { WorkspaceService } from "../workspace.ts";
import { heartbeatRoutes } from "./routes.ts";
import { HeartbeatService } from "./service.ts";
import { createAutomationTools } from "./tools.ts";

export async function activate(ctx: PluginContext): Promise<PluginActivation> {
  const workspace = new WorkspaceService(
    ctx.db,
    ctx.config,
    ctx.bindings.files as any,
    ctx.bindings.google as any,
  );
  const service = new HeartbeatService(workspace);

  const tools = createAutomationTools(service);
  const toolRecord: Record<string, any> = {};
  for (const t of tools) {
    toolRecord[t.name] = {
      chat: (_owner: string) => [t as any],
      worker: (_host: any) => t as any,
    };
  }
  ctx.registerTools(toolRecord);

  // Start heartbeat runner on activation
  service.start();

  return { service, routes: heartbeatRoutes(service) };
}
