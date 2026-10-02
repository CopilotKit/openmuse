import { randomBytes, randomUUID } from "node:crypto";
import {
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../../../packages/integrations/src/vault.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

const name = z.string().trim().min(1).max(80);
const text = z.string().max(4096);
export const mcpServerInput = z.discriminatedUnion("transport", [
  z.object({
    name,
    transport: z.literal("http"),
    url: z.url().max(2048),
    headers: z.record(z.string(), text).optional(),
  }),
  z.object({
    name,
    transport: z.literal("sse"),
    url: z.url().max(2048),
    headers: z.record(z.string(), text).optional(),
  }),
  z.object({
    name,
    transport: z.literal("stdio"),
    command: z.string().trim().min(1).max(2048),
    args: z.array(text).max(30).default([]),
    env: z.record(z.string(), text).optional(),
    cwd: z.string().max(2048).optional(),
  }),
]);
export type McpServerInput = z.infer<typeof mcpServerInput>;

export interface McpToolInfo {
  name: string;
  description: string;
  readOnly: boolean;
}
export interface McpServer {
  id: string;
  name: string;
  transport: McpServerInput["transport"];
  endpoint: string;
  status: "disconnected" | "connected" | "needs_auth" | "error";
  tools: McpToolInfo[];
  enabledTools: string[];
  error?: string;
  updatedAt: string;
}
interface McpSecret {
  input: McpServerInput;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
}
interface PendingOAuth {
  id: string;
  owner: string;
  serverId: string;
  expiresAt: number;
}

export class McpService {
  constructor(
    private readonly db: Store,
    private readonly config: Config,
  ) {}

  private key() {
    if (!this.config.encryptionKey)
      throw new AppError("Set TOKEN_ENCRYPTION_KEY before adding MCP servers", 503);
    return this.config.encryptionKey;
  }
  private async secret(owner: string, id: string): Promise<McpSecret> {
    const stored = await this.db.get<{ secret: string }>(owner, "mcp-secrets", id);
    if (!stored) throw new AppError("MCP server not found", 404);
    return JSON.parse(decryptSecret(stored.secret, this.key())) as McpSecret;
  }
  private async saveSecret(owner: string, id: string, value: McpSecret) {
    await this.db.put(owner, "mcp-secrets", {
      id,
      secret: encryptSecret(JSON.stringify(value), this.key()),
    });
  }
  async list(owner: string) {
    return this.db.list<McpServer>(owner, "mcp-servers");
  }
  private async server(owner: string, id: string) {
    const server = await this.db.get<McpServer>(owner, "mcp-servers", id);
    if (!server) throw new AppError("MCP server not found", 404);
    return server;
  }
  async add(owner: string, raw: unknown) {
    const input = mcpServerInput.parse(raw);
    if (input.transport !== "stdio") {
      const url = new URL(input.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new AppError("MCP URL must be HTTP or HTTPS without embedded credentials", 422);
    }
    const id = randomUUID();
    const endpoint =
      input.transport === "stdio"
        ? input.command
        : new URL(input.url).origin + new URL(input.url).pathname;
    const server: McpServer = {
      id,
      name: input.name,
      transport: input.transport,
      endpoint,
      status: "disconnected",
      tools: [],
      enabledTools: [],
      updatedAt: new Date().toISOString(),
    };
    await this.saveSecret(owner, id, { input });
    await this.db.put(owner, "mcp-servers", server);
    return server;
  }
  async remove(owner: string, id: string) {
    await this.server(owner, id);
    await this.db.remove(owner, "mcp-servers", id);
    await this.db.remove(owner, "mcp-secrets", id);
    return { removed: true };
  }
  async enable(owner: string, id: string, raw: unknown) {
    const { tools } = z.object({ tools: z.array(z.string()).max(100) }).parse(raw);
    const server = await this.server(owner, id);
    const readOnly = new Set(server.tools.filter((tool) => tool.readOnly).map((tool) => tool.name));
    if (tools.some((tool) => !readOnly.has(tool)))
      throw new AppError("Only MCP tools marked read-only can run automatically", 422);
    const updated = {
      ...server,
      enabledTools: [...new Set(tools)],
      updatedAt: new Date().toISOString(),
    };
    return this.db.put(owner, "mcp-servers", updated);
  }

  private async provider(
    owner: string,
    id: string,
    state: string | undefined,
    redirect: (url: URL) => void,
  ): Promise<OAuthClientProvider> {
    const save = async (patch: Partial<McpSecret>) => {
      // SDK callbacks for one connection run sequentially. Reload to preserve tokens and registration.
      await this.saveSecret(owner, id, { ...(await this.secret(owner, id)), ...patch });
    };
    const redirectUrl = `${this.config.publicUrl}/api/mcp/callback`;
    const clientMetadata: OAuthClientMetadata = {
      client_name: "OpenMuse",
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    return {
      redirectUrl,
      clientMetadataUrl: this.config.mcpClientMetadataUrl,
      clientMetadata,
      validateResourceURL: async (serverUrl, resource) => {
        if (!resource) return new URL(serverUrl);
        const expected = new URL(serverUrl),
          actual = new URL(resource);
        const sameResource =
          actual.origin === expected.origin && actual.pathname === expected.pathname;
        const elevenLabsGlobal =
          expected.origin === "https://api.elevenlabs.io" &&
          expected.pathname === "/v1/mcp" &&
          actual.origin === "https://api.us.elevenlabs.io" &&
          actual.pathname === "/v1/mcp";
        if (!sameResource && !elevenLabsGlobal)
          throw new AppError("MCP OAuth resource does not match the configured server", 400);
        return actual;
      },
      state: () => state ?? randomBytes(32).toString("base64url"),
      clientInformation: async () => (await this.secret(owner, id)).client,
      saveClientInformation: async (client) => save({ client }),
      tokens: async () => (await this.secret(owner, id)).tokens,
      saveTokens: async (tokens) => save({ tokens }),
      redirectToAuthorization: redirect,
      saveCodeVerifier: async (verifier) => save({ verifier }),
      codeVerifier: async () => {
        const verifier = (await this.secret(owner, id)).verifier;
        if (!verifier) throw new AppError("MCP sign-in expired. Connect again.", 400);
        return verifier;
      },
    };
  }

  private async client(
    owner: string,
    id: string,
    state?: string,
    redirect: (url: URL) => void = () => {
      throw new AppError("MCP authorization expired. Reconnect in Apps.", 401);
    },
  ) {
    const { input } = await this.secret(owner, id);
    const client = new Client({ name: "openmuse", version: "0.1.0" });
    if (input.transport === "stdio") {
      const transport = new StdioClientTransport({
        command: input.command,
        args: input.args,
        env: { ...getDefaultEnvironment(), ...input.env },
        cwd: input.cwd,
        stderr: "pipe",
      });
      return { client, transport };
    }
    // Configured headers are credentials for the MCP server only. The SDK reuses this fetch
    // for OAuth discovery, registration and token requests, so decide per request URL:
    // only the configured origin gets them, never a /.well-known/ discovery document, and a
    // request that carries them is not allowed to follow a redirect anywhere.
    const origin = new URL(input.url).origin;
    const headers = input.headers ?? {};
    const fetchWithHeaders: typeof fetch = async (url, init) => {
      const target = new URL(url instanceof Request ? url.url : url);
      if (target.origin !== origin || target.pathname.startsWith("/.well-known/"))
        return fetch(url, init);
      const merged = new Headers(headers);
      new Headers(init?.headers).forEach((value, key) => {
        merged.set(key, value);
      });
      const response = await fetch(url, { ...init, headers: merged, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new AppError(
          `MCP server redirected to ${response.headers.get("location") ?? "another address"}. Configure that URL directly.`,
          502,
        );
      }
      return response;
    };
    const provider = await this.provider(owner, id, state, redirect);
    const transport =
      input.transport === "sse"
        ? new SSEClientTransport(new URL(input.url), {
            authProvider: provider,
            fetch: fetchWithHeaders,
          })
        : new StreamableHTTPClientTransport(new URL(input.url), {
            authProvider: provider,
            fetch: fetchWithHeaders,
          });
    return { client, transport };
  }
  private async discover(owner: string, id: string, client: Client) {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const tool of page.tools) {
        tools.push({
          name: tool.name,
          description: (tool.description ?? "").slice(0, 1000),
          readOnly: tool.annotations?.readOnlyHint === true,
        });
      }
      cursor = page.nextCursor;
    } while (cursor && tools.length < 500);
    const server = await this.server(owner, id);
    return this.db.put(owner, "mcp-servers", {
      ...server,
      status: "connected" as const,
      tools,
      enabledTools: server.enabledTools.filter((enabled) =>
        tools.some((tool) => tool.name === enabled && tool.readOnly),
      ),
      error: undefined,
      updatedAt: new Date().toISOString(),
    });
  }
  async connect(owner: string, id: string) {
    await this.server(owner, id);
    const state = randomBytes(32).toString("base64url");
    let authorizationUrl: string | undefined;
    const { client, transport } = await this.client(owner, id, state, (url) => {
      authorizationUrl = url.toString();
    });
    try {
      await client.connect(transport);
      return { server: await this.discover(owner, id, client) };
    } catch (error) {
      if (error instanceof UnauthorizedError && authorizationUrl) {
        await this.db.put("system", "mcp-oauth", {
          id: state,
          owner,
          serverId: id,
          expiresAt: Date.now() + 10 * 60 * 1000,
        } satisfies PendingOAuth);
        const server = await this.server(owner, id);
        await this.db.put(owner, "mcp-servers", {
          ...server,
          status: "needs_auth",
          updatedAt: new Date().toISOString(),
        });
        return { authorizationUrl };
      }
      if (
        error instanceof Error &&
        error.message.includes("does not support dynamic client registration")
      ) {
        const server = await this.server(owner, id);
        await this.db.put(owner, "mcp-servers", {
          ...server,
          status: "needs_auth",
          error: "Set up a secure public address to finish sign-in",
          updatedAt: new Date().toISOString(),
        });
        throw new AppError(
          "This MCP server requires hosted OAuth client metadata. Set a public HTTPS PUBLIC_API_URL so it can read /api/mcp/client-metadata, then connect again.",
          503,
        );
      }
      throw error;
    } finally {
      await client.close().catch(() => undefined);
    }
  }
  async callback(state: string, code: string) {
    const pending = await this.db.take<PendingOAuth>("system", "mcp-oauth", state);
    if (!pending || pending.expiresAt < Date.now())
      throw new AppError("MCP sign-in expired. Connect again.", 400);
    const { transport } = await this.client(pending.owner, pending.serverId, state);
    if (
      !(
        transport instanceof StreamableHTTPClientTransport ||
        transport instanceof SSEClientTransport
      )
    )
      throw new AppError("MCP sign-in is only supported for remote servers", 400);
    try {
      await transport.finishAuth(code);
    } finally {
      await transport.close().catch(() => undefined);
    }
    // The authorization code is consumed above. Reopen the transport with its saved tokens
    // for MCP initialization and tool discovery, rather than reusing the OAuth transport.
    const connected = await this.connect(pending.owner, pending.serverId);
    if (!connected.server)
      throw new AppError(
        "MCP authorization finished, but the server still needs sign-in. Reconnect it in Apps.",
        502,
      );
    return connected.server;
  }
  async call(owner: string, id: string, name: string, args: Record<string, unknown>) {
    const server = await this.server(owner, id);
    if (
      !server.enabledTools.includes(name) ||
      !server.tools.some((tool) => tool.name === name && tool.readOnly)
    )
      throw new AppError("This MCP tool is not enabled for automatic use", 403);
    const { client, transport } = await this.client(owner, id);
    try {
      await client.connect(transport);
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: 30000,
      });
      console.info(`[OpenMuse] MCP tool completed ${JSON.stringify({ serverId: id, tool: name })}`);
      const serialized = JSON.stringify(result);
      return serialized.length > 30000
        ? { truncated: true, result: serialized.slice(0, 30000) }
        : result;
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}
