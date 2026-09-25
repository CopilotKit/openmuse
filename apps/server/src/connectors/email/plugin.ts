/**
 * Thin plugin wrapper for the email connector. No service/route logic is
 * rewritten here — the existing modules are only constructed and registered
 * with the plugin host.
 *
 * Email contributes no direct agent tools: the chat tools search_mail and
 * read_mail_thread route through WorkspaceService, which falls back to the
 * default IMAP account when Google is not connected
 * (toolMetadata providedBy "workspace-fallback").
 */
import type { PluginActivation, PluginContext } from "../../plugins/plugin-api.ts";
import { emailRoutes } from "./routes.ts";
import { EmailService } from "./service.ts";

export async function activate(ctx: PluginContext): Promise<PluginActivation> {
  const service = new EmailService(ctx.db, ctx.config);
  ctx.registerDataBinding("account_count", async (owner) => ({
    count: (await service.listAccounts(owner)).length,
  }));
  return { service, routes: emailRoutes(service) };
}
