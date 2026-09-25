import {
  AlertTriangle,
  Check,
  LogOut,
  MessageCircle,
  Plus,
  QrCode as QrCodeIcon,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react-native";
import qrcode from "qrcode-generator";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Rect, Svg } from "react-native-svg";
import { Button, Card, Chip, colors, Empty, ErrorNotice, Field, SectionHeading, s } from "../ui";
import {
  type ConnectorsApi,
  requestMessage,
  type WhatsAppPairingStatus,
  type WhatsAppQr,
  type WhatsAppRule,
  type WhatsAppStatus,
} from "./api";

/**
 * WhatsApp (personal, Baileys) — pairing, rules, and session controls.
 *
 * SECURITY / RISK:
 * - Pairing is refused by the server until the user explicitly opts in to
 *   the unofficial-client ban risk (the banner below). The opt-in states
 *   the risk and recommends a secondary number — never the main number.
 * - The QR is a raw short-lived string rendered here with qrcode-generator;
 *   it is never logged or stored client-side.
 * - Logout wipes the encrypted session; "reset" also wipes rules + consent.
 * - There is no send box here on purpose: outbound WhatsApp messages go
 *   only through the reviewed action flow (whatsapp.send proposals).
 */

const BAN_WARNING =
  "This connects WhatsApp through an unofficial client (Baileys). Meta detects unofficial clients and bans the number — usually a temporary ban first, then a permanent one. Use a secondary number, never your main business number. The Cloud API business inbox stays the safe path.";

function QrCode({ value, size }: { value: string; size: number }) {
  const cells = useMemo(() => {
    const code = qrcode(0, "M");
    code.addData(value, "Byte");
    code.make();
    const count = code.getModuleCount();
    const cell = size / count;
    const rects: ReactNode[] = [];
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (code.isDark(row, col)) {
          rects.push(
            <Rect
              key={`${row}-${col}`}
              x={col * cell}
              y={row * cell}
              width={cell + 0.5}
              height={cell + 0.5}
              fill="#111"
            />,
          );
        }
      }
    }
    return rects;
  }, [value, size]);
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Rect x={0} y={0} width={size} height={size} fill="#fff" />
      {cells}
    </Svg>
  );
}

const STATUS_LABEL: Record<WhatsAppPairingStatus, string> = {
  not_paired: "Not paired",
  pairing: "Pairing…",
  connected: "Connected",
  needs_repair: "Needs re-pairing",
  disabled: "Disabled",
};

const STATUS_TINT: Record<WhatsAppPairingStatus, string> = {
  not_paired: colors.line,
  pairing: colors.lavender,
  connected: colors.green,
  needs_repair: colors.danger,
  disabled: colors.line,
};

