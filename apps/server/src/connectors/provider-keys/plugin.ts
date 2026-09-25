/**
 * Thin plugin wrapper for the provider-keys connector. No service/route logic
 * is rewritten here — the existing modules are only constructed and registered
 * with the plugin host.
 *
 * The connector contributes no agent tools: keys are selected via the
 * dashboard UI (or POST /api/provider-keys/:id/select), and the engine's
 * applyProviderSelection hot-applies the selection to the running agent.
 */
import type { PluginActivation, PluginContext } from "../../plugins/plugin-api.ts";
import { providerKeyRoutes } from "./routes.ts";
import { ProviderKeyService } from "./service.ts";

export async function activate(ctx: PluginContext): Promise<PluginActivation> {
  const service = new ProviderKeyService(ctx.db, ctx.config);
  ctx.registerDataBinding("provider_count", async (owner) => ({
    count: (await service.list(owner)).length,
  }));
  return { service, routes: providerKeyRoutes(service) };
}
