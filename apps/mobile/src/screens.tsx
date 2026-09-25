import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import {
  Archive,
  ArrowDownToLine,
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  Folder,
  Globe2,
  Inbox,
  KeyRound,
  Link2,
  type LucideIcon,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Users,
} from "lucide-react-native";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  Pressable,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import type {
  Artifact,
  BrowserSession,
  CalendarEvent,
  Mail as DomainMail,
  EmailDraft,
} from "../../../packages/domain/src";
import { API_URL, type MuseApi } from "./api";
import { localDateTime, zonedInstant } from "./date-time";
import { setMascotSource, useActivityMascot } from "./mascot-state";
import { ModelSettingsScreen } from "./model-settings";
import { RestartBrowserButton } from "./restart-browser";
import {
  addShortcut,
  type ChatShortcut,
  deleteShortcut,
  ensureShortcutsLoaded,
  getShortcutsSnapshot,
  subscribeShortcuts,
  updateShortcut,
} from "./shortcuts";
import {
  Button,
  Card,
  Chip,
  colors,
  dateLabel,
  Empty,
  ErrorNotice,
  Field,
  IconButton,
  LinkRow,
  Mascot,
  relativeDate,
  resultSummary,
  SectionHeading,
  Sheet,
  s,
  timeLabel,
} from "./ui";
import { useWorkspace } from "./workspace";

