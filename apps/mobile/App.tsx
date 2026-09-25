import { CopilotKitProvider } from "@copilotkit/react-native/headless";
import { StatusBar } from "expo-status-bar";
import {
  Activity,
  ArrowLeft,
  Bell,
  Check,
  LayoutGrid,
  LogOut,
  type LucideIcon,
  Menu,
  MessageSquareText,
  PanelLeft,
  PanelRight,
  Settings,
  Sparkles,
  Target,
  X,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { Section, Workspace } from "../../packages/domain/src";
import { AgentInspector } from "./src/agent-inspector";
import {
  AgentActivityScreen,
  AgentStatus,
  AppsScreen,
  GoalsScreen,
  IdeasScreen,
} from "./src/agent-ui";
import { AgentWorkspaceProvider, useAgentWorkspace } from "./src/agent-workspace";
import {
  API_URL,
  ApiError,
  createSession,
  getAuthStatus,
  MuseApi,
  type SessionUser,
} from "./src/api";
import { ChatScreen, WorkspaceTools } from "./src/chat";
import { ChatSidebar } from "./src/chat-sidebar";
import { ComputerDraftProvider } from "./src/computer-drafts";
import { ConnectorsScreen } from "./src/connectors/index";
import { Details } from "./src/details";
import { useMascotState } from "./src/mascot-state";
import { toggleNav } from "./src/nav/nav-state";
import { NavDrawer } from "./src/nav-drawer";
import { BrowserScreen, CalendarScreen, FilesScreen, MailScreen } from "./src/screens";
import {
  clearSessionToken,
  clearSessionUser,
  loadSessionToken,
  loadSessionUser,
  saveSessionToken,
  saveSessionUser,
  validateSessionToken,
} from "./src/session-store";
import { SettingsScreen } from "./src/settings";
import { ThreadsProvider, ThreadsSheet, useMuseThread } from "./src/threads";
import {
  Button,
  Card,
  colors,
  ErrorNotice,
  ensureWebStyles,
  Field,
  IconButton,
  Mascot,
  SHELL_TESTID,
  s,
} from "./src/ui";
import { type Detail, useWorkspace, WorkspaceContext } from "./src/workspace";

const nav: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: "chat", label: "Chat", icon: MessageSquareText },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "ideas", label: "Ideas", icon: Sparkles },
  { id: "goals", label: "Goals", icon: Target },
  { id: "apps", label: "Apps", icon: LayoutGrid },
];

