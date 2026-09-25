/**
 * SettingsScreen — the single ⚙️ Settings section (Phase 3 consolidation).
 *
 * One entry point (header gear + nav drawer "More → Settings") organising every
 * configuration surface into 10 categories: Email, Calendar, AI/Models, Muse
 * Agent, Tools, Memory, Automations, Integrations, Security, Advanced.
 *
 * Deliberate placement rules (matching the Phase 3 constraints):
 *   - EMBEDDED: EmailSection, ModelSettingsScreen, CalDAV account manager,
 *     and a services-health list are owned here (admin-only writes).
 *   - EMBEDDED (owner request): Clear chat history lives here in Advanced,
 *     not on the Apps tab.
 *   - LINKED: anything that lives in an off-limits surface (Apps tab,
 *     Connections screen, Users screen, login flow) is reached by a LinkRow
 *     that navigates there — never duplicated. Genuinely remote controls are
 *     noted in the category text until Muse reconciles them.
 *   - Secrets stay write-only: passwords are only ever sent on create/rotation.
 */
import {
  Brain,
  Cpu,
  FlaskConical,
  KeyRound,
  LogOut,
  Plug,
  Plus,
  RefreshCw,
  Repeat,
  Shapes,
  Trash2,
  Users,
  Wrench,
} from "lucide-react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useAgentWorkspace } from "./agent-workspace";
import { ClearHistorySheet } from "./clear-history";
import { createConnectorsApi } from "./connectors/api";
import { EmailSection } from "./connectors/email";
import { ModelSettingsScreen } from "./model-settings";
import {
  Button,
  Card,
  CheckRow,
  colors,
  ErrorNotice,
  Field,
  LinkRow,
  SectionHeading,
  s,
} from "./ui";
import { useWorkspace } from "./workspace";

interface CalendarAccountMeta {
  id: string;
  label: string;
  emailAddress: string;
  username: string;
  server: { host: string; port: number; path: string; secure: boolean };
  createdAt: string;
  updatedAt: string;
}

function AdminNotice() {
  return (
    <Card>
      <View style={{ gap: 4 }}>
        <Text style={s.text}>Managed by an admin</Text>
        <Text style={s.muted}>
          This category changes accounts and keys on the server. Ask your admin to make the change,
          or log in as an admin user.
        </Text>
      </View>
    </Card>
  );
}

