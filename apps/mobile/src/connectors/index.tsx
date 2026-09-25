/**
 * ConnectorsScreen — the Connectors GUI for OpenMuse.
 *
 * EXPORT (mount with a single import; no props needed):
 *
 *   import { ConnectorsScreen } from "./connectors";
 *
 *   // then in navigation:
 *   <ConnectorsScreen />
 *
 * ConnectorsScreen takes NO props. It reads the session API client and the
 * workspace's open browser sessions from WorkspaceContext via useWorkspace(),
 * exactly like the other screens in ../screens.tsx.
 *
 * Tabs are driven by GET /api/plugins (one tab per plugin, in manifest
 * order): the credentials plugin renders CredentialsSection (./credentials.tsx),
 * the email plugin renders EmailSection (./email.tsx), and any other plugin
 * with a config schema renders a manifest-generated settings form
 * (./generated.tsx). The existing section bodies are preserved unchanged.
 *
 * Shared typed API client: ./api.ts (createConnectorsApi).
 *
 * SECURITY: secrets are write-only everywhere in this module. Passwords are
 * sent to the server only on create / explicit rotation and are never
 * rendered, logged, or stored; list endpoints return redacted metadata
 * (usernameHint, hosts/ports) only.
 */
import { KeyRound, Mail, MessageCircle, Puzzle, TriangleAlert } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { colors, s } from "../ui";
import { useWorkspace } from "../workspace";
import type { ConnectorsApi, PluginConfigView, PluginSummary } from "./api";
import { createConnectorsApi, requestMessage } from "./api";
import { CredentialsSection } from "./credentials";
import { EmailSection } from "./email";
import { PluginConfigForm, type PluginConfigPatch } from "./generated";
import { WhatsAppSection } from "./whatsapp";

interface TabDef {
  id: string;
  label: string;
  icon: typeof KeyRound;
  pluginId: string;
}

/** Manifest-driven tabs; the two known connectors keep their bespoke bodies. */
function tabsFor(plugins: PluginSummary[]): TabDef[] {
  const tabs: TabDef[] = [];
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  if (byId.get("credentials")?.status === "active")
    tabs.push({
      id: "credentials",
      label: "Website logins",
      icon: KeyRound,
      pluginId: "credentials",
    });
  if (byId.get("email")?.status === "active")
    tabs.push({ id: "email", label: "Email accounts", icon: Mail, pluginId: "email" });
  // WhatsApp is a known connector with a bespoke section (pairing + rules);
  // like email it keeps its own body instead of the generated form.
  if (byId.get("whatsapp")?.status === "active")
    tabs.push({ id: "whatsapp", label: "WhatsApp", icon: MessageCircle, pluginId: "whatsapp" });
  for (const plugin of plugins) {
    if (plugin.id === "credentials" || plugin.id === "email" || plugin.id === "whatsapp") continue;
    if (plugin.status !== "active" || !plugin.hasConfig) continue;
    tabs.push({ id: plugin.id, label: plugin.name, icon: Puzzle, pluginId: plugin.id });
  }
  return tabs;
}

function PluginConfigSection({ api, pluginId }: { api: ConnectorsApi; pluginId: string }) {
  const [view, setView] = useState<PluginConfigView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.plugins
      .getConfig(pluginId)
      .then((loaded) => {
        if (live) setView(loaded);
      })
      .catch((unknownError: unknown) => {
        if (live) setError(requestMessage(unknownError));
      });
    return () => {
      live = false;
    };
  }, [api, pluginId]);
  const submit = async (patch: PluginConfigPatch) => {
    setBusy(true);
    setError(null);
    try {
      setView(await api.plugins.updateConfig(pluginId, patch));
    } catch (unknownError: unknown) {
      setError(requestMessage(unknownError));
    } finally {
      setBusy(false);
    }
  };
  if (!view)
    return (
      <Text style={s.muted}>
        {error ? `Could not load settings: ${error}` : "Loading settings…"}
      </Text>
    );
  return (
    <PluginConfigForm
      view={view}
      busy={busy}
      error={error}
      onSubmit={(patch) => void submit(patch)}
    />
  );
}