function RuleRow({
  rule,
  onDelete,
}: {
  rule: WhatsAppRule;
  onDelete: (rule: WhatsAppRule) => void;
}) {
  return (
    <View style={[s.row, { gap: 10, paddingVertical: 9 }]}>
      <Chip tint={rule.action === "allow" ? colors.green : colors.danger}>
        {rule.action === "allow" ? "Allow" : "Deny"}
      </Chip>
      <View style={{ flex: 1, gap: 2 }}>
        <Text selectable style={s.text}>
          {rule.jid}
        </Text>
        {rule.label ? <Text style={s.small}>{rule.label}</Text> : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove rule for ${rule.jid}`}
        onPress={() => onDelete(rule)}
        style={{ padding: 6 }}
      >
        <Trash2 size={15} color={colors.muted} />
      </Pressable>
    </View>
  );
}

export function WhatsAppSection({ api }: { api: ConnectorsApi }) {
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [rules, setRules] = useState<WhatsAppRule[]>([]);
  const [qr, setQr] = useState<WhatsAppQr | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newJid, setNewJid] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newAction, setNewAction] = useState<"allow" | "deny">("allow");
  const [showAdd, setShowAdd] = useState(false);
  const [deleting, setDeleting] = useState<WhatsAppRule | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextStatus, nextRules] = await Promise.all([
        api.whatsapp.status(),
        api.whatsapp.rules.list().catch(() => [] as WhatsAppRule[]),
      ]);
      setStatus(nextStatus);
      setRules(nextRules);
    } catch (e) {
      setError(requestMessage(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.whatsapp.status());
    } catch (e) {
      setError(requestMessage(e));
    }
  }, [api]);

  // Poll the QR while a pairing attempt is live. The QR is a short-lived
  // string; polling stops the moment the status moves off "pairing".
  useEffect(() => {
    if (status?.status !== "pairing") {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      setQr(null);
      return;
    }
    let live = true;
    const fetch = async () => {
      try {
        const next = await api.whatsapp.qr();
        if (live) setQr(next);
        if (next.status !== "pairing") void refreshStatus();
      } catch {
        // Transient; the next tick retries.
      }
    };
    void fetch();
    pollRef.current = setInterval(() => void fetch(), 3000);
    return () => {
      live = false;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [api, status?.status, refreshStatus]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(requestMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const addRule = async () => {
    const jid = newJid.trim();
    if (!jid) {
      setError("Enter a JID like 15551234567@s.whatsapp.net (a group ends in @g.us).");
      return;
    }
    await run(async () => {
      await api.whatsapp.rules.create({
        jid,
        action: newAction,
        label: newLabel.trim() || undefined,
      });
      setNewJid("");
      setNewLabel("");
      setNewAction("allow");
      setShowAdd(false);
    });
  };

  if (loading && !status) return <Text style={s.muted}>Loading WhatsApp…</Text>;

  const consented = status?.consented === true;

  return (
    <View style={{ gap: 16 }}>
      <ErrorNotice error={error} />

      {!consented && (
        <Card style={{ borderColor: colors.danger, borderWidth: 1, gap: 12 }}>
          <View style={[s.row, { gap: 10 }]}>
            <ShieldAlert size={20} color={colors.danger} />
            <Text style={[s.heading, { color: colors.danger }]}>Ban risk — opt in to pair</Text>
          </View>
          <Text style={[s.text, { lineHeight: 23 }]}>{BAN_WARNING}</Text>
          <Button
            primary
            icon={ShieldCheck}
            busy={busy}
            onPress={() => void run(() => api.whatsapp.consent(true))}
          >
            I understand the risk — enable pairing
          </Button>
        </Card>
      )}

      {status && (
        <Card style={{ gap: 10 }}>
          <SectionHeading title="Session" />
          <View style={[s.row, { gap: 10, alignItems: "center" }]}>
            <Chip tint={STATUS_TINT[status.status]}>{STATUS_LABEL[status.status]}</Chip>
            {status.jid ? (
              <Text selectable style={[s.text, { flex: 1 }]}>
                {status.jid}
              </Text>
            ) : null}
          </View>
          {status.lastSeenAt ? (
            <Text style={s.small}>Last seen {new Date(status.lastSeenAt).toLocaleString()}</Text>
          ) : null}
          <Text style={s.small}>Updated {new Date(status.updatedAt).toLocaleString()}</Text>
          {status.status === "needs_repair" && (
            <Text style={[s.text, { color: colors.danger, lineHeight: 22 }]}>
              WhatsApp logged this session out. Pair again to reconnect — nothing is sent until you
              do.
            </Text>
          )}
        </Card>
      )}

      {consented && status && status.status !== "connected" && (
        <Card style={{ gap: 12 }}>
          <SectionHeading title="Pair a number" />
          {status.status === "pairing" && qr?.qr ? (
            <View style={{ gap: 12, alignItems: "center" }}>
              <QrCode value={qr.qr} size={232} />
              <Text style={[s.small, { textAlign: "center", lineHeight: 20 }]}>
                Scan with WhatsApp → Settings → Linked devices → Link a device.
                {qr.expiresAt
                  ? ` This code expires ${new Date(qr.expiresAt).toLocaleTimeString()}.`
                  : ""}
              </Text>
              <Button
                icon={X}
                busy={busy}
                onPress={() => void run(() => api.whatsapp.stopPairing())}
              >
                Cancel pairing
              </Button>
            </View>
          ) : (
            <View style={{ gap: 12 }}>
              <Text style={[s.text, { lineHeight: 23 }]}>
                {status.status === "needs_repair"
                  ? "Start a fresh pairing to reconnect this number."
                  : "Link a secondary WhatsApp number. A QR appears here after you start."}
              </Text>
              <Button
                primary
                icon={QrCodeIcon}
                busy={busy}
                onPress={() => void run(() => api.whatsapp.startPairing())}
              >
                {status.status === "needs_repair" ? "Pair again" : "Start pairing"}
              </Button>
            </View>
          )}
        </Card>
      )}

      {consented && (
        <Card style={{ gap: 8 }}>
          <SectionHeading
            title="Who the agent hears"
            action={showAdd ? undefined : "Add rule"}
            onPress={showAdd ? undefined : () => setShowAdd(true)}
          />
          <Text style={[s.small, { lineHeight: 20, marginBottom: 4 }]}>
            Unknown senders are ignored by default. Allow a chat and its messages reach the agent;
            deny wins over allow.
          </Text>
          {rules.length === 0 && !showAdd ? (
            <Empty
              icon={MessageCircle}
              title="No rules yet"
              detail="Every inbound message is ignored until you allow its sender."
            />
          ) : (
            rules.map((rule) => <RuleRow key={rule.id} rule={rule} onDelete={setDeleting} />)
          )}
          {showAdd && (
            <View style={{ gap: 10, marginTop: 6 }}>
              <Field
                label="JID"
                value={newJid}
                onChangeText={setNewJid}
                placeholder="15551234567@s.whatsapp.net"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Field
                label="Label (optional)"
                value={newLabel}
                onChangeText={setNewLabel}
                placeholder="Who is this?"
              />
              <View style={[s.row, { gap: 8 }]}>
                {(["allow", "deny"] as const).map((action) => (
                  <Pressable
                    key={action}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: newAction === action }}
                    onPress={() => setNewAction(action)}
                    style={[
                      s.row,
                      {
                        gap: 6,
                        paddingVertical: 8,
                        paddingHorizontal: 12,
                        borderRadius: 8,
                        borderWidth: 1,
                        borderColor: newAction === action ? colors.text : colors.line,
                        backgroundColor: newAction === action ? colors.text : "#FFF",
                      },
                    ]}
                  >
                    {newAction === action && <Check size={13} color="#FFF" />}
                    <Text
                      style={[
                        s.small,
                        { color: newAction === action ? "#FFF" : colors.text, fontWeight: "600" },
                      ]}
                    >
                      {action === "allow" ? "Allow" : "Deny"}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <View style={[s.row, { gap: 8 }]}>
                <Button primary icon={Plus} busy={busy} onPress={() => void addRule()}>
                  Add rule
                </Button>
                <Button onPress={() => setShowAdd(false)}>Cancel</Button>
              </View>
            </View>
          )}
          {deleting && (
            <Card style={{ gap: 10, marginTop: 6 }}>
              <Text style={s.text}>
                Remove the {deleting.action} rule for {deleting.jid}?
              </Text>
              <View style={[s.row, { gap: 8 }]}>
                <Button
                  danger
                  icon={Trash2}
                  busy={busy}
                  onPress={() =>
                    void run(async () => {
                      await api.whatsapp.rules.remove(deleting.id);
                      setDeleting(null);
                    })
                  }
                >
                  Remove
                </Button>
                <Button onPress={() => setDeleting(null)}>Keep</Button>
              </View>
            </Card>
          )}
        </Card>
      )}

      {consented && status && status.status !== "not_paired" && (
        <Card style={{ gap: 12 }}>
          <SectionHeading title="Session controls" />
          {status.status === "connected" && (
            <Button icon={LogOut} busy={busy} onPress={() => void run(() => api.whatsapp.logout())}>
              Log out of WhatsApp
            </Button>
          )}
          {!confirmReset ? (
            <Button icon={AlertTriangle} onPress={() => setConfirmReset(true)}>
              Disconnect and reset everything
            </Button>
          ) : (
            <View style={{ gap: 10 }}>
              <Text style={[s.text, { color: colors.danger, lineHeight: 22 }]}>
                This wipes the session, the rules, and the pairing state. Inbox history is kept.
                Continue?
              </Text>
              <View style={[s.row, { gap: 8 }]}>
                <Button
                  danger
                  icon={Trash2}
                  busy={busy}
                  onPress={() =>
                    void run(async () => {
                      await api.whatsapp.reset();
                      setConfirmReset(false);
                    })
                  }
                >
                  Reset everything
                </Button>
                <Button onPress={() => setConfirmReset(false)}>Keep</Button>
              </View>
            </View>
          )}
          <Button small icon={RefreshCw} busy={loading} onPress={() => void load()}>
            Refresh status
          </Button>
        </Card>
      )}
    </View>
  );
}
