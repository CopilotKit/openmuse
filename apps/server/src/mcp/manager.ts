import { z } from "zod";
import { McpClient } from "./client.ts";
import type { McpServerConfig, McpToolSchema } from "./types.ts";

export class McpManager {
  private clients = new Map<string, McpClient>();
  private tools = new Map<string, { serverId: string; schema: McpToolSchema }>();

  constructor(initialConfigs: McpServerConfig[] = []) {
    for (const cfg of initialConfigs) {
      this.addServer(cfg);
    }
  }

  public getServers(): McpServerConfig[] {
    return Array.from(this.clients.values()).map((c) => c.config);
  }

  public addServer(config: McpServerConfig): McpClient {
    if (this.clients.has(config.id)) {
      this.clients.get(config.id)?.close();
    }
    const client = new McpClient(config);
    this.clients.set(config.id, client);
    return client;
  }

  public removeServer(id: string): boolean {
    const client = this.clients.get(id);
    if (client) {
      client.close();
      this.clients.delete(id);
      for (const [toolName, info] of this.tools.entries()) {
        if (info.serverId === id) {
          this.tools.delete(toolName);
        }
      }
      return true;
    }
    return false;
  }

  public async syncTools(): Promise<number> {
    let total = 0;
    for (const [serverId, client] of this.clients.entries()) {
      if (!client.config.enabled) continue;
      try {
        await client.initialize();
        const serverTools = await client.listTools();
        for (const st of serverTools) {
          const registeredName = `mcp_${serverId}_${st.name}`;
          this.tools.set(registeredName, { serverId, schema: st });
          total++;
        }
      } catch (err) {
        console.warn(`[mcp:manager] sync failed for ${serverId}:`, err);
      }
    }
    return total;
  }

  public getDiscoveredTools(): Array<{
    name: string;
    serverId: string;
    description?: string;
    parameters: any;
  }> {
    const list: Array<{ name: string; serverId: string; description?: string; parameters: any }> =
      [];
    for (const [name, info] of this.tools.entries()) {
      list.push({
        name,
        serverId: info.serverId,
        description: info.schema.description,
        parameters: z.record(z.string(), z.unknown()),
      });
    }
    return list;
  }

  public async executeTool(registeredName: string, args: Record<string, unknown>): Promise<any> {
    const info = this.tools.get(registeredName);
    if (!info) {
      throw new Error(`MCP tool "${registeredName}" not found or server is offline`);
    }
    const client = this.clients.get(info.serverId);
    if (!client) {
      throw new Error(`MCP server "${info.serverId}" is not running`);
    }
    return await client.callTool(info.schema.name, args);
  }

  public closeAll(): void {
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
    this.tools.clear();
  }
}