export function ConnectorsScreen() {
  const { api, workspace, open, sessionUser } = useWorkspace();
  const connectors = useMemo(() => createConnectorsApi(api), [api]);
  const [plugins, setPlugins] = useState<PluginSummary[] | null>(null);
  const [pluginsFailed, setPluginsFailed] = useState(false);
  const [tabId, setTabId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    connectors.plugins
      .list()
      .then((summaries) => {
        if (live) setPlugins(summaries);
      })
      .catch(() => {
        // Fall back to the two known tabs so the screen still works when the
        // plugin endpoint is unreachable.
        if (live) setPluginsFailed(true);
      });
    return () => {
      live = false;
    };
  }, [connectors]);

  const tabs = useMemo(() => {
    if (plugins) return tabsFor(plugins);
    if (pluginsFailed)
      return [
        { id: "credentials", label: "Website logins", icon: KeyRound, pluginId: "credentials" },
        { id: "email", label: "Email accounts", icon: Mail, pluginId: "email" },
      ];
    return [];
  }, [plugins, pluginsFailed]);

  const activeId = tabId && tabs.some((tab) => tab.id === tabId) ? tabId : tabs[0]?.id;
  const errored = useMemo(
    () => (plugins ?? []).filter((plugin) => plugin.status === "error"),
    [plugins],
  );

  if (sessionUser.role !== "admin") {
    return (
      <View style={{ gap: 22 }}>
        <View>
          <Text style={s.title}>Connectors</Text>
          <Text style={[s.muted, { marginTop: 4 }]}>
            Connector settings are managed by an admin. Ask your admin to add website logins or
            email accounts.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ gap: 22 }}>
      <View>
        <Text style={s.title}>Connectors</Text>
        <Text style={[s.muted, { marginTop: 4 }]}>
          Capabilities the agent can use, provided by its plugins. Passwords are write-only —
          they&apos;re encrypted on the server and never shown back.
        </Text>
        {errored.length > 0 ? (
          <View style={[s.row, { gap: 8, marginTop: 8, alignItems: "center" }]}>
            <TriangleAlert size={14} color={colors.danger} />
            <Text style={[s.small, { color: colors.danger }]}>
              {errored.length === 1
                ? `Plugin "${errored[0].id}" failed to load.`
                : `${errored.length} plugins failed to load.`}{" "}
              See /api/plugins/errors for details.
            </Text>
          </View>
        ) : null}
      </View>

      {tabs.length === 0 ? (
        <Text style={s.muted}>Loading connectors…</Text>
      ) : (
        <View style={{ alignItems: "flex-start" }}>
          <View
            accessibilityRole="tablist"
            style={[
              s.row,
              {
                gap: 4,
                padding: 4,
                borderRadius: 26,
                backgroundColor: "#F1F2F3",
                alignSelf: "flex-start",
              },
            ]}
          >
            {tabs.map(({ id, label, icon: Icon }) => {
              const active = id === activeId;
              return (
                <Pressable
                  key={id}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active }}
                  onPress={() => setTabId(id)}
                  style={({ pressed }) => [
                    s.row,
                    {
                      gap: 7,
                      paddingVertical: 9,
                      paddingHorizontal: 16,
                      borderRadius: 22,
                      backgroundColor: active ? colors.blue : "transparent",
                      opacity: pressed && !active ? 0.6 : 1,
                    },
                  ]}
                >
                  <Icon size={14} color={colors.text} />
                  <Text style={[s.small, { color: colors.text, fontWeight: "700" }]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      {activeId === "credentials" ? (
        <CredentialsSection
          api={connectors}
          browsers={workspace.browsers}
          onOpenBrowser={(browser) => open({ type: "browser", browser })}
        />
      ) : activeId === "email" ? (
        <EmailSection api={connectors} />
      ) : activeId === "whatsapp" ? (
        <WhatsAppSection api={connectors} />
      ) : activeId ? (
        <PluginConfigSection api={connectors} pluginId={activeId} />
      ) : null}
    </View>
  );
}
