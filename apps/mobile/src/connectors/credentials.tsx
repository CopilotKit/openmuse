import {
  Check,
  Globe2,
  KeyRound,
  LogIn,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { BrowserSession } from "../../../../packages/domain/src";
import {
  Button,
  Card,
  Chip,
  colors,
  Empty,
  ErrorNotice,
  Field,
  relativeDate,
  SectionHeading,
  Sheet,
  s,
} from "../ui";
import {
  type ConnectorsApi,
  type CredentialMeta,
  type LoginReceipt,
  requestMessage,
  sessionMatchesDomain,
} from "./api";

/**
 * Website logins — list / add / edit / delete saved browser credentials,
 * plus "Log in" which fills the credential into an open browser session.
 *
 * SECURITY: passwords are write-only. They travel to the server only on
 * create and on explicit rotation; list responses carry usernameHint
 * (redacted) and never a secret. Nothing here renders, logs, or stores
 * a password value.
 */
export function CredentialsSection({
  api,
  browsers,
  onOpenBrowser,
}: {
  api: ConnectorsApi;
  browsers: BrowserSession[];
  onOpenBrowser: (browser: BrowserSession) => void;
}) {
  const [items, setItems] = useState<CredentialMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<CredentialMeta | null>(null);
  const [deleting, setDeleting] = useState<CredentialMeta | null>(null);
  const [picking, setPicking] = useState<CredentialMeta | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      setItems(await api.credentials.list());
    } catch (e) {
      setError(requestMessage(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate(values: CredentialValues) {
    const created = await api.credentials.create(values);
    setItems((prev) => [...prev, created]);
    setShowAdd(false);
  }

  async function handleUpdate(id: string, values: CredentialValues) {
    const patch: Record<string, string> = {
      label: values.label,
      domain: values.domain,
      username: values.username,
    };
    // Password rotation only when the field is filled in.
    if (values.password) patch.password = values.password;
    const updated = await api.credentials.update(id, patch);
    setItems((prev) => prev.map((item) => (item.id === id ? updated : item)));
    setEditing(null);
  }

  async function handleDelete(id: string) {
    await api.credentials.remove(id);
    setItems((prev) => prev.filter((item) => item.id !== id));
    setDeleting(null);
  }

  return (
    <View style={{ gap: 22 }}>
      <Card>
        <SectionHeading title="Website logins" />
        <ErrorNotice error={error} />
        {loading ? (
          <Text style={s.muted}>Loading…</Text>
        ) : items.length === 0 ? (
          <Empty
            icon={KeyRound}
            title="No website logins"
            detail="Save a login once and the agent can sign browser sessions in with it, without ever seeing the password."
          >
            <Button primary icon={Plus} onPress={() => setShowAdd(true)}>
              Add login
            </Button>
          </Empty>
        ) : (
          <View>
            <View style={[s.row, { justifyContent: "flex-end", marginBottom: 6 }]}>
              <Button small primary icon={Plus} onPress={() => setShowAdd(true)}>
                Add login
              </Button>
            </View>
            {items.map((item, index) => (
              <View
                key={item.id}
                style={{
                  paddingVertical: 16,
                  gap: 12,
                  borderTopWidth: index === 0 ? 0 : 1,
                  borderTopColor: colors.line,
                }}
              >
                <View style={[s.between]}>
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={s.heading}>{item.label}</Text>
                    <Text style={s.muted} numberOfLines={1}>
                      {item.usernameHint} · {item.domain}
                    </Text>
                  </View>
                  {item.lastUsedAt ? (
                    <Chip>Used {relativeDate(item.lastUsedAt)}</Chip>
                  ) : (
                    <Chip>Never used</Chip>
                  )}
                </View>
                <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
                  <Button small primary icon={LogIn} onPress={() => setPicking(item)}>
                    Log in
                  </Button>
                  <Button small icon={Pencil} onPress={() => setEditing(item)}>
                    Edit
                  </Button>
                  <Button small danger icon={Trash2} onPress={() => setDeleting(item)}>
                    Delete
                  </Button>
                </View>
              </View>
            ))}
          </View>
        )}
      </Card>

      <Card style={{ backgroundColor: colors.sky }}>
        <View style={[s.row, { gap: 12 }]}>
          <ShieldCheck size={22} color={colors.blueDark} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={s.heading}>Write-only passwords</Text>
            <Text style={s.muted}>
              Passwords are sent to the server only when you save or rotate one. They are encrypted
              at rest, never shown back, and each login is locked to its own domain.
            </Text>
          </View>
        </View>
      </Card>

      {showAdd && (
        <Sheet
          title="Add website login"
          subtitle="The password is encrypted on the server and never shown again."
          onClose={() => setShowAdd(false)}
        >
          <CredentialForm
            key="new"
            submitLabel="Save login"
            onSubmit={handleCreate}
            onClose={() => setShowAdd(false)}
          />
        </Sheet>
      )}

      {editing && (
        <Sheet
          title={`Edit · ${editing.label}`}
          subtitle="Leave the password blank to keep the current one."
          onClose={() => setEditing(null)}
        >
          <CredentialForm
            key={editing.id}
            submitLabel="Save changes"
            initial={editing}
            passwordHint="New password (optional — rotate)"
            onSubmit={(values) => handleUpdate(editing.id, values)}
            onClose={() => setEditing(null)}
          />
        </Sheet>
      )}

      {deleting && (
        <Sheet
          title="Delete login?"
          subtitle={`${deleting.label} · ${deleting.domain}`}
          onClose={() => setDeleting(null)}
        >
          <Text style={[s.text, { marginBottom: 20 }]}>
            This removes the saved login immediately. The agent will no longer be able to sign in
            with it.
          </Text>
          <View style={[s.row, { gap: 10, justifyContent: "flex-end" }]}>
            <Button onPress={() => setDeleting(null)}>Cancel</Button>
            <Button danger icon={Trash2} onPress={() => void handleDelete(deleting.id)}>
              Delete
            </Button>
          </View>
        </Sheet>
      )}

      {picking && (
        <SessionPicker
          key={picking.id}
          credential={picking}
          sessions={browsers}
          api={api}
          onLoggedIn={() => void load()}
          onOpenBrowser={onOpenBrowser}
          onClose={() => setPicking(null)}
        />
      )}
    </View>
  );
}

interface CredentialValues {
  label: string;
  domain: string;
  username: string;
  /** Write-only; blank means "keep the current password" on edit. */
  password: string;
}

function CredentialForm({
  initial,
  submitLabel,
  passwordHint = "Password",
  onSubmit,
  onClose,
}: {
  initial?: CredentialMeta;
  submitLabel: string;
  passwordHint?: string;
  onSubmit: (values: CredentialValues) => Promise<void>;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [domain, setDomain] = useState(initial?.domain ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The username is redacted in list metadata; it is re-entered here rather
  // than derived, so no decrypted value ever passes through this form.

  const valid = label.trim() && domain.trim() && username.trim() && (!!initial || password);

  async function submit() {
    setError("");
    setBusy(true);
    try {
      await onSubmit({
        label: label.trim(),
        domain: domain.trim(),
        username: username.trim(),
        password,
      });
      // Parent closes the sheet on success, discarding the password state.
    } catch (e) {
      setError(requestMessage(e));
      setBusy(false);
    }
  }

  return (
    <View>
      <Field label="Label" value={label} onChangeText={setLabel} placeholder="My bank" />
      <Field
        label="Domain"
        value={domain}
        onChangeText={setDomain}
        placeholder="accounts.example.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <Field
        label="Username"
        value={username}
        onChangeText={setUsername}
        placeholder={initial ? "Re-enter username to change it" : "you@example.com"}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Field
        label={passwordHint}
        value={password}
        onChangeText={setPassword}
        placeholder={initial ? "Leave blank to keep the current password" : undefined}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      <ErrorNotice error={error} />
      <View style={[s.row, { gap: 10, justifyContent: "flex-end", marginTop: 6 }]}>
        <Button onPress={onClose}>Cancel</Button>
        <Button primary busy={busy} disabled={!valid} onPress={() => void submit()}>
          {submitLabel}
        </Button>
      </View>
    </View>
  );
}

/** Pick an open browser session to fill the credential into (POST /:id/login). */
function SessionPicker({
  credential,
  sessions,
  api,
  onLoggedIn,
  onOpenBrowser,
  onClose,
}: {
  credential: CredentialMeta;
  sessions: BrowserSession[];
  api: ConnectorsApi;
  onLoggedIn: () => void;
  onOpenBrowser: (browser: BrowserSession) => void;
  onClose: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<LoginReceipt | null>(null);
  const [newSession, setNewSession] = useState<BrowserSession | null>(null);

  const openSessions = useMemo(
    () => sessions.filter((session) => session.status !== "closed" && session.url),
    [sessions],
  );
  const sorted = useMemo(
    () =>
      [...openSessions].sort((a, b) => {
        const am = sessionMatchesDomain(a.url, credential.domain) ? 0 : 1;
        const bm = sessionMatchesDomain(b.url, credential.domain) ? 0 : 1;
        return am - bm;
      }),
    [openSessions, credential.domain],
  );

  async function loginInto(sessionId: string) {
    setError("");
    setBusyId(sessionId);
    try {
      const result = await api.credentials.login(credential.id, sessionId);
      setReceipt(result);
      onLoggedIn();
    } catch (e) {
      // 403 means the session isn't on this credential's domain; 409 means
      // the session has no usable page URL. The message is server-safe.
      setError(requestMessage(e));
    } finally {
      setBusyId(null);
    }
  }

  async function openFreshSession() {
    setError("");
    setCreating(true);
    try {
      // Open a session directly on the credential's domain, then fill it.
      const browser = await api.browsers.open(`https://${credential.domain}`);
      setNewSession(browser);
      await loginInto(browser.id);
      setCreating(false);
    } catch (e) {
      setError(requestMessage(e));
      setCreating(false);
    }
  }

  return (
    <Sheet
      title={`Log in · ${credential.label}`}
      subtitle={`Fills into a browser session open on ${credential.domain}`}
      onClose={onClose}
    >
      {receipt ? (
        <View style={{ gap: 16, alignItems: "center", paddingVertical: 12 }}>
          <View
            style={[
              s.iconBox,
              { backgroundColor: colors.green, width: 55, height: 55, borderRadius: 18 },
            ]}
          >
            <Check size={26} color={colors.text} />
          </View>
          <View style={{ gap: 4, alignItems: "center" }}>
            <Text style={s.heading}>Signed in</Text>
            <Text style={[s.muted, { textAlign: "center" }]}>
              {receipt.label} was filled into {receipt.hostname}. The sign-in was logged to your
              activity feed.
            </Text>
          </View>
          {newSession && (
            <Button primary onPress={() => onOpenBrowser(newSession)}>
              View browser session
            </Button>
          )}
          <Button onPress={onClose}>Done</Button>
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          <Text style={s.muted}>
            Choose an open session on <Text style={{ fontWeight: "600" }}>{credential.domain}</Text>
            . The login is refused on any other domain.
          </Text>
          {sorted.map((session) => {
            const matches = sessionMatchesDomain(session.url, credential.domain);
            return (
              <Pressable
                key={session.id}
                accessibilityRole="button"
                disabled={busyId !== null}
                onPress={() => void loginInto(session.id)}
                style={({ pressed }) => [
                  s.row,
                  {
                    gap: 14,
                    paddingVertical: 12,
                    paddingHorizontal: 12,
                    borderRadius: 14,
                    borderWidth: 1,
                    borderColor: colors.line,
                    opacity: busyId !== null && busyId !== session.id ? 0.5 : 1,
                  },
                  pressed && { backgroundColor: colors.canvas },
                ]}
              >
                <View style={s.iconBox}>
                  <Globe2 size={19} color={colors.text} />
                </View>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={[s.text, { fontWeight: "500" }]} numberOfLines={1}>
                    {busyId === session.id ? "Signing in…" : session.title || "Browser session"}
                  </Text>
                  <Text style={s.small} numberOfLines={1}>
                    {session.url}
                  </Text>
                </View>
                {matches ? <Chip tint={colors.green}>domain match</Chip> : null}
              </Pressable>
            );
          })}
          {sorted.length === 0 && <Text style={s.muted}>No open browser sessions right now.</Text>}
          <View style={{ marginTop: 8 }}>
            <Button primary busy={creating} onPress={() => void openFreshSession()}>
              Open new session on {credential.domain}
            </Button>
          </View>
          <ErrorNotice error={error} />
        </View>
      )}
    </Sheet>
  );
}
