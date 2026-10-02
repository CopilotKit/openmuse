# MCP connections

OpenMuse can connect to multiple MCP servers from **Apps → MCP connections**. It supports Streamable HTTP, legacy SSE, and local stdio commands. A model-backed agent can list connections and call only tools that the MCP server marks read-only and the owner has enabled. Other tools are visible but unavailable to the agent. Tool calls are not automatically retried.

Set `TOKEN_ENCRYPTION_KEY` to 32 random bytes encoded as base64 and restart the API. Connection settings, custom headers, local environment values, OAuth registrations, and tokens are encrypted in the local database. The app only receives the connection name, sanitized endpoint, status, tool descriptions, and enabled tool names. Keep `.env` private and back up the encryption key with the database. Losing the key means reconnecting servers.

## Add a server

1. Open **Apps → MCP connections**.
2. Enter a name and choose **HTTP**, **SSE**, or **Local command**. Enter the MCP URL or executable. HTTP headers and local environment values are optional JSON objects. Local command arguments are a JSON array.
3. Select **Add and connect**. For OAuth servers, finish sign-in in the browser, then refresh the list.
4. Review the discovered tools and enable only the read-only tools you want the agent to use.

Enabling a local command server grants that program local command execution as the server user, with a small inherited environment, every time the agent calls one of its tools. Add only programs you trust. Remote server URLs and custom headers are stored server-side. MCP output may contain instructions from third parties; the agent must treat them as data.

Read-only labels come from each remote MCP server's tool annotations and are advisory: OpenMuse requires the owner to enable a tool, but it cannot prove that a third-party server's implementation has no side effects. Connect trusted servers and prefer HTTPS when sending credentials to remote endpoints.

Custom headers are sent only to the configured server origin. They are never attached to OAuth discovery documents under `/.well-known/`, to a separate authorization server, or to a request that would follow a redirect: a remote server that redirects an MCP request is refused, and the error names the address to configure instead.

## Hosted OAuth and ElevenLabs

[ElevenLabs' hosted MCP server](https://elevenlabs.io/docs/eleven-agents/operate/hosted-mcp) uses OAuth and exposes agent-management and text-to-speech tools. Select **Use ElevenLabs hosted MCP** to fill its global URL. Isolated EU, India, and Singapore workspaces use their region-specific URL instead.

Some hosted MCP servers, including ElevenLabs, require a publicly reachable HTTPS Client ID Metadata document. Set `PUBLIC_API_URL` to the public HTTPS address that forwards to this OpenMuse API. OpenMuse serves the document at `${PUBLIC_API_URL}/api/mcp/client-metadata` and handles the redirect at `${PUBLIC_API_URL}/api/mcp/callback`. You may set `MCP_CLIENT_METADATA_URL` to a different public HTTPS document URL if it serves the same client metadata. The remote authorization server must be able to fetch that URL. A loopback-only `PUBLIC_API_URL` cannot complete this OAuth flow. Protect any publicly reachable OpenMuse API with live-mode authentication and appropriate network controls before exposing it.

ElevenLabs' hosted MCP manages ElevenLabs agents and can generate speech. It does not by itself give OpenMuse a phone number or inbound calling. A separate voice and telephony integration is needed for that product goal.
