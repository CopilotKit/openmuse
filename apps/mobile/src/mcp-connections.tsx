import { useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import { Button, Card, CheckRow, ErrorNotice, Field, SectionHeading, s } from "./ui";
import { useWorkspace } from "./workspace";

interface McpTool {
  name: string;
  description: string;
  readOnly: boolean;
}
interface McpServer {
  id: string;
  name: string;
  transport: "http" | "sse" | "stdio";
  endpoint: string;
  status: "disconnected" | "connected" | "needs_auth" | "error";
  tools: McpTool[];
  enabledTools: string[];
  error?: string;
}

const elevenLabs = "https://api.elevenlabs.io/v1/mcp";
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const connectionStatus = {
  disconnected: "Not connected",
  connected: "Connected",
  needs_auth: "Needs sign-in",
  error: "Connection issue",
};
function parseMap(text: string) {
  if (!text.trim()) return undefined;
  const value: unknown = JSON.parse(text);
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.values(value).some((item) => typeof item !== "string")
  )
    throw new Error(
      'Enter a JSON object with text values, such as {"Authorization":"Bearer ..."}.',
    );
  return value as Record<string, string>;
}

export function McpConnections({ query = "" }: { query?: string }) {
  const { api, notify } = useWorkspace();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpServer["transport"]>("http");
  const [endpoint, setEndpoint] = useState("");
  const [extra, setExtra] = useState("");
  const [args, setArgs] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expandedServers, setExpandedServers] = useState<Record<string, boolean>>({});
  const refresh = async () => setServers(await api.request<McpServer[]>("/api/mcp/servers"));
  useEffect(() => {
    void refresh().catch((e) => setError(describe(e)));
  }, [api]);

  async function add() {
    setBusy(true);
    setError("");
    try {
      const input =
        transport === "stdio"
          ? {
              name: name.trim(),
              transport,
              command: endpoint.trim(),
              args: args.trim() ? JSON.parse(args) : [],
              env: parseMap(extra),
            }
          : { name: name.trim(), transport, url: endpoint.trim(), headers: parseMap(extra) };
      const server = await api.request<McpServer>("/api/mcp/servers", input);
      setName("");
      setEndpoint("");
      setExtra("");
      setArgs("");
      await refresh();
      await connect(server.id);
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }
  async function connect(id: string) {
    setBusy(true);
    setError("");
    try {
      const result = await api.request<{ server?: McpServer; authorizationUrl?: string }>(
        `/api/mcp/servers/${id}/connect`,
        {},
      );
      await refresh();
      if (result.authorizationUrl) {
        await Linking.openURL(result.authorizationUrl);
        notify("Finish signing in, then refresh MCP connections.");
      } else notify("MCP tools discovered.");
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }
  async function toggle(server: McpServer, tool: McpTool) {
    setBusy(true);
    setError("");
    try {
      const tools = server.enabledTools.includes(tool.name)
        ? server.enabledTools.filter((item) => item !== tool.name)
        : [...server.enabledTools, tool.name];
      await api.request(`/api/mcp/servers/${server.id}/tools`, { tools });
      await refresh();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    setError("");
    try {
      await api.request(`/api/mcp/servers/${id}`, {}, "DELETE");
      await refresh();
      notify("MCP connection removed.");
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }
  const visible = servers.filter((server) =>
    `${server.name} ${server.endpoint}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Card style={{ gap: 13 }}>
      <SectionHeading title="MCP connections" />
      <Text style={s.muted}>
        Connect a service and choose which read-only tools OpenMuse may use. Other tools stay
        unavailable to the agent.
      </Text>
      <Button
        small
        onPress={() => {
          setName("ElevenLabs");
          setTransport("http");
          setEndpoint(elevenLabs);
          setExtra("");
        }}
      >
        Use ElevenLabs hosted MCP
      </Button>
      {visible.map((server) => (
        <View
          key={server.id}
          style={{ gap: 8, borderTopWidth: 1, borderTopColor: "#EEEEF0", paddingTop: 12 }}
        >
          <Text style={s.text}>
            {server.name} · {connectionStatus[server.status]}
          </Text>
          <Text style={s.small}>{server.endpoint}</Text>
          {!!server.error && <Text style={s.small}>{server.error}</Text>}
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {server.tools.length > 0 && (
              <Button
                small
                onPress={() =>
                  setExpandedServers((current) => ({
                    ...current,
                    [server.id]: !current[server.id],
                  }))
                }
              >
                {expandedServers[server.id] ? "Hide" : "Show"} tools ({server.enabledTools.length}{" "}
                enabled)
              </Button>
            )}
            <Button small busy={busy} onPress={() => void connect(server.id)}>
              Refresh connection
            </Button>
            <Button small danger busy={busy} onPress={() => void remove(server.id)}>
              Remove
            </Button>
          </View>
          {expandedServers[server.id] &&
            server.tools.map((tool) => (
              <View key={tool.name} style={{ gap: 2 }}>
                <CheckRow
                  label={tool.name}
                  checked={server.enabledTools.includes(tool.name)}
                  onPress={() => {
                    if (tool.readOnly) void toggle(server, tool);
                  }}
                />
                <Text style={s.small}>
                  {tool.description || "No description"}
                  {tool.readOnly ? "" : " · Requires a future review flow"}
                </Text>
              </View>
            ))}
        </View>
      ))}
      <Text style={s.heading}>Add an MCP server</Text>
      <Field label="Name" value={name} onChangeText={setName} placeholder="My MCP server" />
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {(["http", "sse", "stdio"] as const).map((kind) => (
          <Button key={kind} small primary={transport === kind} onPress={() => setTransport(kind)}>
            {kind === "http" ? "HTTP" : kind === "sse" ? "SSE" : "Local command"}
          </Button>
        ))}
      </View>
      <Field
        label={transport === "stdio" ? "Command" : "MCP URL"}
        value={endpoint}
        onChangeText={setEndpoint}
        placeholder={transport === "stdio" ? "node" : "https://example.com/mcp"}
      />
      {transport === "stdio" && (
        <Field
          label="Arguments (JSON array)"
          value={args}
          onChangeText={setArgs}
          placeholder={'["server.js"]'}
        />
      )}
      <Field
        label={
          transport === "stdio"
            ? "Environment (JSON object, optional)"
            : "Headers (JSON object, optional)"
        }
        value={extra}
        onChangeText={setExtra}
        placeholder="{}"
      />
      {transport === "stdio" && (
        <Text style={s.small}>
          Local commands run on the OpenMuse server. Add only programs you trust.
        </Text>
      )}
      <Button busy={busy} disabled={!name.trim() || !endpoint.trim()} onPress={() => void add()}>
        Add and connect
      </Button>
      <Button small onPress={() => void refresh().catch((e) => setError(describe(e)))}>
        Refresh list
      </Button>
      <ErrorNotice error={error} />
    </Card>
  );
}