function NavItem({
  item,
  active,
  onPress,
}: {
  item: { id: Section; label: string; icon: LucideIcon };
  active: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <View style={{ flex: 1, position: "relative", alignItems: "center" }}>
      {hovered && (
        <View
          pointerEvents="none"
          style={
            {
              position: "absolute",
              bottom: 54,
              backgroundColor: "#1E293B",
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: 8,
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.18,
              shadowRadius: 8,
              elevation: 8,
              zIndex: 9999,
              whiteSpace: "nowrap",
            } as any
          }
        >
          <Text
            style={{
              color: "#FFFFFF",
              fontSize: 12,
              fontWeight: "600",
              letterSpacing: 0.2,
            }}
          >
            {item.label}
          </Text>
        </View>
      )}
      <Pressable
        accessibilityRole="tab"
        accessibilityLabel={item.label}
        accessibilityState={{ selected: active }}
        onPress={onPress}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        {...({ title: item.label } as any)}
        style={({ pressed }) => [
          {
            width: "100%",
            height: 47,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: active
              ? "#F0F1F2"
              : pressed
                ? "#EAECEF"
                : hovered
                  ? "#F8FAFC"
                  : "transparent",
            borderRadius: 28,
          },
        ]}
      >
        <item.icon
          size={22}
          strokeWidth={active ? 2.2 : 1.8}
          color={active ? colors.blueDark : colors.text}
        />
      </Pressable>
    </View>
  );
}
const titles: Partial<Record<Section, { title: string; subtitle: string }>> = {
  activity: { title: "Activity", subtitle: "Plans, progress, decisions and results." },
  ideas: { title: "Ideas", subtitle: "Useful next steps, grounded in your world." },
  goals: {
    title: "Goals",
    subtitle: "Longer-term goals and things to keep an eye on.",
  },
  apps: {
    title: "Apps",
    subtitle: "Connections, capabilities and what your agent remembers.",
  },
  connections: { title: "Apps", subtitle: "Connections and capabilities." },
  mail: { title: "Mail", subtitle: "The conversations behind your work." },
  calendar: { title: "Calendar", subtitle: "Time for what matters." },
  browser: { title: "Browser", subtitle: "Your connected browsing sessions." },
  files: { title: "Files", subtitle: "Documents, forms and filled copies." },
  connectors: { title: "Connectors", subtitle: "Integrations and connected services." },
  settings: {
    title: "Settings",
    subtitle: "Accounts, models, the agent, and integrations in one place.",
  },
};
export default function App() {
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const [authStatus, setAuthStatus] = useState<{ usersConfigured: boolean } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const connect = useCallback(async (creds?: { username: string; password: string }) => {
    setBusy(true);
    setError("");
    try {
      if (creds === undefined) {
        // App launch: try the stored session before asking for credentials.
        const stored = await loadSessionToken();
        if (stored) {
          if (await validateSessionToken(API_URL, stored)) {
            const storedUser = await loadSessionUser();
            setSessionUser(
              storedUser && (storedUser.role === "admin" || storedUser.role === "user")
                ? { username: storedUser.username, role: storedUser.role }
                : { username: "admin", role: "admin" },
            );
            setToken(stored);
            setBusy(false);
            return;
          }
          // The server rejected it (expired or unknown) -- drop it and fall
          // through to the sign-in form below.
          await clearSessionToken();
          await clearSessionUser();
        }
        // No usable stored session -- show the sign-in form, not an error.
        try {
          setAuthStatus(await getAuthStatus());
        } catch {
          setAuthStatus(null);
        }
        setBusy(false);
        return;
      }
      const session = await createSession(creds.username, creds.password);
      await saveSessionToken(session.token);
      const user: SessionUser = { username: session.username, role: session.role };
      await saveSessionUser(user);
      setSessionUser(user);
      setToken(session.token);
      setPassword("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);
  const handleSessionExpired = useCallback(() => {
    setToken("");
    setSessionUser(null);
    void clearSessionUser();
  }, []);
  useEffect(() => {
    void connect();
  }, [connect]);
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {token ? (
        <CopilotKitProvider
          runtimeUrl={`${API_URL}/api/copilotkit`}
          headers={{ Authorization: `Bearer ${token}` }}
        >
          {sessionUser && (
            <WorkspaceApp
              token={token}
              sessionUser={sessionUser}
              onSessionExpired={handleSessionExpired}
            />
          )}
        </CopilotKitProvider>
      ) : (
        <SafeAreaView
          style={{
            flex: 1,
            backgroundColor: colors.canvas,
            justifyContent: "center",
            alignItems: "center",
            padding: 24,
          }}
        >
          <View style={{ width: "100%", maxWidth: 420, gap: 22, alignItems: "center" }}>
            <Mascot size={72} />
            <Text
              style={{ fontSize: 32, color: colors.text, letterSpacing: -1, fontWeight: "500" }}
            >
              Welcome to OpenMuse.
            </Text>
            <Text style={[s.muted, { textAlign: "center" }]}>A little room for your day.</Text>
            {busy ? (
              <ActivityIndicator color={colors.blueDark} />
            ) : (
              <Card style={{ width: "100%" }}>
                <ErrorNotice error={error} />
                <Field
                  label="Username"
                  value={username}
                  onChangeText={setUsername}
                  placeholder="Your OpenMuse username"
                  autoCapitalize="none"
                />
                <Field
                  label="Password"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  placeholder="••••••••"
                />
                <Button
                  primary
                  disabled={!username.trim() || !password}
                  onPress={() => void connect({ username: username.trim(), password })}
                >
                  Sign in
                </Button>
                <Text style={[s.small, { marginTop: 15 }]}>
                  {authStatus && !authStatus.usersConfigured
                    ? "First sign-in: use username \u201cadmin\u201d and your workspace access key as the password. You can change it under Apps → Users afterwards."
                    : "Sign in with your OpenMuse username and password."}{" "}
                  Make sure your OpenMuse server is running at {API_URL}.
                </Text>
              </Card>
            )}
          </View>
        </SafeAreaView>
      )}
    </SafeAreaProvider>
  );
}
function WorkspaceApp({
  token,
  sessionUser,
  onSessionExpired,
}: {
  token: string;
  sessionUser: SessionUser;
  onSessionExpired: () => void;
}) {
  const api = useMemo(() => new MuseApi(token), [token]);
  const [workspace, setWorkspace] = useState<Workspace>();
  const [section, setSection] = useState<Section>("chat");
  const [detail, setDetail] = useState<Detail>();
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState<{ id: number; text: string }>();
  const refresh = useCallback(async () => {
    try {
      const snapshot = await api.request<Workspace>("/api/workspace");
      setWorkspace(snapshot);
      setError("");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // The session died server-side (24h expiry): forget the stored
        // token and drop back to the login screen instead of erroring.
        await clearSessionToken();
        onSessionExpired();
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, [api, onSessionExpired]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => listener.remove();
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5500);
    return () => clearTimeout(timer);
  }, [toast]);
  const navigate = useCallback(
    (next: Section) =>
      setSection(next === "today" ? "chat" : next === "connections" ? "apps" : next),
    [],
  );
  const open = useCallback((next: Detail) => setDetail(next), []);
  const close = useCallback(() => setDetail(undefined), []);
  const logout = useCallback(async () => {
    try {
      await api.request("/api/session/revoke", {}, "POST");
    } catch {
      // Best-effort: local cleanup below still signs the user out.
    }
    await clearSessionToken();
    await clearSessionUser();
    onSessionExpired();
  }, [api, onSessionExpired]);
  const ask = useCallback((text: string) => {
    setPrompt({ id: Date.now(), text });
    setSection("chat");
  }, []);
  if (!workspace)
    return (
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: colors.canvas,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          gap: 18,
        }}
      >
        <Mascot size={90} />
        {error ? (
          <>
            <ErrorNotice error={error} />
            <Button onPress={() => void refresh()}>Try again</Button>
          </>
        ) : (
          <>
            <ActivityIndicator color={colors.blueDark} />
            <Text style={s.muted}>Opening your workspace…</Text>
          </>
        )}
      </SafeAreaView>
    );
  return (
    <WorkspaceContext.Provider
      value={{
        workspace,
        api,
        sessionUser,
        section,
        navigate,
        refresh,
        open,
        close,
        notify: setToast,
        ask,
        logout,
      }}
    >
      <AgentWorkspaceProvider>
        <ComputerDraftProvider key={token}>
          <ThreadsProvider>
            <WorkspaceShell
              detail={detail}
              toast={toast}
              clearToast={() => setToast("")}
              error={error}
              prompt={prompt}
            />
          </ThreadsProvider>
        </ComputerDraftProvider>
      </AgentWorkspaceProvider>
    </WorkspaceContext.Provider>
  );
}
function WorkspaceShell({
  detail,
  toast,
  clearToast,
  error,
  prompt,
}: {
  detail?: Detail;
  toast: string;
  clearToast: () => void;
  error: string;
  prompt?: { id: number; text: string };
}) {
  const { workspace, section, navigate, open, logout } = useWorkspace();
  const { data } = useAgentWorkspace();
  const {
    selection,
    visited,
    mainId,
    loading: threadsLoading,
    error: threadsError,
    retry: retryThreads,
    enabled: richThreads,
  } = useMuseThread();
  const [threadsOpen, setThreadsOpen] = useState(false);
  const { width } = useWindowDimensions();
  const desktop = width >= 900;
  // Single shared container width for every route (see SHELL_TESTID in ui.tsx):
  // desktop is capped by the web stylesheet at min(94vw, 1500px) and centered.
  ensureWebStyles();
  const pending =
    (data?.notifications.filter((n) => !n.read).length || 0) +
    workspace.actions.filter((a) => a.status === "awaiting_review").length;
  const _mascotState = useMascotState();
  const title = titles[section] || titles.apps;
  const Screen =
    section === "mail"
      ? MailScreen
      : section === "calendar"
        ? CalendarScreen
        : section === "browser"
          ? BrowserScreen
          : section === "files"
            ? FilesScreen
            : section === "activity"
              ? AgentActivityScreen
              : section === "ideas"
                ? IdeasScreen
                : section === "goals"
                  ? GoalsScreen
                  : section === "connectors"
                    ? ConnectorsScreen
                    : section === "settings"
                      ? SettingsScreen
                      : AppsScreen;
  const utility = ["mail", "calendar", "browser", "files"].includes(section);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showInspector, setShowInspector] = useState(true);
  return (
    <>
      <WorkspaceTools />
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }} edges={["top", "bottom"]}>
        <View
          testID={SHELL_TESTID}
          style={{
            flex: 1,
            width: "100%",
            alignSelf: "center",
          }}
        >
          <View
            style={{
              paddingTop: 6,
              paddingBottom: 6,
              marginHorizontal: 20,
              minHeight: 46,
              flexDirection: "row",
              alignItems: "center",
            }}
          >
            {/* Left: Compact navigation trigger & side chat panel toggle */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, zIndex: 1 }}>
              <IconButton icon={Menu} label="Open navigation menu" onPress={toggleNav} />
              {desktop && section === "chat" && (
                <IconButton
                  icon={PanelLeft}
                  label={showSidebar ? "Hide side chats" : "Show side chats"}
                  onPress={() => setShowSidebar(!showSidebar)}
                />
              )}
            </View>
            <View style={{ flex: 1 }} />
            {/* Right: PanelRight toggle and fallback header actions when inspector closed */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, zIndex: 1 }}>
              {desktop && section === "chat" && (
                <IconButton
                  icon={PanelRight}
                  label={showInspector ? "Hide agent inspector" : "Show agent inspector"}
                  onPress={() => setShowInspector(!showInspector)}
                />
              )}
              {(!desktop || !showInspector || section !== "chat") && (
                <>
                  <IconButton
                    icon={Settings}
                    label="Open Settings"
                    onPress={() => navigate("settings")}
                  />
                  <View>
                    <IconButton
                      icon={Bell}
                      label={`Notifications, ${pending} unread or pending`}
                      onPress={() => open({ type: "notifications" })}
                    />
                    {pending > 0 && (
                      <View
                        pointerEvents="none"
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 4,
                          position: "absolute",
                          top: 7,
                          right: 9,
                          backgroundColor: colors.blueDark,
                        }}
                      />
                    )}
                  </View>
                  <IconButton icon={LogOut} label="Log out" onPress={() => void logout()} />
                </>
              )}
            </View>
          </View>
          <View style={{ flex: 1, minHeight: 0 }}>
            {section !== "chat" && (
              <ScrollView
                key={section}
                // Web shows the native scrollbar; native keeps its thin auto-hiding indicator.
                showsVerticalScrollIndicator={Platform.OS === "web"}
                persistentScrollbar={false}
                contentContainerStyle={{ paddingHorizontal: desktop ? 40 : 20, paddingBottom: 28 }}
                keyboardShouldPersistTaps="handled"
              >
                {section !== "connectors" && (
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 12,
                      marginBottom: 10,
                    }}
                  >
                    {utility && (
                      <Button small icon={ArrowLeft} onPress={() => navigate("apps")}>
                        Back
                      </Button>
                    )}
                    <Text style={[s.title, { fontSize: 20, marginVertical: 0 }]}>
                      {title?.title}
                    </Text>
                  </View>
                )}
                <ErrorNotice error={error} />
                <Screen />
              </ScrollView>
            )}
            {section === "chat" ? (
              <View style={{ flex: 1, flexDirection: "row", overflow: "hidden" }}>
                {desktop && showSidebar && <ChatSidebar onClose={() => setShowSidebar(false)} />}
                <View
                  style={{
                    flex: 1,
                    minWidth: 0,
                    height: "100%",
                    paddingHorizontal: desktop ? 24 : 12,
                  }}
                >
                  <AgentStatus />
                  {selection.id !== mainId && (
                    <Text
                      style={[
                        s.small,
                        { textAlign: "center", marginBottom: 6, color: colors.muted },
                      ]}
                    >
                      Side chat
                    </Text>
                  )}
                  {visited.map((thread) => (
                    <View
                      key={thread.id}
                      style={{
                        display: selection.id === thread.id ? "flex" : "none",
                        flex: 1,
                      }}
                    >
                      <ChatScreen
                        thread={thread}
                        active={section === "chat" && selection.id === thread.id}
                        prompt={selection.id === thread.id ? prompt : undefined}
                      />
                    </View>
                  ))}
                </View>
                {desktop && showInspector && (
                  <AgentInspector
                    onClose={() => setShowInspector(false)}
                    onLogout={() => void logout()}
                  />
                )}
              </View>
            ) : null}
          </View>
          <View
            style={{
              paddingHorizontal: 22,
              paddingTop: 10,
              paddingBottom: desktop ? 22 : 7,
              alignItems: "center",
            }}
          >
            <View
              style={{
                flexDirection: "row",
                width: "100%",
                maxWidth: 370,
                padding: 5,
                backgroundColor: "#FFF",
                borderRadius: 40,
                shadowColor: "#132631",
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.07,
                shadowRadius: 18,
                elevation: 3,
                borderWidth: 1,
                borderColor: "#F8F8F8",
              }}
            >
              {nav.map((item) => {
                const active = section === item.id || (item.id === "apps" && utility);
                return (
                  <NavItem
                    key={item.id}
                    item={item}
                    active={active}
                    onPress={() => navigate(item.id)}
                  />
                );
              })}
            </View>
          </View>
        </View>
        {!!toast && (
          <View
            pointerEvents="box-none"
            style={{ position: "absolute", bottom: 94, left: 20, right: 20, alignItems: "center" }}
          >
            <View
              style={[
                s.row,
                {
                  gap: 10,
                  padding: 14,
                  backgroundColor: colors.text,
                  borderRadius: 20,
                  maxWidth: 560,
                },
              ]}
            >
              <Check size={16} color={colors.blue} />
              <Text style={{ color: "#FFF", fontSize: 13, flexShrink: 1 }}>{toast}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Dismiss notification"
                onPress={clearToast}
              >
                <X size={16} color="#FFF" />
              </Pressable>
            </View>
          </View>
        )}
        {threadsOpen && <ThreadsSheet onClose={() => setThreadsOpen(false)} />}
        <NavDrawer onOpenThreads={() => setThreadsOpen(true)} />
        {detail && (
          <Details
            key={
              detail.type === "task"
                ? detail.taskId
                : detail.type === "file"
                  ? detail.file.id
                  : detail.type === "browser"
                    ? detail.browser.id
                    : detail.type === "mail"
                      ? detail.mail.id
                      : detail.type === "review"
                        ? detail.action.id
                        : detail.type === "email"
                          ? JSON.stringify(detail.draft)
                          : detail.type === "event"
                            ? detail.event?.id || "event-new"
                            : detail.type
            }
            detail={detail}
          />
        )}
      </SafeAreaView>
    </>
  );
}
