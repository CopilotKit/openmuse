import {
  AlertTriangle,
  Check,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import {
  Button,
  Card,
  CheckRow,
  colors,
  Empty,
  ErrorNotice,
  Field,
  SectionHeading,
  Sheet,
  s,
} from "../ui";
import {
  type ConnectionTest,
  type ConnectorsApi,
  type EmailAccountInput,
  type EmailAccountMeta,
  requestMessage,
} from "./api";

/**
 * Email accounts — list / add / edit / delete IMAP+SMTP accounts, plus a
 * "Test connection" check per account.
 *
 * SECURITY: the account password is write-only. It is sent only on create
 * and on explicit rotation; the server encrypts it in its vault before
 * storing and list responses carry host/port/username metadata and never
 * the secret. Test diagnostics are server-redacted and rendered as-is.
 * Nothing here renders, logs, or stores a password value.
 */
export function EmailSection({ api }: { api: ConnectorsApi }) {
  const [items, setItems] = useState<EmailAccountMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<EmailAccountMeta | null>(null);
  const [deleting, setDeleting] = useState<EmailAccountMeta | null>(null);
  const [tests, setTests] = useState<
    Record<string, { busy: boolean; result?: ConnectionTest; error?: string }>
  >({});

  async function load() {
    setLoading(true);
    setError("");
    try {
      setItems(await api.email.list());
    } catch (e) {
      setError(requestMessage(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate(values: EmailAccountInput) {
    const created = await api.email.create(values);
    setItems((prev) => [...prev, created]);
    setShowAdd(false);
  }

  async function handleUpdate(id: string, values: EmailFormValues) {
    const patch: Partial<EmailAccountInput> = {};
    const set = <K extends keyof EmailAccountInput>(key: K, value: EmailAccountInput[K]) => {
      patch[key] = value;
    };
    set("label", values.label);
    set("emailAddress", values.emailAddress);
    set("username", values.username);
    set("imapHost", values.imapHost);
    set("imapPort", values.imapPort);
    set("imapSecure", values.imapSecure);
    set("smtpHost", values.smtpHost);
    set("smtpPort", values.smtpPort);
    set("smtpSecure", values.smtpSecure);
    // Password rotation only when the field is filled in.
    if (values.password) set("password", values.password);
    const updated = await api.email.update(id, patch);
    setItems((prev) => prev.map((item) => (item.id === id ? updated : item)));
    setEditing(null);
  }

  async function handleDelete(id: string) {
    await api.email.remove(id);
    setItems((prev) => prev.filter((item) => item.id !== id));
    setDeleting(null);
  }

  async function runTest(id: string) {
    setTests((prev) => ({ ...prev, [id]: { busy: true } }));
    try {
      const result = await api.email.test(id);
      setTests((prev) => ({ ...prev, [id]: { busy: false, result } }));
    } catch (e) {
      setTests((prev) => ({ ...prev, [id]: { busy: false, error: requestMessage(e) } }));
    }
  }

  return (
    <View style={{ gap: 22 }}>
      <Card>
        <SectionHeading title="Email accounts" />
        <ErrorNotice error={error} />
        {loading ? (
          <Text style={s.muted}>Loading…</Text>
        ) : items.length === 0 ? (
          <Empty
            icon={Mail}
            title="No email accounts"
            detail="Connect an IMAP account for reading and an SMTP server for sending through the reviewed action flow. Quick setup prefills Gmail and Titan."
          >
            <Button primary icon={Plus} onPress={() => setShowAdd(true)}>
              Add account
            </Button>
          </Empty>
        ) : (
          <View>
            <View style={[s.row, { justifyContent: "flex-end", marginBottom: 6 }]}>
              <Button small primary icon={Plus} onPress={() => setShowAdd(true)}>
                Add account
              </Button>
            </View>
            {items.map((item, index) => (
              <AccountCard
                key={item.id}
                item={item}
                first={index === 0}
                test={tests[item.id]}
                onTest={() => void runTest(item.id)}
                onEdit={() => setEditing(item)}
                onDelete={() => setDeleting(item)}
              />
            ))}
          </View>
        )}
      </Card>

      <Card style={{ backgroundColor: colors.sky }}>
        <View style={[s.row, { gap: 12 }]}>
          <ShieldCheck size={22} color={colors.blueDark} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={s.heading}>Write-only password</Text>
            <Text style={s.muted}>
              The password is sent to the server only when you save or rotate it, encrypted in the
              server vault at rest, and never shown back. Sending happens only through the reviewed
              action flow — never directly from here.
            </Text>
          </View>
        </View>
      </Card>

      {showAdd && (
        <Sheet
          title="Add email account"
          subtitle="IMAP for reading, SMTP for sending (approved actions only)."
          onClose={() => setShowAdd(false)}
        >
          <EmailForm
            key="new"
            submitLabel="Save account"
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
          <EmailForm
            key={editing.id}
            submitLabel="Save changes"
            initial={editing}
            onSubmit={(values) => handleUpdate(editing.id, values)}
            onClose={() => setEditing(null)}
          />
        </Sheet>
      )}

      {deleting && (
        <Sheet
          title="Delete account?"
          subtitle={`${deleting.label} · ${deleting.emailAddress}`}
          onClose={() => setDeleting(null)}
        >
          <Text style={[s.text, { marginBottom: 20 }]}>
            This removes the account immediately. Chat tools that fall back to IMAP will no longer
            use it.
          </Text>
          <View style={[s.row, { gap: 10, justifyContent: "flex-end" }]}>
            <Button onPress={() => setDeleting(null)}>Cancel</Button>
            <Button danger icon={Trash2} onPress={() => void handleDelete(deleting.id)}>
              Delete
            </Button>
          </View>
        </Sheet>
      )}
    </View>
  );
}

function AccountCard({
  item,
  first,
  test,
  onTest,
  onEdit,
  onDelete,
}: {
  item: EmailAccountMeta;
  first: boolean;
  test?: { busy: boolean; result?: ConnectionTest; error?: string };
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <View
      style={{
        paddingVertical: 16,
        gap: 12,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: colors.line,
      }}
    >
      <View style={[s.between]}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={s.heading}>{item.label}</Text>
          <Text style={s.muted} numberOfLines={1}>
            {item.emailAddress}
          </Text>
          <Text style={s.small} numberOfLines={1}>
            IMAP {item.imap.host}:{item.imap.port} · SMTP {item.smtp.host}:{item.smtp.port}
          </Text>
        </View>
      </View>
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Button small primary icon={RefreshCw} busy={!!test?.busy} onPress={onTest}>
          Test connection
        </Button>
        <Button small icon={Pencil} onPress={onEdit}>
          Edit
        </Button>
        <Button small danger icon={Trash2} onPress={onDelete}>
          Delete
        </Button>
      </View>
      {test?.error ? <ErrorNotice error={test.error} /> : null}
      {test?.result ? <ConnectionResult result={test.result} /> : null}
    </View>
  );
}

function ConnectionResult({ result }: { result: ConnectionTest }) {
  const rows: { name: string; ok: boolean; detail?: string }[] = [
    { name: "IMAP login", ok: result.imap, detail: result.imapDetail },
    { name: "SMTP handshake", ok: result.smtp, detail: result.smtpDetail },
  ];
  return (
    <View
      style={{
        gap: 10,
        padding: 14,
        borderRadius: 14,
        backgroundColor: colors.canvas,
        borderWidth: 1,
        borderColor: colors.line,
      }}
    >
      {rows.map((row) => (
        <View key={row.name} style={[s.row, { gap: 10, alignItems: "flex-start" }]}>
          {row.ok ? <Check size={16} color={colors.text} /> : <X size={16} color={colors.danger} />}
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[s.text, { fontWeight: "600", fontSize: 14, lineHeight: 20 }]}>
              {row.name} {row.ok ? "succeeded" : "failed"}
            </Text>
            {!row.ok && row.detail ? <Text style={s.small}>{row.detail}</Text> : null}
          </View>
        </View>
      ))}
    </View>
  );
}

interface EmailFormValues {
  label: string;
  emailAddress: string;
  username: string;
  /** Write-only; blank means "keep the current password" on edit. */
  password: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

/**
 * One-tap host/port presets for the two accounts people actually onboard.
 * Only hosts, ports, and TLS modes are prefilled — the password is always
 * typed by the user and goes straight to the encrypted vault.
 */
const PROVIDER_PRESETS = [
  {
    id: "gmail",
    label: "Gmail",
    hint: "Use a Gmail app password, not your login password: Google Account → Security → 2-Step Verification → App passwords. Username is your full Gmail address.",
    values: {
      imapHost: "imap.gmail.com",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "smtp.gmail.com",
      smtpPort: 465,
      smtpSecure: true,
    },
  },
  {
    id: "titan",
    label: "Titan",
    hint: "Titan Mail: your full email address as the username; IMAP imap.titan.email and SMTP smtp.titan.email are prefilled below.",
    values: {
      imapHost: "imap.titan.email",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "smtp.titan.email",
      smtpPort: 465,
      smtpSecure: true,
    },
  },
] as const;

function EmailForm({
  initial,
  submitLabel,
  onSubmit,
  onClose,
}: {
  initial?: EmailAccountMeta;
  submitLabel: string;
  onSubmit: (values: EmailFormValues) => Promise<void>;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [emailAddress, setEmailAddress] = useState(initial?.emailAddress ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [password, setPassword] = useState("");
  const [imapHost, setImapHost] = useState(initial?.imap.host ?? "");
  const [imapPort, setImapPort] = useState(String(initial?.imap.port ?? 993));
  const [imapSecure, setImapSecure] = useState(initial?.imap.secure ?? true);
  const [smtpHost, setSmtpHost] = useState(initial?.smtp.host ?? "");
  const [smtpPort, setSmtpPort] = useState(String(initial?.smtp.port ?? 465));
  const [smtpSecure, setSmtpSecure] = useState(initial?.smtp.secure ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [presetId, setPresetId] = useState<string | null>(null);

  function applyPreset(preset: (typeof PROVIDER_PRESETS)[number]) {
    setImapHost(preset.values.imapHost);
    setImapPort(String(preset.values.imapPort));
    setImapSecure(preset.values.imapSecure);
    setSmtpHost(preset.values.smtpHost);
    setSmtpPort(String(preset.values.smtpPort));
    setSmtpSecure(preset.values.smtpSecure);
    // Gmail and Titan both authenticate with the full email address.
    if (emailAddress.trim() && !username.trim()) setUsername(emailAddress.trim());
    setPresetId(preset.id);
  }

  function parsePort(raw: string): number | null {
    const value = Number(raw.trim());
    return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
  }

  const imapPortParsed = parsePort(imapPort);
  const smtpPortParsed = parsePort(smtpPort);
  const valid =
    label.trim() &&
    emailAddress.trim() &&
    username.trim() &&
    imapHost.trim() &&
    imapPortParsed !== null &&
    smtpHost.trim() &&
    smtpPortParsed !== null &&
    (!!initial || password);

  async function submit() {
    setError("");
    setBusy(true);
    try {
      await onSubmit({
        label: label.trim(),
        emailAddress: emailAddress.trim(),
        username: username.trim(),
        password,
        imapHost: imapHost.trim(),
        imapPort: imapPortParsed as number,
        imapSecure,
        smtpHost: smtpHost.trim(),
        smtpPort: smtpPortParsed as number,
        smtpSecure,
      });
      // Parent closes the sheet on success, discarding the password state.
    } catch (e) {
      setError(requestMessage(e));
      setBusy(false);
    }
  }

  const activePreset = PROVIDER_PRESETS.find((preset) => preset.id === presetId);

  return (
    <View>
      {!initial && (
        <View style={{ marginBottom: 14 }}>
          <Text style={[s.label, { marginBottom: 8 }]}>Quick setup</Text>
          <View style={[s.row, { gap: 8 }]}>
            {PROVIDER_PRESETS.map((preset) => (
              <Button
                key={preset.id}
                small
                primary={presetId === preset.id}
                onPress={() => applyPreset(preset)}
              >
                {preset.label}
              </Button>
            ))}
          </View>
          {activePreset && <Text style={[s.small, { marginTop: 6 }]}>{activePreset.hint}</Text>}
        </View>
      )}
      <Field label="Label" value={label} onChangeText={setLabel} placeholder="Work" />
      <Field
        label="Email address"
        value={emailAddress}
        onChangeText={setEmailAddress}
        placeholder="you@example.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
      />
      <Field
        label="Username"
        value={username}
        onChangeText={setUsername}
        placeholder="you@example.com"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Field
        label={initial ? "Password (leave blank to keep)" : "Password"}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={[s.label, { marginBottom: 10, marginTop: 10 }]}>IMAP (reading)</Text>
      <Field
        label="IMAP host"
        value={imapHost}
        onChangeText={setImapHost}
        placeholder="imap.example.com"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Field
        label="IMAP port"
        value={imapPort}
        onChangeText={setImapPort}
        placeholder="993"
        keyboardType="number-pad"
      />
      <CheckRow
        label="Use implicit TLS (uncheck for STARTTLS)"
        checked={imapSecure}
        onPress={() => setImapSecure((value) => !value)}
      />

      <Text style={[s.label, { marginBottom: 10, marginTop: 14 }]}>SMTP (sending)</Text>
      <Field
        label="SMTP host"
        value={smtpHost}
        onChangeText={setSmtpHost}
        placeholder="smtp.example.com"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Field
        label="SMTP port"
        value={smtpPort}
        onChangeText={setSmtpPort}
        placeholder="465"
        keyboardType="number-pad"
      />
      <CheckRow
        label="Use implicit TLS (uncheck for STARTTLS)"
        checked={smtpSecure}
        onPress={() => setSmtpSecure((value) => !value)}
      />

      <View style={[s.row, { gap: 8, marginTop: 8 }]}>
        <AlertTriangle size={14} color={colors.muted} />
        <Text style={[s.small, { flex: 1 }]}>
          Test the connection after saving — bad ports and TLS modes are the most common mistakes.
        </Text>
      </View>

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