function todayDate() {
  return localDateTime(new Date().toISOString(), Intl.DateTimeFormat().resolvedOptions().timeZone)
    .date;
}
function eventDate(event: CalendarEvent) {
  return event.allDay ? event.start : localDateTime(event.start, event.timeZone).date;
}
export function TodayScreen() {
  const { workspace: w, navigate, open, ask } = useWorkspace();
  const wide = useWindowDimensions().width > 1180;
  const pending = w.actions.filter((a) => a.status === "awaiting_review");
  const unread = w.mail.filter((m) => m.unread);
  const today = todayDate();
  const events = w.events
    .filter((e) => eventDate(e) === today)
    .sort((a, b) => a.start.localeCompare(b.start));
  return (
    <View style={{ gap: 22 }}>
      <View
        style={[
          {
            backgroundColor: "#E8F2F8",
            borderRadius: 24,
            padding: 32,
            minHeight: 228,
            overflow: "hidden",
          },
          s.row,
        ]}
      >
        <View style={{ flex: 1, gap: 15, zIndex: 1 }}>
          <View style={[s.row, { gap: 7 }]}>
            <Sparkles size={13} color={colors.blueDark} />
            <Text style={[s.label, { color: colors.blueDark }]}>A little clarity, every day</Text>
          </View>
          <Text
            style={{
              fontSize: wide ? 39 : 29,
              lineHeight: wide ? 45 : 36,
              letterSpacing: -1.7,
              fontWeight: "500",
              color: colors.text,
            }}
          >
            Your day, with a little{"\n"}more room to breathe.
          </Text>
          <Text style={[s.muted, { maxWidth: 420, color: "#617680" }]}>
            {events.length ? `${events.length} things on your calendar` : "Your calendar has room"}
            {unread.length ? `, ${unread.length} unread emails` : ""}.{"\n"}Let’s make space for
            what matters.
          </Text>
          <Button
            onPress={() => ask("Help me plan my day")}
            icon={Sparkles}
            primary
            style={{ alignSelf: "flex-start", marginTop: 5 }}
          >
            Plan my day
          </Button>
        </View>
        {wide && (
          <View style={{ width: 220, height: 210, alignItems: "center", justifyContent: "center" }}>
            <View
              style={{
                position: "absolute",
                width: 190,
                height: 190,
                borderRadius: 100,
                backgroundColor: "#DAEAF2",
              }}
            />
            <View
              style={{
                position: "absolute",
                width: 145,
                height: 145,
                borderRadius: 80,
                borderWidth: 1,
                borderColor: "#C8DBE6",
              }}
            />
            <Mascot size={130} />
            <View
              style={[
                s.row,
                {
                  position: "absolute",
                  top: 17,
                  left: -19,
                  padding: 11,
                  gap: 7,
                  backgroundColor: "#FFF",
                  borderRadius: 13,
                  transform: [{ rotate: "-7deg" }],
                },
              ]}
            >
              <Check size={14} color="#739174" />
              <Text style={s.small}>A lighter day</Text>
            </View>
            <View
              style={[
                s.row,
                {
                  position: "absolute",
                  bottom: 18,
                  right: -8,
                  padding: 12,
                  gap: 8,
                  backgroundColor: "#FFF",
                  borderRadius: 13,
                  transform: [{ rotate: "5deg" }],
                },
              ]}
            >
              <CalendarDays size={17} color={colors.blueDark} />
              <Text style={s.small}>Everything, together</Text>
            </View>
          </View>
        )}
      </View>
      <View style={{ flexDirection: "row", gap: 13, flexWrap: "wrap" }}>
        {[
          {
            label: "UNREAD EMAILS",
            value: unread.length,
            note: "A fresh look at your inbox",
            icon: Mail,
            section: "mail" as const,
            tint: colors.sky,
          },
          {
            label: "ON THE CALENDAR",
            value: events.length,
            note: "Make room for your priorities",
            icon: CalendarDays,
            section: "calendar" as const,
            tint: colors.green,
          },
          {
            label: "WAITING FOR YOU",
            value: pending.length,
            note: "Your review keeps things moving",
            icon: ShieldCheck,
            section: "activity" as const,
            tint: colors.lavender,
          },
        ].map((item) => (
          <Pressable
            key={item.label}
            accessibilityRole="button"
            onPress={() => navigate(item.section)}
            style={{ flex: 1, minWidth: 180 }}
          >
            <Card style={{ padding: 21, height: 126 }}>
              <View style={s.between}>
                <Text style={[s.label, { fontSize: 9, letterSpacing: 1 }]}>{item.label}</Text>
                <View
                  style={[
                    s.iconBox,
                    { width: 31, height: 31, borderRadius: 10, backgroundColor: item.tint },
                  ]}
                >
                  <item.icon size={15} color={colors.text} />
                </View>
              </View>
              <Text style={{ fontSize: 29, color: colors.text, letterSpacing: -1, marginTop: -2 }}>
                {String(item.value).padStart(2, "0")}
              </Text>
              <Text style={[s.small, { fontSize: 10, marginTop: 3 }]}>{item.note}</Text>
            </Card>
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: wide ? "row" : "column", gap: 22 }}>
        <Card style={{ flex: 1 }}>
          <SectionHeading
            title="On your calendar"
            action="Full calendar"
            onPress={() => navigate("calendar")}
          />
          {events.length ? (
            events.slice(0, 3).map((e, i) => <AgendaRow key={e.id} event={e} index={i} />)
          ) : (
            <Empty
              icon={CalendarDays}
              title="Some breathing room"
              detail="No events scheduled today."
            />
          )}
          <Pressable
            onPress={() => open({ type: "event" })}
            style={[
              s.row,
              {
                gap: 8,
                paddingTop: 15,
                marginTop: 9,
                borderTopWidth: 1,
                borderTopColor: colors.line,
              },
            ]}
          >
            <Plus size={15} color={colors.muted} />
            <Text style={s.small}>Make time for something</Text>
          </Pressable>
        </Card>
        <Card style={{ flex: 1 }}>
          <SectionHeading
            title="From your inbox"
            action="Open mail"
            onPress={() => navigate("mail")}
          />
          {w.mail.length ? (
            w.mail.slice(0, 3).map((m, i) => (
              <Pressable
                key={m.id}
                onPress={() => open({ type: "mail", mail: m })}
                style={[
                  s.row,
                  {
                    gap: 12,
                    paddingVertical: 13,
                    borderTopWidth: i ? 1 : 0,
                    borderTopColor: colors.line,
                  },
                ]}
              >
                <Avatar name={m.sender} index={i} />
                <View style={{ flex: 1, gap: 3 }}>
                  <View style={s.between}>
                    <Text style={[s.text, { fontSize: 12, fontWeight: "600" }]}>{m.sender}</Text>
                    <Text style={[s.small, { fontSize: 10 }]}>{timeLabel(m.date)}</Text>
                  </View>
                  <Text numberOfLines={1} style={[s.text, { fontSize: 12, lineHeight: 18 }]}>
                    {m.subject}
                  </Text>
                  <Text numberOfLines={1} style={[s.small, { fontSize: 11 }]}>
                    {m.body.replace(/\n/g, " ")}
                  </Text>
                </View>
                {m.unread && (
                  <View
                    style={{ width: 5, height: 5, borderRadius: 4, backgroundColor: "#78ABD0" }}
                  />
                )}
              </Pressable>
            ))
          ) : (
            <Empty
              icon={Inbox}
              title="Inbox is quiet"
              detail="Connect Google to bring your messages here."
            />
          )}
        </Card>
      </View>
      <View style={{ flexDirection: wide ? "row" : "column", gap: 22 }}>
        <Card style={{ flex: 1, backgroundColor: "#F0F0E7" }}>
          <SectionHeading title="A hand with the little things" />
          <Text style={[s.muted, { marginBottom: 15 }]}>
            Start with a thought. We’ll take it from there.
          </Text>
          {[
            "What needs my attention today?",
            "Help me catch up on my inbox",
            "Show my recent documents",
          ].map((prompt) => (
            <Pressable
              key={prompt}
              onPress={() => ask(prompt)}
              style={[
                s.between,
                { borderTopWidth: 1, borderTopColor: "#E1E2D9", paddingVertical: 13 },
              ]}
            >
              <Text style={[s.text, { fontSize: 12 }]}>{prompt}</Text>
              <ArrowUpRight size={15} color={colors.muted} />
            </Pressable>
          ))}
        </Card>
        <Card style={{ flex: 1 }}>
          <SectionHeading
            title={pending.length ? "Ready for your review" : "Recent activity"}
            action="View all"
            onPress={() => navigate("activity")}
          />
          {pending.length
            ? pending
                .slice(0, 3)
                .map((a) => (
                  <LinkRow
                    key={a.id}
                    title={a.title}
                    detail="Prepared · waiting for your approval"
                    onPress={() => open({ type: "review", action: a })}
                    icon={ShieldCheck}
                    tint={colors.lavender}
                  />
                ))
            : w.activity.slice(0, 3).map((a) => (
                <View key={a.id} style={[s.row, { gap: 13, paddingVertical: 12 }]}>
                  <View
                    style={[s.iconBox, { width: 32, height: 32, backgroundColor: colors.green }]}
                  >
                    <Check size={14} color={colors.text} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[s.text, { fontSize: 12 }]}>{a.title}</Text>
                    <Text style={s.small}>{relativeDate(a.date)}</Text>
                  </View>
                </View>
              ))}
          {!pending.length && !w.activity.length && (
            <Text style={s.muted}>
              Your workspace is ready. Things you do here will appear in your activity.
            </Text>
          )}
        </Card>
      </View>
    </View>
  );
}
function Avatar({ name, index = 0 }: { name: string; index?: number }) {
  return (
    <View
      style={{
        width: 35,
        height: 35,
        borderRadius: 12,
        backgroundColor: [colors.orange, colors.lavender, colors.green, colors.sky][index % 4],
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <Text style={{ color: colors.text, fontSize: 11, fontWeight: "500" }}>
        {name
          .split(" ")
          .map((p) => p[0])
          .slice(0, 2)
          .join("")}
      </Text>
    </View>
  );
}
export function AgendaRow({
  event: e,
  index = 0,
  neighbors,
}: {
  event: CalendarEvent;
  index?: number;
  neighbors?: CalendarEvent[];
}) {
  const { open } = useWorkspace();
  return (
    <Pressable
      onPress={() => open({ type: "event", event: e, neighbors })}
      style={[s.row, { gap: 16, paddingVertical: 14 }]}
    >
      <View style={{ width: 65 }}>
        <Text style={[s.text, { fontSize: 11 }]}>
          {e.allDay ? "All day" : timeLabel(e.start, e.timeZone)}
        </Text>
        {!e.allDay && (
          <Text style={[s.small, { fontSize: 10 }]}>{timeLabel(e.end, e.timeZone)}</Text>
        )}
      </View>
      <View
        style={{
          width: 3,
          height: 42,
          borderRadius: 4,
          backgroundColor: ["#BCDAEB", "#C7D6AB", "#D9CDEA"][index % 3],
        }}
      />
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[s.text, { fontSize: 13, fontWeight: "500" }]}>{e.title}</Text>
        <Text numberOfLines={1} style={[s.small, { fontSize: 11 }]}>
          {e.location || (e.attendees.length ? `${e.attendees.length} attendees` : "Time for you")}
        </Text>
      </View>
      <ChevronRight size={14} color={colors.muted} />
    </Pressable>
  );
}
const MAIL_PAGE_SIZE = 25;
const MAIL_AUTO_REFRESH_MS = 60_000;
/** "INBOX" -> "Inbox" for the folder list. */
function prettyFolder(name: string) {
  return name.length <= 5 ? name.charAt(0).toUpperCase() + name.slice(1).toLowerCase() : name;
}
function folderIcon(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (n === "inbox") return Inbox;
  if (n === "sent") return Send;
  if (n.includes("draft")) return FileText;
  if (n.includes("trash") || n.includes("delete")) return Trash2;
  if (n.includes("archiv")) return Archive;
  if (n.includes("spam") || n.includes("junk")) return ShieldCheck;
  return Folder;
}
/** Compact page window like 1 ... 6 7 [8] 9 10 ... 347. */
function pageWindow(current: number, total: number): (number | "...")[] {
  const keep = new Set([1, total, current - 1, current, current + 1]);
  const sorted = [...keep].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: (number | "...")[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push("...");
    out.push(p);
  });
  return out;
}
/** Numbered pages for the mailbox (Outlook-style), newest first. */
function MailPagination({
  page,
  total,
  pageSize,
  busy,
  onPage,
}: {
  page: number;
  total: number;
  pageSize: number;
  busy: boolean;
  onPage: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;
  const btnStyle = (active: boolean) => [
    {
      minWidth: 34,
      paddingVertical: 8,
      paddingHorizontal: 6,
      borderRadius: 9,
      borderWidth: 1,
      borderColor: active ? colors.blueDark : colors.line,
      backgroundColor: active ? colors.blueDark : "#FFF",
      alignItems: "center" as const,
      justifyContent: "center" as const,
      opacity: busy ? 0.6 : 1,
    },
  ];
  return (
    <View
      style={[
        s.row,
        {
          gap: 6,
          justifyContent: "center",
          alignItems: "center",
          paddingTop: 18,
          flexWrap: "wrap",
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Previous page"
        disabled={page <= 1 || busy}
        onPress={() => onPage(page - 1)}
        style={btnStyle(false)}
      >
        <ChevronLeft size={15} color={page <= 1 ? colors.muted : colors.text} />
      </Pressable>
      {pageWindow(page, totalPages).map((p, i) =>
        p === "..." ? (
          <Text key={`gap-before-${p}`} style={s.muted}>
            {"..."}
          </Text>
        ) : (
          <Pressable
            key={p}
            accessibilityRole="button"
            accessibilityLabel={`Page ${p}`}
            disabled={busy}
            onPress={() => onPage(p)}
            style={btnStyle(p === page)}
          >
            <Text
              style={[
                s.text,
                {
                  fontSize: 13,
                  fontWeight: p === page ? "600" : "400",
                  color: p === page ? "#FFF" : colors.text,
                },
              ]}
            >
              {p}
            </Text>
          </Pressable>
        ),
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Next page"
        disabled={page >= totalPages || busy}
        onPress={() => onPage(page + 1)}
        style={btnStyle(false)}
      >
        <ChevronRight size={15} color={page >= totalPages ? colors.muted : colors.text} />
      </Pressable>
      <Text style={[s.small, { marginLeft: 6 }]}>{totalPages} pages</Text>
    </View>
  );
}

/** One row from GET /api/email-accounts/:id/messages (metadata only). */
interface MailRow {
  uid: number;
  folder: string;
  messageId?: string;
  from: string;
  fromName?: string;
  to: string[];
  subject: string;
  date?: string;
  snippet: string;
  unread: boolean;
}
interface MailPage {
  total: number;
  page: number;
  pageSize: number;
  items: MailRow[];
}
interface MailAccount {
  id: string;
  label: string;
  emailAddress: string;
}

export function MailScreen() {
  const { workspace: w, api, open } = useWorkspace();
  const { width } = useWindowDimensions();
  const narrow = width < 720;
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [tab, setTab] = useState<"browse" | "all" | "unread" | "drafts">("browse");
  const [drafts, setDrafts] = useState<(EmailDraft & { id: string; createdAt: string })[]>([]);
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [folder, setFolder] = useState("INBOX");
  const [items, setItems] = useState<MailRow[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingPage, setLoadingPage] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [error, setError] = useState("");

  // Debounce the search box so typing does not hammer the mailbox.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 400);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    void api
      .request<(EmailDraft & { id: string; createdAt: string })[]>("/api/drafts")
      .then(setDrafts)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [api, w]);

  // Mailbox accounts drive browse mode; with none, fall back to the
  // workspace snapshot list (Google / sample mail).
  useEffect(() => {
    let live = true;
    void api
      .request<MailAccount[]>("/api/email-accounts")
      .then((list) => {
        if (!live) return;
        setAccounts(list);
        if (list.length) {
          setAccountId((current) => current || list[0].id);
          setTab((current) => (current === "all" || current === "unread" ? "browse" : current));
        } else {
          setTab((current) => (current === "browse" ? "all" : current));
        }
      })
      .catch(() => {
        if (live) setTab((current) => (current === "browse" ? "all" : current));
      });
    return () => {
      live = false;
    };
  }, [api]);

  // Folders for the selected account.
  useEffect(() => {
    if (!accountId) return;
    let live = true;
    setFolders([]);
    void api
      .request<string[]>(`/api/email-accounts/${encodeURIComponent(accountId)}/folders`)
      .then((list) => {
        if (!live) return;
        setFolders(list);
        setFolder((current) => (list.includes(current) ? current : (list[0] ?? "INBOX")));
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [api, accountId]);

  // First page whenever the account, folder, or debounced search changes.
  useEffect(() => {
    if (!accountId || tab !== "browse") return;
    let live = true;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ folder, page: "1", pageSize: String(MAIL_PAGE_SIZE) });
    const q = debounced.trim();
    if (q) params.set("query", q);
    void api
      .request<MailPage>(
        `/api/email-accounts/${encodeURIComponent(accountId)}/messages?${params.toString()}`,
      )
      .then((result) => {
        if (!live) return;
        setItems(result.items);
        setTotal(result.total);
        setPage(1);
        setSyncedAt(new Date().toISOString());
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [api, accountId, folder, debounced, tab]);

  /**
   * Manual refresh keeps the current list on screen while re-fetching page 1
   * (replaced only on success), so an IMAP hiccup never blanks the inbox and
   * the last good sync stays visible alongside any error notice.
   */
  const refreshMail = useCallback(() => {
    if (!accountId || tab !== "browse") return;
    setRefreshing(true);
    setError("");
    const params = new URLSearchParams({
      folder,
      page: String(page),
      pageSize: String(MAIL_PAGE_SIZE),
    });
    const q = debounced.trim();
    if (q) params.set("query", q);
    void api
      .request<MailPage>(
        `/api/email-accounts/${encodeURIComponent(accountId)}/messages?${params.toString()}`,
      )
      .then((result) => {
        setItems(result.items);
        setTotal(result.total);
        setPage(page);
        setSyncedAt(new Date().toISOString());
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRefreshing(false));
  }, [api, accountId, folder, debounced, tab, page]);

  // Auto-refresh the mailbox in browse mode so new mail lands without a
  // manual tap. The first-page effect above remains the trigger for actual
  // account/folder/search changes; this interval only re-checks the current
  // view and is torn down when the tab or account changes.
  useEffect(() => {
    if (!accountId || tab !== "browse") return;
    const timer = setInterval(() => refreshMail(), MAIL_AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshMail, accountId, tab]);

  /** Numbered-page navigation (replaces the old "Load more" append). */
  const gotoPage = useCallback(
    async (next: number) => {
      const totalPages = Math.max(1, Math.ceil(total / MAIL_PAGE_SIZE));
      if (next < 1 || next > totalPages || next === page || loadingPage || loading) return;
      setLoadingPage(true);
      setError("");
      try {
        const params = new URLSearchParams({
          folder,
          page: String(next),
          pageSize: String(MAIL_PAGE_SIZE),
        });
        const q = debounced.trim();
        if (q) params.set("query", q);
        const result = await api.request<MailPage>(
          `/api/email-accounts/${encodeURIComponent(accountId)}/messages?${params.toString()}`,
        );
        setItems(result.items);
        setTotal(result.total);
        setPage(next);
        setSyncedAt(new Date().toISOString());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoadingPage(false);
      }
    },
    [api, accountId, folder, debounced, page, total, loadingPage, loading],
  );

  function openRow(row: MailRow) {
    const label = accounts.find((a) => a.id === accountId)?.label ?? "";
    // The id doubles as the thread id; the detail sheet fetches the full
    // body through /api/mail/threads/:id, which understands "folder:uid".
    const mail: DomainMail = {
      id: `${folder}:${row.uid}`,
      threadId: `${folder}:${row.uid}`,
      from: row.from,
      sender: row.fromName ?? row.from,
      to: row.to,
      subject: row.subject,
      body: row.snippet,
      date: row.date ?? new Date(0).toISOString(),
      unread: row.unread,
      label: `${label} · ${folder}`,
      attachments: [],
    };
    open({ type: "mail", mail });
  }

  // Browse mode is available when at least one mailbox account exists; otherwise
  // the workspace snapshot list (Google / sample mail) is shown instead.
  const hasAccounts = accounts.length > 0;
  const showBrowse = hasAccounts && tab === "browse";
  const snapshotItems = w.mail.filter(
    (m) =>
      (tab !== "unread" || m.unread) &&
      `${m.sender} ${m.subject} ${m.body}`.toLowerCase().includes(query.toLowerCase()),
  );
  const filteredDrafts = drafts.filter((d) =>
    `${d.to.join(" ")} ${d.subject} ${d.body}`.toLowerCase().includes(query.toLowerCase()),
  );
  // A background re-check is in flight when a manual/auto refresh runs, or
  // when a folder/search change lands with a list already on screen.
  const checking = refreshing || (loading && items.length > 0) || loadingPage;

  return (
    <View style={{ gap: 22 }}>
      <View style={[s.between, { gap: 12, flexWrap: "wrap" }]}>
        <View
          style={[
            s.row,
            {
              gap: 9,
              flex: 1,
              minWidth: 200,
              backgroundColor: "#FFF",
              borderWidth: 1,
              borderColor: colors.line,
              borderRadius: 12,
              paddingHorizontal: 14,
            },
          ]}
        >
          <Search size={16} color={colors.muted} />
          <TextInput
            accessibilityLabel="Search mail"
            placeholder={hasAccounts ? "Search this mailbox" : "Search your inbox"}
            placeholderTextColor={colors.muted}
            value={query}
            onChangeText={setQuery}
            style={{ flex: 1, paddingVertical: 13, fontSize: 13, color: colors.text }}
          />
        </View>
        <Button onPress={() => open({ type: "email" })} primary icon={Plus}>
          Compose
        </Button>
      </View>
      <ErrorNotice error={error} />
      <Card>
        <View style={[s.row, { gap: 10, marginBottom: 15, flexWrap: "wrap" }]}>
          {hasAccounts ? (
            <>
              <Button small primary={tab === "browse"} onPress={() => setTab("browse")}>
                Mailbox{total ? ` · ${total}` : ""}
              </Button>
              <Button small primary={tab === "drafts"} onPress={() => setTab("drafts")}>
                Drafts · {drafts.length}
              </Button>
            </>
          ) : (
            <>
              <Button small primary={tab === "all"} onPress={() => setTab("all")}>
                All messages
              </Button>
              <Button small primary={tab === "unread"} onPress={() => setTab("unread")}>
                Unread · {w.mail.filter((m) => m.unread).length}
              </Button>
              <Button small primary={tab === "drafts"} onPress={() => setTab("drafts")}>
                Drafts · {drafts.length}
              </Button>
            </>
          )}
        </View>
        {showBrowse && accounts.length > 1 && (
          <View style={[s.row, { gap: 8, flexWrap: "wrap", marginBottom: 15 }]}>
            {accounts.map((account) => (
              <Button
                key={account.id}
                small
                primary={account.id === accountId}
                onPress={() => setAccountId(account.id)}
              >
                {account.label}
              </Button>
            ))}
          </View>
        )}
        {showBrowse && (
          <View
            style={[
              s.row,
              {
                gap: 8,
                marginBottom: 14,
                justifyContent: "space-between",
                alignItems: "center",
              },
            ]}
          >
            <View style={[s.row, { gap: 6, flex: 1 }]}>
              {checking ? (
                <ActivityIndicator size="small" color={colors.blueDark} />
              ) : (
                <RefreshCw size={13} color={colors.muted} />
              )}
              <Text style={s.small}>
                {checking
                  ? "Checking for new mail\u2026"
                  : syncedAt
                    ? `Updated ${relativeDate(syncedAt)}`
                    : "Mailbox"}
              </Text>
            </View>
            <Button small icon={RefreshCw} busy={checking} onPress={() => void refreshMail()}>
              Refresh
            </Button>
          </View>
        )}
        {tab === "drafts" ? (
          filteredDrafts.length ? (
            filteredDrafts.map((d) => (
              <LinkRow
                key={d.id}
                icon={Mail}
                title={d.subject}
                detail={`To: ${d.to.join(", ")} · saved ${dateLabel(d.createdAt)}`}
                onPress={() => open({ type: "email", draft: d })}
              />
            ))
          ) : (
            <Empty
              icon={Mail}
              title="A fresh page"
              detail="Messages you save as drafts will be here when you’re ready."
            />
          )
        ) : showBrowse ? (
          <View
            style={[
              s.row,
              narrow
                ? { flexDirection: "column", alignItems: "stretch" }
                : { alignItems: "flex-start" },
              { gap: 18 },
            ]}
          >
            {narrow ? (
              <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
                {folders.map((name) => {
                  const FolderIcon = folderIcon(name);
                  return (
                    <Button
                      key={name}
                      small
                      primary={name === folder}
                      icon={FolderIcon}
                      onPress={() => setFolder(name)}
                    >
                      {prettyFolder(name)}
                    </Button>
                  );
                })}
              </View>
            ) : (
              <View style={{ width: 205, gap: 2, paddingTop: 4 }}>
                <Text
                  style={[
                    s.small,
                    {
                      fontWeight: "600",
                      color: colors.muted,
                      paddingHorizontal: 10,
                      paddingBottom: 6,
                    },
                  ]}
                >
                  Folders
                </Text>
                {folders.map((name) => {
                  const FolderIcon = folderIcon(name);
                  const active = name === folder;
                  return (
                    <Pressable
                      key={name}
                      onPress={() => setFolder(name)}
                      style={[
                        s.row,
                        {
                          gap: 10,
                          alignItems: "center",
                          paddingVertical: 9,
                          paddingHorizontal: 10,
                          borderRadius: 10,
                          backgroundColor: active ? colors.sky : "transparent",
                        },
                      ]}
                    >
                      <FolderIcon size={15} color={active ? colors.blueDark : colors.muted} />
                      <Text
                        style={[
                          s.text,
                          {
                            fontSize: 13,
                            fontWeight: active ? "600" : "400",
                            color: active ? colors.blueDark : colors.text,
                          },
                        ]}
                      >
                        {prettyFolder(name)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
            <View style={{ flex: 1, minWidth: 0 }}>
              {loading && !items.length ? (
                <View style={[s.row, { gap: 10, paddingVertical: 24, justifyContent: "center" }]}>
                  <ActivityIndicator color={colors.blueDark} />
                  <Text style={s.muted}>Loading {folder}…</Text>
                </View>
              ) : items.length ? (
                <>
                  {items.map((row, i) => (
                    <Pressable
                      key={`${folder}:${row.uid}`}
                      onPress={() => openRow(row)}
                      style={[
                        s.row,
                        {
                          gap: 15,
                          paddingVertical: 20,
                          borderTopWidth: 1,
                          borderTopColor: colors.line,
                        },
                      ]}
                    >
                      <Avatar name={row.fromName ?? row.from} index={i} />
                      <View style={{ flex: 1, gap: 5 }}>
                        <View style={s.between}>
                          <Text style={[s.text, { fontWeight: row.unread ? "600" : "400" }]}>
                            {row.fromName ?? row.from}
                          </Text>
                          <Text style={s.small}>{row.date ? dateLabel(row.date) : ""}</Text>
                        </View>
                        <Text style={[s.text, { fontWeight: "500", fontSize: 13 }]}>
                          {row.subject}
                        </Text>
                        <Text style={s.muted} numberOfLines={1}>
                          {row.snippet}
                        </Text>
                      </View>
                      {row.unread && (
                        <View
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 4,
                            backgroundColor: "#83B5D3",
                          }}
                        />
                      )}
                    </Pressable>
                  ))}
                  <MailPagination
                    page={page}
                    total={total}
                    pageSize={MAIL_PAGE_SIZE}
                    busy={loadingPage}
                    onPage={(next) => void gotoPage(next)}
                  />
                </>
              ) : (
                <Empty
                  icon={Inbox}
                  title={debounced ? "No matching messages" : `Nothing in ${folder}`}
                  detail={
                    debounced
                      ? "Try a different name or subject — search runs across the whole folder."
                      : accounts.length
                        ? "This folder has no messages yet."
                        : "Connect Google in Connections to read your mail here."
                  }
                />
              )}
            </View>
          </View>
        ) : snapshotItems.length ? (
          snapshotItems.map((m, i) => (
            <Pressable
              key={m.id}
              onPress={() => open({ type: "mail", mail: m })}
              style={[
                s.row,
                { gap: 15, paddingVertical: 20, borderTopWidth: 1, borderTopColor: colors.line },
              ]}
            >
              <Avatar name={m.sender} index={i} />
              <View style={{ flex: 1, gap: 5 }}>
                <View style={s.between}>
                  <Text style={[s.text, { fontWeight: m.unread ? "600" : "400" }]}>{m.sender}</Text>
                  <Text style={s.small}>{dateLabel(m.date)}</Text>
                </View>
                <Text style={[s.text, { fontWeight: "500", fontSize: 13 }]}>{m.subject}</Text>
                <Text style={s.muted} numberOfLines={1}>
                  {m.body.replace(/\n/g, " ")}
                </Text>
                {!!m.attachments.length && (
                  <View style={[s.row, { gap: 4, marginTop: 2 }]}>
                    <FileText size={12} color={colors.muted} />
                    <Text style={s.small}>
                      {m.attachments.length} attachment{m.attachments.length > 1 ? "s" : ""}
                    </Text>
                  </View>
                )}
              </View>
              {m.unread && (
                <View
                  style={{ width: 6, height: 6, borderRadius: 4, backgroundColor: "#83B5D3" }}
                />
              )}
            </Pressable>
          ))
        ) : (
          <Empty
            icon={Inbox}
            title={query ? "No matching messages" : "Nothing in your inbox"}
            detail={
              query
                ? "Try a different name or subject."
                : "Connect Google in Connections to read your mail here."
            }
          />
        )}
      </Card>
    </View>
  );
}
interface CalendarChoice {
  id: string;
  name: string;
  timeZone: string;
  accessRole: string;
}
function plusDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function CalendarScreen() {
  const { workspace: w, api, open } = useWorkspace();
  const [date, setDate] = useState(todayDate());
  const [all, setAll] = useState(false);
  const [calendars, setCalendars] = useState<CalendarChoice[]>([]);
  const [calendarId, setCalendarId] = useState("primary");
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const selected = calendars.find((c) => c.id === calendarId);
  const zone = selected?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const writable = !selected || ["owner", "writer"].includes(selected.accessRole);
  const anchor = new Date(`${date}T12:00:00`);
  const dates = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(anchor);
    day.setDate(anchor.getDate() - anchor.getDay() + i);
    return day;
  });
  useEffect(() => {
    let active = true;
    void api
      .request<CalendarChoice[]>("/api/calendars")
      .then((items) => {
        if (!active) return;
        setCalendars(items);
        setCalendarId((current) =>
          items.some((c) => c.id === current) ? current : items[0]?.id || "primary",
        );
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [api, retry]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void Promise.resolve()
      .then(() => {
        const query = new URLSearchParams({
          calendarId,
          timeMin: zonedInstant(date, "00:00", zone),
          timeMax: zonedInstant(plusDays(date, all ? 30 : 1), "00:00", zone),
        });
        return api.request<CalendarEvent[]>(`/api/calendar/events?${query}`);
      })
      .then((items) => {
        if (active) setEvents(items.sort((a, b) => a.start.localeCompare(b.start)));
      })
      .catch((e) => {
        if (active) {
          setEvents([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, calendarId, date, all, zone, w, retry]);
  function newEvent() {
    open({
      type: "event",
      neighbors: events,
      draft: {
        calendarId,
        title: "",
        start: zonedInstant(date, "09:00", zone),
        end: zonedInstant(date, "10:00", zone),
        allDay: false,
        timeZone: zone,
        location: "",
        description: "",
        attendees: [],
      },
    });
  }
  return (
    <View style={{ gap: 22 }}>
      <View style={[s.between, { gap: 12, flexWrap: "wrap" }]}>
        <View style={[s.row, { gap: 8 }]}>
          <Text style={s.title}>
            {anchor.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
          </Text>
          <IconButton
            icon={ChevronLeft}
            label="Previous week"
            onPress={() => setDate(plusDays(date, -7))}
          />
          <IconButton
            icon={ChevronRight}
            label="Next week"
            onPress={() => setDate(plusDays(date, 7))}
          />
        </View>
        <Button primary icon={Plus} disabled={!writable} onPress={newEvent}>
          New event
        </Button>
      </View>
      {calendars.length > 0 && (
        <View style={{ gap: 9 }}>
          <Text style={s.label}>Your calendars</Text>
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            {calendars.map((c) => (
              <Button
                key={c.id}
                small
                primary={c.id === calendarId}
                onPress={() => setCalendarId(c.id)}
              >
                {c.name}
                {["owner", "writer"].includes(c.accessRole) ? "" : " · read only"}
              </Button>
            ))}
          </View>
        </View>
      )}
      <Card style={{ padding: 12 }}>
        <View style={{ flexDirection: "row", gap: 5 }}>
          {dates.map((day) => {
            const key = localDateTime(
              day.toISOString(),
              Intl.DateTimeFormat().resolvedOptions().timeZone,
            ).date;
            return (
              <Pressable
                key={key}
                onPress={() => {
                  setDate(key);
                  setAll(false);
                }}
                style={{
                  flex: 1,
                  alignItems: "center",
                  paddingVertical: 17,
                  gap: 9,
                  borderRadius: 14,
                  backgroundColor: key === date ? colors.sky : "transparent",
                }}
              >
                <Text style={s.small}>{day.toLocaleDateString("en-US", { weekday: "short" })}</Text>
                <Text
                  style={[
                    s.title,
                    { fontSize: 22, color: key === date ? colors.blueDark : colors.text },
                  ]}
                >
                  {day.getDate()}
                </Text>
                <View
                  style={{
                    height: 4,
                    width: 4,
                    borderRadius: 4,
                    backgroundColor: [...events, ...w.events].some(
                      (e) => e.calendarId === calendarId && eventDate(e) === key,
                    )
                      ? "#8DB6CA"
                      : "transparent",
                  }}
                />
              </Pressable>
            );
          })}
        </View>
      </Card>
      <Card>
        <View style={[s.between, { gap: 10, flexWrap: "wrap" }]}>
          <Text style={s.heading}>
            {all
              ? "The next 30 days"
              : dateLabel(`${date}T12:00:00`, { weekday: "long", month: "long", day: "numeric" })}
          </Text>
          <Button small onPress={() => setAll(!all)}>
            {all ? "Selected day" : "Next 30 days"}
          </Button>
        </View>
        <Text style={[s.small, { marginTop: 7, marginBottom: 13 }]}>
          {selected?.name || "Your calendar"} · {zone}. Events show their own time zone.
        </Text>
        <ErrorNotice error={error} />
        {error && (
          <Button small onPress={() => setRetry(retry + 1)}>
            Try again
          </Button>
        )}
        {loading ? (
          <View style={[s.row, { gap: 10, paddingVertical: 35, justifyContent: "center" }]}>
            <ActivityIndicator size="small" color={colors.blueDark} />
            <Text style={s.muted}>Checking your calendar…</Text>
          </View>
        ) : events.length ? (
          events.map((e, i) => (
            <View key={e.id}>
              {all && <Text style={[s.label, { marginTop: 16 }]}>{dateLabel(e.start)}</Text>}
              <AgendaRow event={e} index={i} neighbors={events} />
              <Text style={[s.small, { marginLeft: 84, marginBottom: 8 }]}>{e.timeZone}</Text>
            </View>
          ))
        ) : (
          !error && (
            <Empty
              icon={CalendarDays}
              title="A little open space"
              detail={
                all
                  ? "There’s nothing scheduled for the next 30 days."
                  : "There’s nothing on the calendar for this day."
              }
            >
              {writable && (
                <Button icon={Plus} onPress={newEvent}>
                  Add an event
                </Button>
              )}
            </Empty>
          )
        )}
      </Card>
    </View>
  );
}
export function BrowserScreen() {
  const { workspace: w, api, refresh, open } = useWorkspace();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function create() {
    setError("");
    setBusy(true);
    try {
      const browser = await api.request<BrowserSession>("/api/browsers", { url });
      await refresh();
      setUrl("");
      open({ type: "browser", browser });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 12 }}>
      <Card style={{ padding: 10, borderRadius: 12 }}>
        <View style={[s.row, { gap: 8 }]}>
          <TextInput
            accessibilityLabel="Website address"
            value={url}
            onChangeText={setUrl}
            onSubmitEditing={() => void create()}
            autoCapitalize="none"
            placeholder="Enter website URL (e.g. https://www.google.com)"
            placeholderTextColor={colors.muted}
            style={[s.input, { flex: 1, minHeight: 38, paddingVertical: 6 }]}
          />
          <Button
            small
            primary
            icon={Plus}
            busy={busy}
            disabled={!url.trim()}
            onPress={() => void create()}
          >
            Open session
          </Button>
        </View>
        <ErrorNotice error={error} />
      </Card>
      <Card>
        <View style={[s.between, { marginBottom: 14 }]}>
          <Text style={s.heading}>Browser sessions</Text>
          <RestartBrowserButton small />
        </View>
        {w.browsers.length ? (
          w.browsers.map((b) => (
            <Pressable
              key={b.id}
              onPress={() => open({ type: "browser", browser: b })}
              style={{
                borderTopWidth: 1,
                borderTopColor: colors.line,
                paddingVertical: 20,
                gap: 12,
              }}
            >
              <View style={[s.row, { gap: 14 }]}>
                <View style={s.iconBox}>
                  <Globe2 size={20} color={colors.blueDark} />
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={s.heading}>{b.title || "Browser session"}</Text>
                  <Text style={s.muted} numberOfLines={1}>
                    {b.url}
                  </Text>
                </View>
                <Chip tint={b.status === "active" ? colors.green : colors.canvas}>{b.status}</Chip>
                <ArrowUpRight size={17} color={colors.muted} />
              </View>
              {b.previewUrl && (
                <Image
                  source={{ uri: api.url(b.previewUrl) }}
                  resizeMode="cover"
                  style={{
                    height: 180,
                    width: "100%",
                    borderRadius: 12,
                    backgroundColor: colors.canvas,
                  }}
                />
              )}
            </Pressable>
          ))
        ) : (
          <Empty
            icon={Globe2}
            title="Start with a website"
            detail="Open a session above to keep your browsing together. Live previews appear when the browser worker is configured."
          />
        )}
      </Card>
    </View>
  );
}
export function FilesScreen() {
  const { workspace: w, api, refresh, open } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function upload() {
    setError("");
    setBusy(true);
    setMascotSource("upload", "uploading");
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "application/pdf",
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const file = result.assets[0];
      let artifact: Artifact;
      if (Platform.OS === "web") {
        const form = new FormData();
        if (!file.file)
          throw new Error("The selected file could not be read. Please choose it again.");
        form.append("file", file.file, file.name);
        artifact = await api.request<Artifact>("/api/files", form);
      } else {
        const result = await FileSystem.uploadAsync(`${API_URL}/api/files`, file.uri, {
          httpMethod: "POST",
          uploadType: FileSystem.FileSystemUploadType.MULTIPART,
          fieldName: "file",
          mimeType: "application/pdf",
          headers: { Authorization: `Bearer ${api.token}` },
        });
        const payload = JSON.parse(result.body);
        if (result.status < 200 || result.status >= 300)
          throw new Error(payload.error || "Could not import this PDF.");
        artifact = payload;
      }
      await refresh();
      open({ type: "file", file: artifact });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setMascotSource("upload", "idle");
    }
  }
  return (
    <View style={{ gap: 22 }}>
      <View style={s.between}>
        <Text style={[s.muted, { flex: 1, marginRight: 15 }]}>
          Documents, with a little room to work.
        </Text>
        <Button primary icon={Upload} busy={busy} onPress={() => void upload()}>
          Import PDF
        </Button>
      </View>
      <ErrorNotice error={error} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 18 }}>
        {w.files.map((f) => (
          <Pressable
            key={f.id}
            onPress={() => open({ type: "file", file: f })}
            style={{ flexGrow: 1, flexBasis: 250, maxWidth: 430 }}
          >
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <View
                style={{
                  height: 175,
                  backgroundColor: "#EDEFEA",
                  justifyContent: "center",
                  alignItems: "center",
                }}
              >
                <View
                  style={{
                    width: 93,
                    height: 121,
                    borderRadius: 5,
                    backgroundColor: "#FFF",
                    padding: 14,
                    transform: [{ rotate: "-4deg" }],
                    borderWidth: 1,
                    borderColor: "#DDE3DD",
                  }}
                >
                  <View style={[s.row, { gap: 5, marginBottom: 15 }]}>
                    <FileText size={13} color={colors.blueDark} />
                    <Text style={{ fontSize: 7, color: colors.blueDark }}>DOCUMENT</Text>
                  </View>
                  {[100, 75, 90, 95, 60].map((width, i) => (
                    <View
                      key={width}
                      style={{
                        height: 3,
                        backgroundColor: i === 0 ? "#A4BED0" : "#E3E7E3",
                        width: `${width}%`,
                        marginBottom: 7,
                        borderRadius: 3,
                      }}
                    />
                  ))}
                </View>
                <View style={{ position: "absolute", bottom: 12, right: 14 }}>
                  <Chip>PDF</Chip>
                </View>
              </View>
              <View style={{ padding: 21, gap: 6 }}>
                <Text numberOfLines={1} style={[s.heading, { fontSize: 14 }]}>
                  {f.name}
                </Text>
                <Text style={s.small}>
                  {f.pageCount} {f.pageCount === 1 ? "page" : "pages"} ·{" "}
                  {Math.max(1, Math.round(f.size / 1024))} KB
                </Text>
                <View style={[s.between, { marginTop: 9 }]}>
                  <Chip>{f.source}</Chip>
                  <Text style={s.small}>{dateLabel(f.createdAt)}</Text>
                </View>
              </View>
            </Card>
          </Pressable>
        ))}
      </View>
      {!w.files.length && (
        <Card>
          <Empty
            icon={FileText}
            title="Your documents live here"
            detail="Import a PDF or open a mail attachment to read, fill supported form fields, and share a copy."
          />
        </Card>
      )}
    </View>
  );
}
export function ActivityScreen() {
  const { workspace: w, open } = useWorkspace();
  const [filter, setFilter] = useState("all");
  // w.activity arrives projected from the server (honest statuses, routine
  // noise filtered); the same projection feeds the mascot.
  useActivityMascot(w.activity);
  const pending = w.actions.filter((a) => a.status === "awaiting_review");
  const actions = w.actions.filter((a) => filter === "all" || a.status === "awaiting_review");
  return (
    <View style={{ gap: 22 }}>
      <View style={[s.row, { gap: 10 }]}>
        <Button small primary={filter === "all"} onPress={() => setFilter("all")}>
          All activity
        </Button>
        <Button small primary={filter === "review"} onPress={() => setFilter("review")}>
          Needs review · {pending.length}
        </Button>
      </View>
      {actions.length > 0 && (
        <Card>
          <SectionHeading title="Your actions" />
          {actions.map((a) => (
            <Pressable
              key={a.id}
              onPress={() => open({ type: "review", action: a })}
              style={[
                s.row,
                { gap: 15, paddingVertical: 17, borderTopWidth: 1, borderTopColor: colors.line },
              ]}
            >
              <View
                style={[
                  s.iconBox,
                  {
                    backgroundColor:
                      a.status === "awaiting_review" ? colors.lavender : colors.green,
                  },
                ]}
              >
                {a.status === "awaiting_review" ? (
                  <ShieldCheck size={18} color={colors.text} />
                ) : (
                  <CheckCheck size={18} color={colors.text} />
                )}
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={s.text}>{a.title}</Text>
                <Text style={s.small}>{relativeDate(a.createdAt)}</Text>
              </View>
              <Chip
                tint={
                  a.status === "failed"
                    ? "#FBEFED"
                    : a.status === "awaiting_review"
                      ? colors.lavender
                      : colors.canvas
                }
              >
                {a.status.replace(/_/g, " ")}
              </Chip>
              <ChevronRight size={16} color={colors.muted} />
            </Pressable>
          ))}
        </Card>
      )}
      {filter === "all" && (
        <Card>
          <SectionHeading title="Workspace timeline" />
          {w.activity.length ? (
            w.activity.map((a, i) => (
              <View
                key={a.id}
                style={[
                  s.row,
                  {
                    alignItems: "flex-start",
                    gap: 17,
                    paddingVertical: 18,
                    borderTopWidth: i ? 1 : 0,
                    borderTopColor: colors.line,
                  },
                ]}
              >
                <View
                  style={[s.iconBox, { height: 34, width: 34, backgroundColor: colors.canvas }]}
                >
                  <Clock3 size={16} color={colors.muted} />
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={s.text}>{a.title}</Text>
                  <Text style={s.muted}>{resultSummary(a.detail)}</Text>
                  <Text style={s.small}>
                    {dateLabel(a.date)} · {timeLabel(a.date)}
                  </Text>
                </View>
                <Chip tint={a.honestStatus === "failed" ? "#FBEFED" : colors.canvas}>
                  {a.label}
                </Chip>
              </View>
            ))
          ) : (
            <Empty
              icon={Clock3}
              title="The beginning of something lighter"
              detail="Your actions and their results will be recorded here."
            />
          )}
        </Card>
      )}
      {filter === "review" && !actions.length && (
        <Card>
          <Empty
            icon={ShieldCheck}
            title="You’re all caught up"
            detail="When an email or calendar change needs your approval, it will appear here."
          />
        </Card>
      )}
    </View>
  );
}
export function ConnectionsScreen({ query = "" }: { query?: string }) {
  const { workspace: w, api, refresh, notify, open, navigate, sessionUser } = useWorkspace();
  const isAdmin = sessionUser.role === "admin";
  const [tab, setTab] = useState<"connections" | "services">("connections");
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const showModelsSection =
    isAdmin &&
    (!query.trim() || "models api keys providers llm".includes(query.trim().toLowerCase()));
  // User-configurable chat shortcuts (buttons on the empty chat screen).
  const shortcuts = useSyncExternalStore(subscribeShortcuts, getShortcutsSnapshot);
  const [editingShortcut, setEditingShortcut] = useState<ChatShortcut | null>(null);
  const [shortcutError, setShortcutError] = useState("");
  const showShortcutsSection = !query.trim() || "shortcuts".includes(query.trim().toLowerCase());
  useEffect(() => {
    void ensureShortcutsLoaded();
  }, []);
  async function removeShortcut(id: string) {
    setShortcutError("");
    try {
      await deleteShortcut(id);
    } catch (e) {
      setShortcutError(e instanceof Error ? e.message : String(e));
    }
  }
  // Saved website-login / email-account counts (redacted metadata only — the
  // list endpoints never return secrets). Drives the Connected grouping below.
  const [savedCounts, setSavedCounts] = useState<{ credentials: number; email: number } | null>(
    null,
  );
  useEffect(() => {
    let live = true;
    if (!isAdmin) {
      setSavedCounts({ credentials: 0, email: 0 });
      return;
    }
    (async () => {
      try {
        const [credentials, email] = await Promise.all([
          api.request<unknown[]>("/api/credentials"),
          api.request<unknown[]>("/api/email-accounts"),
        ]);
        if (live) setSavedCounts({ credentials: credentials.length, email: email.length });
      } catch {
        // Backend unavailable (e.g. sample mode): treat as nothing saved yet.
        if (live) setSavedCounts({ credentials: 0, email: 0 });
      }
    })();
    return () => {
      live = false;
    };
  }, [api, isAdmin]);
  async function connect(capability: "read" | "write") {
    setBusy(true);
    setError("");
    try {
      const result = await api.request<{ url: string | null; connected?: boolean }>(
        "/api/google/connect",
        { capability },
      );
      if (result.url) {
        await Linking.openURL(result.url);
        notify("Finish connecting in your browser, then refresh your workspace.");
      } else {
        await refresh();
        notify("Local Google data is ready.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError("");
    try {
      await api.request("/api/google/disconnect", {});
      await refresh();
      notify("Google disconnected.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const google = w.connections.find((c) => c.id === "google");
  const connected = google?.status === "connected" || google?.status === "sample";
  type ConnectorRow = {
    id: string;
    name: string;
    detail?: string;
    icon: LucideIcon;
    color: string;
    connected: boolean;
    group: string;
  };
  const rows: ConnectorRow[] = [
    { id: "gmail", name: "Gmail", icon: Mail, color: "#EA5B4D", connected, group: "google" },
    {
      id: "calendar",
      name: "Google Calendar",
      icon: CalendarDays,
      color: "#4285F4",
      connected,
      group: "google",
    },
    {
      id: "browser",
      name: "Agent computer",
      icon: Globe2,
      color: "#1987CF",
      connected: w.connections.some((c) => c.id === "browser" && c.status === "connected"),
      group: "browser",
    },
    {
      id: "openbot",
      name: "OpenBot",
      icon: Sparkles,
      color: "#6866A6",
      connected: false,
      group: "openbot",
    },
    {
      id: "credentials",
      name: "Website logins",
      detail: "Saved logins · domain-locked “Log in now”",
      icon: KeyRound,
      color: "#8A5FC0",
      connected: (savedCounts?.credentials ?? 0) > 0,
      group: "connectors",
    },
    {
      id: "email-accounts",
      name: "Email accounts",
      detail: "IMAP/SMTP · test connection",
      icon: Inbox,
      color: "#E8912D",
      connected: (savedCounts?.email ?? 0) > 0,
      group: "connectors",
    },
    ...(isAdmin
      ? [
          {
            id: "users",
            name: "Users",
            detail: "Usernames, passwords & roles",
            icon: Users,
            color: "#3D7BFF",
            connected: false,
            group: "users",
          },
        ]
      : []),
  ]
    .filter((row) => isAdmin || row.group !== "connectors")
    .filter((row) => `${row.name} ${row.group}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <View style={{ gap: 22 }}>
      <View style={[s.row, { gap: 8, paddingHorizontal: 2 }]}>
        <Button small primary={tab === "connections"} onPress={() => setTab("connections")}>
          Connections
        </Button>
        {isAdmin && (
          <Button small primary={tab === "services"} onPress={() => setTab("services")}>
            Services
          </Button>
        )}
      </View>
      {tab === "services" ? (
        <ServicesTab api={api} />
      ) : (
        <>
          {[true, false].map((isConnected) => {
            const group = rows.filter((row) => row.connected === isConnected);
            if (!group.length) return null;
            return (
              <View key={String(isConnected)} style={{ gap: 8 }}>
                <Text style={[s.small, { marginLeft: 12 }]}>
                  {isConnected
                    ? w.mode === "sample"
                      ? "Your connections"
                      : "Connected"
                    : "Available integrations"}
                </Text>
                <View
                  style={{ paddingHorizontal: 16, borderRadius: 23, backgroundColor: "#F3F4F5" }}
                >
                  {group.map((row, index) => (
                    <Pressable
                      key={row.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Manage ${row.name}`}
                      onPress={() =>
                        row.group === "users"
                          ? open({ type: "users" })
                          : row.group === "browser"
                            ? open({ type: "computer" })
                            : row.group === "connectors"
                              ? navigate("connectors")
                              : setSelected(row.group)
                      }
                      style={[
                        s.row,
                        {
                          gap: 14,
                          minHeight: 61,
                          borderBottomWidth: index < group.length - 1 ? 1 : 0,
                          borderBottomColor: "#E5E7E9",
                        },
                      ]}
                    >
                      <View
                        style={{
                          width: 29,
                          height: 29,
                          borderRadius: 7,
                          backgroundColor: "#FFF",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <row.icon size={23} color={row.color} />
                      </View>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={s.text}>{row.name}</Text>
                        {row.detail ? <Text style={s.small}>{row.detail}</Text> : null}
                      </View>
                      {row.connected && row.group === "google" && w.mode === "sample" && (
                        <Text style={s.small}>Local data</Text>
                      )}
                      {row.connected ? (
                        <ChevronRight size={18} color="#A4A7AA" />
                      ) : (
                        <Text
                          style={{
                            fontSize: 13,
                            color: row.group === "google" ? colors.blueDark : colors.muted,
                          }}
                        >
                          {row.group === "google" ? "Connect" : "Setup"}
                        </Text>
                      )}
                    </Pressable>
                  ))}
                </View>
              </View>
            );
          })}
          {!rows.length && <Text style={s.muted}>No matching connectors.</Text>}
          {showModelsSection && <ModelSettingsScreen api={api} />}
          {showShortcutsSection && (
            <View style={{ gap: 8 }}>
              <Text style={[s.small, { marginLeft: 12 }]}>Chat shortcuts</Text>
              <View style={{ paddingHorizontal: 16, borderRadius: 23, backgroundColor: "#F3F4F5" }}>
                {shortcuts.map((shortcut) => (
                  <View
                    key={shortcut.id}
                    style={[
                      s.row,
                      {
                        gap: 6,
                        minHeight: 61,
                        borderBottomWidth: 1,
                        borderBottomColor: "#E5E7E9",
                        paddingVertical: 10,
                      },
                    ]}
                  >
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={s.text}>{shortcut.label}</Text>
                      <Text style={s.small} numberOfLines={2}>
                        {shortcut.instruction}
                      </Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Edit ${shortcut.label}`}
                      onPress={() => setEditingShortcut(shortcut)}
                      style={{ padding: 8 }}
                    >
                      <Pencil size={18} color={colors.muted} />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Delete ${shortcut.label}`}
                      onPress={() => void removeShortcut(shortcut.id)}
                      style={{ padding: 8 }}
                    >
                      <Trash2 size={18} color={colors.danger} />
                    </Pressable>
                  </View>
                ))}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Add shortcut"
                  onPress={() => setEditingShortcut({ id: "", label: "", instruction: "" })}
                  style={[s.row, { gap: 14, minHeight: 61 }]}
                >
                  <View
                    style={{
                      width: 29,
                      height: 29,
                      borderRadius: 7,
                      backgroundColor: "#FFF",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Plus size={20} color={colors.blueDark} />
                  </View>
                  <Text style={[s.text, { color: colors.blueDark }]}>Add shortcut</Text>
                </Pressable>
              </View>
              {!!shortcutError && <ErrorNotice error={shortcutError} />}
              <Text style={[s.small, { marginLeft: 12 }]}>
                Shortcuts appear as buttons on the empty chat screen, with their instruction text
                underneath. Tapping a button sends its instruction.
              </Text>
            </View>
          )}
          {editingShortcut && (
            <ShortcutEditorSheet
              shortcut={editingShortcut}
              onClose={() => setEditingShortcut(null)}
            />
          )}
          {selected && (
            <Sheet
              title={selected === "google" ? "Google connections" : "OpenBot"}
              subtitle={selected === "google" ? google?.account : "A computer for your agent"}
              onClose={() => setSelected(undefined)}
            >
              {selected === "google" ? (
                <View style={{ gap: 18 }}>
                  <Text style={s.muted}>
                    Bring Gmail and Google Calendar into your conversations. Choose read access,
                    then enable sending and editing when you need it.
                  </Text>
                  <View style={[s.row, { gap: 7, flexWrap: "wrap" }]}>
                    {google?.capabilities.map((cap) => (
                      <Chip key={cap}>{capabilityLabel(cap)}</Chip>
                    ))}
                  </View>
                  <ErrorNotice error={error} />
                  <Button busy={busy} primary icon={Link2} onPress={() => void connect("read")}>
                    Connect Google
                  </Button>
                  <Button busy={busy} onPress={() => void connect("write")}>
                    Enable sending & editing
                  </Button>
                  {connected && (
                    <Button busy={busy} danger onPress={() => void disconnect()}>
                      Disconnect Google
                    </Button>
                  )}
                  <SettingsLine
                    label="Environment"
                    value={w.mode === "sample" ? "Local · example data" : "Live workspace"}
                  />
                  <SettingsLine
                    label="Assistant"
                    value={
                      w.runtime.provider === "sample"
                        ? "Guided workflows"
                        : w.runtime.configured
                          ? "Model connected"
                          : "Model not configured"
                    }
                  />
                  <SettingsLine
                    label="Rich Threads"
                    value={w.runtime.richThreads ? "CopilotKit Intelligence" : "Not connected"}
                  />
                  <Button
                    small
                    icon={ArrowDownToLine}
                    onPress={() => void refresh().catch((e) => setError(String(e)))}
                  >
                    Refresh connections
                  </Button>
                </View>
              ) : (
                <View style={{ gap: 14 }}>
                  <Text style={s.text}>
                    The OpenBot adapter is available in this open-source project. A live OpenBot
                    backend has not been configured.
                  </Text>
                  <Text style={s.muted}>
                    Your current computer uses OpenMuse’s persistent Chromium worker. OpenBot
                    integration will expand the execution backend while keeping this interface.
                  </Text>
                </View>
              )}
            </Sheet>
          )}
        </>
      )}
    </View>
  );
}
type ServiceHealth = {
  id: string;
  label: string;
  status: "up" | "down" | "not-configured";
  detail: string;
  latencyMs: number | null;
};

function ServicesTab({ api }: { api: MuseApi }) {
  const [services, setServices] = useState<ServiceHealth[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api.request<{ services: ServiceHealth[] }>("/api/health/services");
      setServices(result.services);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const dot = (status: ServiceHealth["status"]) =>
    status === "up" ? "#24A46B" : status === "down" ? "#E5484D" : "#A7AAAC";
  const word = (status: ServiceHealth["status"]) =>
    status === "up" ? "Healthy" : status === "down" ? "Down" : "Not configured";
  return (
    <View style={{ gap: 8 }}>
      <View style={[s.row, { justifyContent: "space-between", alignItems: "center" }]}>
        <Text style={[s.small, { marginLeft: 12 }]}>Service health</Text>
        <Button small busy={busy} onPress={() => void load()}>
          Refresh
        </Button>
      </View>
      {error ? <Text style={[s.small, { color: colors.danger }]}>{error}</Text> : null}
      <View style={{ paddingHorizontal: 16, borderRadius: 23, backgroundColor: "#F3F4F5" }}>
        {services === null && !error ? (
          <Text style={[s.muted, { paddingVertical: 18 }]}>Checking services…</Text>
        ) : (
          (services ?? []).map((svc, index) => (
            <View
              key={svc.id}
              style={[
                s.row,
                {
                  gap: 14,
                  minHeight: 61,
                  borderBottomWidth: index < (services ?? []).length - 1 ? 1 : 0,
                  borderBottomColor: "#E5E7E9",
                },
              ]}
            >
              <View
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 7,
                  backgroundColor: dot(svc.status),
                }}
              />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={s.text}>{svc.label}</Text>
                <Text style={s.small}>{svc.detail}</Text>
              </View>
              <Text style={[s.small, { color: dot(svc.status), fontWeight: "600" }]}>
                {word(svc.status)}
              </Text>
            </View>
          ))
        )}
      </View>
    </View>
  );
}

function ShortcutEditorSheet({
  shortcut,
  onClose,
}: {
  shortcut: ChatShortcut;
  onClose: () => void;
}) {
  const isNew = shortcut.id === "";
  const [label, setLabel] = useState(shortcut.label);
  const [instruction, setInstruction] = useState(shortcut.instruction);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      if (isNew) await addShortcut(label, instruction);
      else await updateShortcut(shortcut.id, { label, instruction });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={isNew ? "Add shortcut" : "Edit shortcut"}
      subtitle="The label shows on the button; the instruction underneath is sent when tapped."
      onClose={onClose}
    >
      <View style={{ gap: 14 }}>
        <Field
          label="Label"
          value={label}
          onChangeText={setLabel}
          placeholder="e.g. Morning briefing"
          maxLength={80}
          autoFocus
        />
        <Field
          label="Instruction"
          value={instruction}
          onChangeText={setInstruction}
          placeholder="e.g. Summarize my unread email from this morning"
          maxLength={4000}
          multiline
        />
        <ErrorNotice error={error} />
        <View style={[s.row, { gap: 10, justifyContent: "flex-end" }]}>
          <Button small onPress={onClose}>
            Cancel
          </Button>
          <Button small primary busy={busy} onPress={() => void save()}>
            Save shortcut
          </Button>
        </View>
      </View>
    </Sheet>
  );
}
function SettingsLine({ label, value }: { label: string; value: string }) {
  return (
    <View
      style={[
        s.between,
        { gap: 15, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.line },
      ]}
    >
      <Text style={s.muted}>{label}</Text>
      <Text style={[s.text, { fontSize: 12, flexShrink: 1, textAlign: "right" }]}>{value}</Text>
    </View>
  );
}

function capabilityLabel(value: string) {
  const scope = value.split("/").at(-1) || value;
  const names: Record<string, string> = {
    "gmail.readonly": "Read Gmail",
    "gmail.send": "Send Gmail",
    "calendar.events.readonly": "Read calendar events",
    "calendar.calendarlist.readonly": "Read calendar list",
    "calendar.events": "Manage calendar events",
    "calendar.readonly": "Read calendars",
  };
  return names[scope] || scope;
}
