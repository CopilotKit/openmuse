# OpenBot integration boundary

Inspected September 15, 2026: `CopilotKit/OpenBot` `main` at [`a96d88c6fb75385842529d7db7d463f4a8c4a86e`](https://github.com/CopilotKit/OpenBot/tree/a96d88c6fb75385842529d7db7d463f4a8c4a86e). This is a source inspection, not a running integration. OpenBot is an alpha template whose workspaces are private; depend on public CopilotKit/AG-UI protocols and an HTTP adapter, not OpenBot package imports. [Repository](https://github.com/CopilotKit/OpenBot/blob/a96d88c6fb75385842529d7db7d463f4a8c4a86e/README.md)

## Recommended OpenMuse configuration

These are proposed **OpenMuse** settings, not upstream environment variables:

```dotenv
OPENBOT_ENABLED=false
OPENBOT_BASE_URL=http://127.0.0.1:3001
OPENBOT_RUNTIME_PATH=/api/copilotkit
OPENBOT_AGENT_ID=
```

Choose the agent ID from authenticated `GET /api/agents` when connecting. Resolve the URL on OpenMuse's server; phone loopback is not the server. Disabled or unreachable must report unavailable, never simulate a successful action. An eventual authenticated transport must preserve each person's OpenBot identity; a shared administrator session is unsuitable.

## Verified runtime and authentication

The upstream web provider uses `runtimeUrl="/api/copilotkit"`, `credentials="include"`, and no `publicApiKey`. Better Auth session cookies identify users; API routes also check roles and Bot access. `/api/copilotkit/info` can expose diagnostics/public agents anonymously, but runs and history resolve an authorized user. `OPENBOT_SINGLE_USER=true` bypasses sign-in as one administrator and is intended for local use. Native cookie storage, OAuth return links and cross-origin behavior still require integration work. Keep Intelligence keys, managed-agent tokens and computer tokens server-side. [Provider](https://github.com/CopilotKit/OpenBot/blob/a96d88c6fb75385842529d7db7d463f4a8c4a86e/app/src/lib/copilot/provider.tsx), [identity resolution](https://github.com/CopilotKit/OpenBot/blob/a96d88c6fb75385842529d7db7d463f4a8c4a86e/server/src/index.ts#L117), [auth configuration](https://github.com/CopilotKit/OpenBot/blob/a96d88c6fb75385842529d7db7d463f4a8c4a86e/.env.example)

OpenBot pins `@copilotkit/runtime` **1.70.1** and always configures Intelligence. Its runtime routes were also checked in that published package:

| Operation | Exact route |
| --- | --- |
| Runtime discovery | `GET /api/copilotkit/info` |
| Run | `POST /api/copilotkit/agent/:agentId/run` with AG-UI `RunAgentInput` |
| Reconnect | `POST /api/copilotkit/agent/:agentId/connect` with `RunAgentInput` |
| Stop | `POST /api/copilotkit/agent/:agentId/stop/:threadId` |
| History | `GET /api/copilotkit/threads/:threadId/messages?agentId=:agentId` |

**Runtime run responses are Intelligence connection metadata, not raw SSE.** Use a compatible public CopilotKit client for transport. Separately, the supplied Bot service accepts `POST http://localhost:4200/ag-ui` with `RunAgentInput`, streams AG-UI SSE, and requires `x-openbot-agent-token: <MANAGED_AGENT_TOKEN>`. The LangGraph service uses port 4201. Connecting directly to that Bot omits OpenBot's runtime orchestration. [Runtime mount](https://github.com/CopilotKit/OpenBot/blob/a96d88c6fb75385842529d7db7d463f4a8c4a86e/server/src/copilot.ts#L2054), [published runtime source](https://unpkg.com/@copilotkit/runtime@1.70.1/dist/v2/runtime/core/fetch-router.mjs), [run response](https://unpkg.com/@copilotkit/runtime@1.70.1/dist/v2/runtime/handlers/intelligence/run.mjs), [Bot endpoint](https://github.com/CopilotKit/OpenBot/blob/a96d88c6fb75385842529d7db7d463f4a8c4a86e/agent-bot/src/index.ts)

## Product API mapping

All paths below are relative to `OPENBOT_BASE_URL`; encode path IDs.

| OpenMuse capability | OpenBot request |
| --- | --- |
| Start conversation | `POST /api/channels` `{agentIds:[id]}` → `{channel:{id,agentIds,threadId,...}}` |
| Browser status/read/preview | `GET /api/computers/:botId/status`, `/read`, `/screenshot` |
| Live screen | WebSocket `/api/computers/:botId/stream`, session and Bot-access checked |
| Navigate | `POST /api/computers/:botId/navigate` `{url,toolCallId?}` |
| Inspect controls | `POST /api/computers/:botId/snapshot` → `{snapshotId,elements,...}` |
| Click/type | `POST .../click` `{ref,snapshotId}`; `POST .../type` adds `{text,submit?}` |
| Key/scroll | `POST .../key` `{key,ref?,snapshotId?}`; `POST .../scroll` `{deltaY?}` |
| Workspace files | `POST .../files/list` `{path?}`; `/files/read` `{path}`; `/files/write` `{path,contents,append?}` |
| Shell | `POST .../exec` `{command,timeoutMs?}`; timeout 1,000–600,000 ms |
| Human handover | `POST .../control/request` `{reason}`; `/control/take`; `/control/release` |
| Conversation upload | `POST /api/channels/:channelId/attachments`, multipart `file`, `uploadGroup` → `{id,name,mimeType,sizeBytes}` |
| Attachment download | `GET /api/attachments/:id` |

Here `...` means `/api/computers/:botId`. [Computer routes](https://github.com/CopilotKit/OpenBot/blob/a96d88c6fb75385842529d7db7d463f4a8c4a86e/server/src/computer/routes.ts), [channels](https://github.com/CopilotKit/OpenBot/blob/a96d88c6fb75385842529d7db7d463f4a8c4a86e/server/src/channels/routes.ts), [uploads](https://github.com/CopilotKit/OpenBot/blob/a96d88c6fb75385842529d7db7d463f4a8c4a86e/server/src/channels/attachments.ts)

## Adapter and action boundaries

An OpenMuse-owned [OpenBotAdapter](../packages/backends/src/openbot.ts) now exposes capability discovery, conversation creation, browser status/snapshots/navigation and control handover through an injected authenticated transport. It is disabled by default and has 13 contract tests; it is not connected to a deployment. Keep channel ID, thread ID, agent ID, Bot ID and action/proposal ID distinct. Computers belong to Bots, not individual chat sessions.

Implemented transport seam (the host supplies authenticated requests):

```ts
interface OpenBotTransport {
  runtimeUrl: string;
  request(path: string, init?: RequestInit): Promise<Response>;
}
```

The adapter's `runtime()` returns an Intelligence descriptor for a compatible CopilotKit client; it is not a raw SSE URL. `probe`, `createConversation`, `computerStatus`, `snapshot`, `navigate` and control methods validate responses and surface refusals. Cancellation is passed through AbortSignal; ambiguous mutations are marked as uncertain and are not retried. Workspace text-file operations and full browser interaction mapping remain extensions.

Navigation, browser actions, file operations and shell commands must use the server gateway, which checks policy and records decisions before acting. Never call computer port 4100 or supervisor endpoints from mobile. Snapshot refs are opaque and require their original `snapshotId`. Human control refuses Bot actions. OpenMuse's durable approval record remains necessary for its reviewed external writes; OpenBot policy decisions do not implement that approval lifecycle. [Architecture](https://github.com/CopilotKit/OpenBot/blob/a96d88c6fb75385842529d7db7d463f4a8c4a86e/reference/architecture.md)

For a later custom AG-UI agent, preserve opaque `forwardedProps.openbotRun` and distinguish `openbotDeploymentTools` from frontend tools. Server-side granted tools call `POST /api/agent-tools/call` with `{name,args,run}` and `x-openbot-agent-token`; OpenBot verifies token and signed run together. These are agent credentials, not mobile login credentials. [Callback implementation](https://github.com/CopilotKit/OpenBot/blob/a96d88c6fb75385842529d7db7d463f4a8c4a86e/server/src/app.ts#L1265)

## Remaining work

No deployment, session bridge, native transport or live round trip is connected. Next, test sign-in, run/reconnect/stop, browser policy refusal and handover against a pinned deployment. The [roadmap](../ROADMAP.md) also requires mapping scheduled routines and durable task execution before extending the computer infrastructure. Keep Gmail/Calendar integrations in OpenMuse: upstream's catalogue currently ships Drive and Notion. Keep PDF processing in OpenMuse: channel uploads accept selected images and text formats, and reject `application/pdf` with 415. Upstream workspace files and desktop host-folder grants are separate capabilities; neither supplies a native PDF workflow. [Catalogue](https://github.com/CopilotKit/OpenBot/blob/a96d88c6fb75385842529d7db7d463f4a8c4a86e/server/src/plugins/catalogue.ts), [accepted formats](https://github.com/CopilotKit/OpenBot/blob/a96d88c6fb75385842529d7db7d463f4a8c4a86e/shared/attachments.ts#L104)