function CalendarAccountsCard({ isAdmin }: { isAdmin: boolean }) {
  const { api, notify } = useWorkspace();
  const [accounts, setAccounts] = useState<CalendarAccountMeta[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [testDetail, setTestDetail] = useState<Record<string, string>>({});
  const [syncDetail, setSyncDetail] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    label: "",
    emailAddress: "",
    username: "",
    password: "",
    host: "dav.titan.email",
    port: "443",
    path: "/",
    secure: true,
  });

  const load = async () => {
    setBusy(true);
    setError("");
    try {
      setAccounts(await api.request<CalendarAccountMeta[]>("/api/calendar-accounts"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setAccounts([]);
    } finally {
      setBusy(false);
    }
  };
  const startAdd = async () => {
    if (!isAdmin) return;
    setError("");
    try {
      await api.request<unknown>("/api/calendar-accounts", {
        label: form.label,
        emailAddress: form.emailAddress,
        username: form.username,
        password: form.password,
        host: form.host,
        port: Number(form.port),
        path: form.path || "/",
        secure: form.secure,
      });
      notify("Calendar account added.");
      setForm((f) => ({
        ...f,
        label: "",
        emailAddress: "",
        username: "",
        password: "",
      }));
      setAdding(false);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const remove = async (id: string) => {
    setError("");
    try {
      await api.request<unknown>(`/api/calendar-accounts/${id}`, undefined, "DELETE");
      notify("Calendar account removed.");
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const test = async (id: string) => {
    setTesting(id);
    setError("");
    try {
      const result = await api.request<{ ok: boolean; calendarCount: number; detail?: string }>(
        `/api/calendar-accounts/${id}/test`,
        {},
        "POST",
      );
      setTestDetail((d) => ({
        ...d,
        [id]: result.ok
          ? `Connected — ${result.calendarCount} calendar${result.calendarCount === 1 ? "" : "s"} found${
              result.detail ? ` (${result.detail})` : ""
            }`
          : (result.detail ?? "Connection failed."),
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(null);
    }
  };
  const sync = async (id: string) => {
    setSyncing(id);
    setError("");
    try {
      const result = await api.request<{
        total: number;
        calendars: { displayName: string; count: number }[];
      }>(`/api/calendar-accounts/${id}/sync`, {}, "POST");
      const detail = result.calendars
        .filter((c) => c.count > 0)
        .map((c) => `${c.displayName} (${c.count})`)
        .join(", ");
      setSyncDetail((d) => ({
        ...d,
        [id]: `Synced ${result.total} event${result.total === 1 ? "" : "s"} locally${detail ? ` — ${detail}` : ""}.`,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(null);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      <ErrorNotice error={error} />
      {accounts === null && !busy ? (
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Button primary small onPress={() => void load()}>
            Load calendar accounts
          </Button>
        </View>
      ) : accounts === null ? (
        <Text style={s.muted}>Loading…</Text>
      ) : accounts.length === 0 ? (
        <Card>
          <Text style={s.muted}>
            No CalDAV accounts yet. Add one to read, create and edit your calendar events.
          </Text>
        </Card>
      ) : (
        accounts.map((account) => (
          <Card key={account.id}>
            <View style={[s.between, { marginBottom: 8 }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={s.heading}>{account.label}</Text>
                <Text style={s.small}>
                  {account.emailAddress} — {account.server.host}
                  {account.server.port !== 443 ? `:${account.server.port}` : ""}
                  {account.server.secure ? " · TLS" : " · plain"}
                </Text>
              </View>
              {isAdmin && (
                <Button small danger icon={Trash2} onPress={() => void remove(account.id)}>
                  Remove
                </Button>
              )}
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {isAdmin && (
                <Button
                  small
                  icon={FlaskConical}
                  busy={testing === account.id}
                  onPress={() => void test(account.id)}
                >
                  Test
                </Button>
              )}
              {isAdmin && (
                <Button
                  small
                  icon={RefreshCw}
                  busy={syncing === account.id}
                  onPress={() => void sync(account.id)}
                >
                  Sync now
                </Button>
              )}
            </View>
            {testDetail[account.id] ? (
              <Text style={[s.small, { marginTop: 8 }]}>{testDetail[account.id]}</Text>
            ) : null}
            {syncDetail[account.id] ? (
              <Text style={[s.small, { marginTop: 4 }]}>{syncDetail[account.id]}</Text>
            ) : null}
          </Card>
        ))
      )}

      {isAdmin && accounts !== null && (
        <View>
          {adding ? (
            <Card>
              <Text style={[s.heading, { marginBottom: 12 }]}>Add CalDAV account</Text>
              <Field
                label="Label"
                value={form.label}
                onChangeText={(value) => setForm((f) => ({ ...f, label: value }))}
                placeholder="Work"
              />
              <Field
                label="Email address"
                value={form.emailAddress}
                onChangeText={(value) => setForm((f) => ({ ...f, emailAddress: value }))}
                placeholder="support@example.com"
                autoCapitalize="none"
                keyboardType="email-address"
              />
              <Field
                label="Username"
                value={form.username}
                onChangeText={(value) => setForm((f) => ({ ...f, username: value }))}
                placeholder="support@example.com"
                autoCapitalize="none"
              />
              <Field
                label="Password"
                value={form.password}
                onChangeText={(value) => setForm((f) => ({ ...f, password: value }))}
                placeholder="Write-only — sent once, stored encrypted"
                secureTextEntry
              />
              <Field
                label="Server host"
                value={form.host}
                onChangeText={(value) => setForm((f) => ({ ...f, host: value }))}
                placeholder="dav.titan.email"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={{ flexDirection: "row", gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Field
                    label="Port"
                    value={form.port}
                    onChangeText={(value) =>
                      setForm((f) => ({ ...f, port: value.replace(/[^0-9]/g, "") }))
                    }
                    keyboardType="number-pad"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Field
                    label="Base path"
                    value={form.path}
                    onChangeText={(value) => setForm((f) => ({ ...f, path: value }))}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
              </View>
              <CheckRow
                label="Use TLS (secure connection)"
                checked={form.secure}
                onPress={() => setForm((f) => ({ ...f, secure: !f.secure }))}
              />
              <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
                <Button small primary onPress={() => void startAdd()}>
                  Add account
                </Button>
                <Button small onPress={() => setAdding(false)}>
                  Cancel
                </Button>
              </View>
            </Card>
          ) : (
            <Button small primary icon={Plus} onPress={() => setAdding(true)}>
              Add calendar account
            </Button>
          )}
        </View>
      )}

      {!isAdmin && accounts !== null && <AdminNotice />}
    </View>
  );
}

function HealthCard() {
  const { api } = useWorkspace();
  const [services, setServices] = useState<
    { id: string; label: string; detail: string; status: string }[] | null
  >(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api.request<{
        services: { id: string; label: string; detail: string; status: string }[];
      }>("/api/health/services");
      setServices(result.services);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const dot = (status: string) =>
    status === "up" ? "#24A46B" : status === "down" ? "#E5484D" : "#A7AAAC";
  const word = (status: string) =>
    status === "up" ? "Healthy" : status === "down" ? "Down" : "Not configured";
  return (
    <Card>
      <View style={[s.between, { marginBottom: 10 }]}>
        <Text style={s.heading}>Service health</Text>
        <Button small busy={busy} onPress={() => void load()}>
          Refresh
        </Button>
      </View>
      <ErrorNotice error={error} />
      {services === null && !error ? (
        <Pressable accessibilityRole="button" onPress={() => void load()}>
          <Text style={s.muted}>Check service health…</Text>
        </Pressable>
      ) : (
        (services ?? []).map((svc) => (
          <View key={svc.id} style={[s.row, { gap: 12, paddingVertical: 8 }]}>
            <View
              style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: dot(svc.status) }}
            />
            <View style={{ flex: 1, gap: 1 }}>
              <Text style={s.text}>{svc.label}</Text>
              <Text style={s.small}>{svc.detail}</Text>
            </View>
            <Text style={[s.small, { color: dot(svc.status), fontWeight: "600" }]}>
              {word(svc.status)}
            </Text>
          </View>
        ))
      )}
    </Card>
  );
}

function TelegramBotCard({ isAdmin }: { isAdmin: boolean }) {
  const { api, notify } = useWorkspace();
  const [status, setStatus] = useState<{
    enabled: boolean;
    running: boolean;
    ownerChatId?: string;
    botUsername?: string;
    lastSeenAt?: string;
    error?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [form, setForm] = useState({
    botToken: "",
    ownerChatId: "",
    enabled: true,
  });

  const load = async () => {
    setBusy(true);
    setError("");
    try {
      const data = await api.request<{
        enabled: boolean;
        running: boolean;
        ownerChatId?: string;
        botUsername?: string;
        lastSeenAt?: string;
        error?: string;
      }>("/api/telegram/status");
      setStatus(data);
      if (data.ownerChatId) {
        setForm((f) => ({ ...f, ownerChatId: data.ownerChatId ?? "", enabled: data.enabled }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus({ enabled: false, running: false });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError("");
    setTestResult(null);
    try {
      const updated = await api.request<{
        enabled: boolean;
        running: boolean;
        ownerChatId?: string;
        botUsername?: string;
        error?: string;
      }>("/api/telegram/config", form, "POST");
      setStatus(updated);
      notify("Telegram bot configuration saved.");
      setEditing(false);
      setForm((f) => ({ ...f, botToken: "" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setError("");
    setTestResult(null);
    try {
      const result = await api.request<{ ok: boolean; message: string }>(
        "/api/telegram/test",
        {},
        "POST",
      );
      setTestResult(result.ok ? "Test ping delivered to your Telegram!" : result.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const dot = status?.running ? "#24A46B" : status?.enabled ? "#EAA700" : "#A7AAAC";
  const stateLabel = status?.running
    ? `Online (@${status.botUsername ?? "bot"})`
    : status?.enabled
      ? "Configured (polling offline)"
      : "Not configured";

  return (
    <Card>
      <View style={[s.between, { marginBottom: 10 }]}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={s.heading}>Telegram Bot</Text>
          <Text style={s.small}>Chat with Muse from Telegram and receive notifications</Text>
        </View>
        <Button small busy={busy} onPress={() => void load()}>
          Refresh
        </Button>
      </View>
      <ErrorNotice error={error} />
      {status === null && !busy ? (
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Button small primary onPress={() => void load()}>
            Check Telegram status
          </Button>
        </View>
      ) : status === null ? (
        <Text style={s.muted}>Loading…</Text>
      ) : (
        <View style={{ gap: 10 }}>
          <View style={[s.row, { gap: 10, alignItems: "center" }]}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: dot }} />
            <Text style={[s.text, { fontWeight: "600" }]}>{stateLabel}</Text>
          </View>
          {status.ownerChatId ? (
            <Text style={s.small}>Authorized owner chat ID: {status.ownerChatId}</Text>
          ) : null}
          {status.lastSeenAt ? (
            <Text style={s.small}>Last activity: {status.lastSeenAt}</Text>
          ) : null}
          {status.error ? <ErrorNotice error={status.error} /> : null}
          {testResult ? <Text style={[s.small, { color: "#24A46B" }]}>{testResult}</Text> : null}

          {isAdmin && (
            <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
              {status.enabled && (
                <Button small busy={testing} onPress={() => void sendTest()}>
                  Send test message
                </Button>
              )}
              <Button small onPress={() => setEditing(!editing)}>
                {editing ? "Cancel" : "Configure bot"}
              </Button>
            </View>
          )}

          {isAdmin && editing && (
            <View style={{ gap: 10, marginTop: 8 }}>
              <Field
                label="Bot token (from @BotFather)"
                value={form.botToken}
                onChangeText={(val) => setForm((f) => ({ ...f, botToken: val }))}
                placeholder="Write-only: 123456789:ABCdefGHI..."
                secureTextEntry
              />
              <Field
                label="Owner chat ID (from @userinfobot)"
                value={form.ownerChatId}
                onChangeText={(val) => setForm((f) => ({ ...f, ownerChatId: val }))}
                placeholder="e.g. 987654321"
                keyboardType="number-pad"
              />
              <CheckRow
                label="Enable Telegram bot service"
                checked={form.enabled}
                onPress={() => setForm((f) => ({ ...f, enabled: !f.enabled }))}
              />
              <Button small primary busy={busy} onPress={() => void save()}>
                Save Telegram settings
              </Button>
            </View>
          )}
        </View>
      )}
    </Card>
  );
}

function AgentIdentitySection() {
  const { data, mutate } = useAgentWorkspace();
  const [name, setName] = useState(data?.identity?.name || "Muse");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useMemo(() => {
    if (data?.identity?.name) {
      setName(data.identity.name);
    }
  }, [data?.identity?.name]);

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    setSaved(false);
    try {
      await mutate("/identity", {
        name: name.trim(),
        tone: data?.identity?.tone || "warm",
        avatar: data?.identity?.avatar || "sky",
        showChatUpdates: data?.identity?.showChatUpdates !== false,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text }}>Agent Name</Text>
      <View style={[s.row, { gap: 8 }]}>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="e.g. Muse"
          placeholderTextColor={colors.muted}
          style={[s.input, { flex: 1, minHeight: 38 }]}
        />
        <Button
          small
          primary
          busy={saving}
          disabled={!name.trim() || name.trim() === (data?.identity?.name || "Muse")}
          onPress={() => void handleSave()}
        >
          {saved ? "Saved ✓" : "Save Name"}
        </Button>
      </View>
      <Text style={[s.small, { color: colors.muted }]}>
        Controls the agent display name shown under the mascot throughout the application.
      </Text>
    </View>
  );
}

export function SettingsScreen() {
  const { api, navigate, open, sessionUser, logout } = useWorkspace();
  const [showClearHistory, setShowClearHistory] = useState(false);
  const isAdmin = sessionUser.role === "admin";
  const connectors = useMemo(() => createConnectorsApi(api), [api]);

  const intro = isAdmin
    ? "Everything in one place: accounts, models, the agent, and integrations."
    : "Accounts, models and connectors are managed by an admin; the read-only views are shown here.";

  return (
    <View style={{ gap: 26 }}>
      <View style={{ gap: 4 }}>
        <Text style={s.title}>Settings</Text>
        <Text style={s.muted}>{intro}</Text>
      </View>

      {/* Email */}
      <View>
        <SectionHeading title="Email" />
        {isAdmin ? <EmailSection api={connectors} /> : <AdminNotice />}
      </View>

      {/* Calendar */}
      <View>
        <SectionHeading title="Calendar" />
        <CalendarAccountsCard isAdmin={isAdmin} />
      </View>

      {/* AI / Models */}
      <View>
        <SectionHeading title="AI / Models" />
        {isAdmin ? <ModelSettingsScreen api={api} /> : <AdminNotice />}
      </View>

      {/* Muse Agent */}
      <View>
        <SectionHeading title="Muse Agent" />
        <Card style={{ padding: 14, gap: 12 }}>
          <AgentIdentitySection />
          <View style={s.divider} />
          <LinkRow
            icon={Brain}
            title="Agent personality & memory"
            detail="Tone, avatar and long-term memory"
            onPress={() => navigate("apps")}
          />
          <View style={s.divider} />
          <LinkRow
            icon={Shapes}
            title="Notifications"
            detail="Unread items and pending approvals"
            onPress={() => open({ type: "notifications" })}
          />
          <View style={s.divider} />
          <LinkRow
            icon={KeyRound}
            title="Goals & monitors"
            detail="Tracking rules live on the Goals tab"
            onPress={() => navigate("goals")}
          />
        </Card>
      </View>

      {/* Tools */}
      <View>
        <SectionHeading title="Tools" />
        <Card>
          <View style={{ gap: 10 }}>
            <Text style={s.text}>Capabilities come from plugins.</Text>
            <Text style={s.muted}>
              Website logins, email, WhatsApp and any plugin with settings are managed in
              Connectors. Per-tool enable/disable switches are a planned follow-up.
            </Text>
            <View style={{ paddingVertical: 4 }}>
              <LinkRow
                icon={Wrench}
                title="Connectors & plugins"
                detail="Email, credentials, WhatsApp and generated plugin forms"
                onPress={() => navigate("connectors")}
              />
            </View>
          </View>
        </Card>
      </View>

      {/* Memory */}
      <View>
        <SectionHeading title="Memory" />
        <Card>
          <View style={{ gap: 10 }}>
            <Text style={s.muted}>
              What your agent remembers (and the candidates it asks you to approve) is managed from
              the Apps tab, under “Personality & memory”.
            </Text>
            <LinkRow
              icon={Brain}
              title="Open Apps memory"
              detail="Review and add memories"
              onPress={() => navigate("apps")}
            />
          </View>
        </Card>
      </View>

      {/* Automations */}
      <View>
        <SectionHeading title="Automations" />
        <Card>
          <View style={{ gap: 10 }}>
            <Text style={s.muted}>
              URL monitors live on the Goals tab. Scheduled/recurring agent jobs (server-side
              schedules) have no editing UI yet — that is a follow-up.
            </Text>
            <LinkRow
              icon={Repeat}
              title="Monitors on Goals"
              detail="URL checks, intervals, pause/resume"
              onPress={() => navigate("goals")}
            />
          </View>
        </Card>
      </View>

      {/* Integrations */}
      <View>
        <SectionHeading title="Integrations" />
        <View style={{ gap: 10 }}>
          <TelegramBotCard isAdmin={isAdmin} />
          <Card style={{ padding: 6 }}>
            <LinkRow
              icon={Plug}
              title="Connectors"
              detail="Website logins, email, WhatsApp, plugin config"
              onPress={() => navigate("connectors")}
            />
            <View style={s.divider} />
            <LinkRow
              icon={Shapes}
              title="Google & connected services"
              detail="Managed on the Apps tab under Connections"
              onPress={() => navigate("apps")}
            />
          </Card>
        </View>
      </View>

      {/* Security */}
      <View>
        <SectionHeading title="Security" />
        <View style={{ gap: 10 }}>
          <Card style={{ gap: 12 }}>
            <View style={[s.row, { gap: 12, alignItems: "center" }]}>
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  backgroundColor: colors.sky,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ fontSize: 16, fontWeight: "700", color: colors.blueDark }}>
                  {sessionUser.username.slice(0, 1).toUpperCase()}
                </Text>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[s.text, { fontWeight: "600" }]}>@{sessionUser.username}</Text>
                <Text style={[s.small, { textTransform: "capitalize" }]}>
                  {sessionUser.role} • Active login session
                </Text>
              </View>
              <Button icon={LogOut} danger small onPress={() => void logout()}>
                Log out
              </Button>
            </View>
          </Card>
          <Card style={{ padding: 6 }}>
            {isAdmin ? (
              <>
                <LinkRow
                  icon={Users}
                  title="Users & roles"
                  detail="Add users, reset passwords, set roles"
                  onPress={() => open({ type: "users" })}
                />
                <View style={s.divider} />
              </>
            ) : null}
            <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
              <Text style={s.small}>
                Passwords and API keys are write-only: encrypted on the server and never shown
                again. Changing your own password from the dashboard is a planned follow-up.
              </Text>
            </View>
          </Card>
        </View>
      </View>

      {/* Advanced */}
      <View>
        <SectionHeading title="Advanced" />
        <View style={{ gap: 10 }}>
          <HealthCard />
          <Card style={{ padding: 6 }}>
            <LinkRow
              icon={Cpu}
              title="Agent computer"
              detail="Inspect the agent's browser and terminal"
              onPress={() => open({ type: "computer" })}
            />
            <View style={s.divider} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear chat history"
              onPress={() => setShowClearHistory(true)}
              style={[s.row, { gap: 14, paddingHorizontal: 12, paddingVertical: 10 }]}
            >
              <Trash2 size={20} color={colors.danger} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[s.text, { color: colors.danger, fontWeight: "600" }]}>
                  Clear chat history
                </Text>
                <Text style={s.small}>Delete messages, photos and files forever</Text>
              </View>
            </Pressable>
          </Card>
        </View>
      </View>
      {showClearHistory && <ClearHistorySheet onClose={() => setShowClearHistory(false)} />}
    </View>
  );
}
