import "./config.ts";
import { HttpAgent } from "@ag-ui/client";
import {
  type AgentsFactory,
  CopilotRuntime,
  createCopilotHonoHandler,
} from "@copilotkit/runtime/v2";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import { ConversationAgent } from "./engine/conversation.ts";
import type { AgentService } from "./engine/service.ts";
import { createJevAdapter, type JevAdapter } from "./jev/adapter.ts";
import type { ThreadProvider } from "./threads/provider.ts";

export function agentConfigured(config: Config) {
  return (
    config.agentBackend === "sample" ||
    (config.agentBackend === "agui"
      ? Boolean(config.agentUrl)
      : Boolean(
          config.model &&
            (process.env.OPENAI_API_KEY ||
              process.env.ANTHROPIC_API_KEY ||
              process.env.GOOGLE_API_KEY),
        ))
  );
}
export function makeRuntime(
  config: Config,
  service: AgentService,
  auth: Auth,
  threads: ThreadProvider,
  agentOwners: WeakMap<object, string>,
) {
  // Built on first use, then shared so live mode reuses one TypeSafe client across requests.
  let jevAdapter: JevAdapter | undefined;
  const sharedJevAdapter = () => (jevAdapter ??= createJevAdapter(config));
  // The runner's run/persist methods receive no request context, so the factory
  // records the owning user on each agent it builds and the lookup reaches the
  // thread provider (PersistentAgentRunner scopes saved threads by owner).
  const agents: AgentsFactory = async ({ request }) => {
    const owner = await auth.owner(request.headers.get("authorization") ?? undefined);
    const agent =
      config.agentBackend === "sample"
        ? new ConversationAgent(config, service, owner, sharedJevAdapter())
        : config.agentBackend === "agui"
          ? new HttpAgent({
              url: config.agentUrl ?? "http://127.0.0.1:1/unconfigured",
              headers: config.agentToken ? { Authorization: `Bearer ${config.agentToken}` } : {},
            })
          : new ConversationAgent(config, service, owner, sharedJevAdapter());
    if (agent instanceof ConversationAgent) agentOwners.set(agent, owner);
    return { default: agent };
  };
  // CopilotRuntime dispatches on this option set: with `intelligence` it builds
  // the Intelligence runtime; with `runner` (and no intelligence) the SSE
  // runtime that serves threads from the local runner itself.
  const runtime =
    threads.backend === "intelligence"
      ? new CopilotRuntime({
          agents,
          intelligence: threads.intelligence,
          // The shared CopilotKit sink carries this tag onto existing PostHog events.
          telemetryProperties: { accessibility_title: "OpenMuse" },
          identifyUser: async (request) => ({
            id: await auth.owner(request.headers.get("authorization") ?? undefined),
            name: "OpenMuse user",
          }),
          generateThreadNames: false,
        })
      : new CopilotRuntime({
          agents,
          runner: threads.runner,
          telemetryProperties: { accessibility_title: "OpenMuse" },
        });
  return createCopilotHonoHandler({ runtime, basePath: "/api/copilotkit" });
}
