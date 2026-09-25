import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import {
  CalendarDays,
  Check,
  Clock3,
  Download,
  Edit3,
  ExternalLink,
  FileText,
  Globe2,
  LogOut,
  Mail as MailIcon,
  Reply,
  RotateCw,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Linking, Platform, Text, TextInput, View } from "react-native";
import {
  type ActionProposal,
  type Artifact,
  type BrowserSession,
  type CalendarEvent,
  type EmailDraft,
  type EventDraft,
  emailDraftSchema,
  eventDraftSchema,
  type Mail,
  type ProposalInput,
} from "../../../packages/domain/src";
import { DelegateSheet, NotificationsSheet, TaskDetail } from "./agent-ui";
import BrowserConsole from "./BrowserConsole";
import { browserAddress, browserSite } from "./browser-address";
import { ComputerSheet } from "./computer";
import DateTimeEditor from "./DateTimeEditor";
import { localDateTime, zonedInstant } from "./date-time";
import EmailBody from "./EmailBody";
import { setMascotSource } from "./mascot-state";
import PdfReader from "./PdfReader";
import {
  Button,
  Card,
  CheckRow,
  Chip,
  colors,
  dateLabel,
  Empty,
  ErrorNotice,
  Field,
  IconButton,
  LinkRow,
  resultSummary,
  SectionHeading,
  Sheet,
  s,
  timeLabel,
} from "./ui";
import { UsersScreen } from "./users";
import { type Detail, type ReplyToSnapshot, useWorkspace } from "./workspace";

function AccountSheet() {
  const { sessionUser, logout, close } = useWorkspace();
  return (
    <Sheet
      title="Account & Session"
      subtitle="Manage your current OpenMuse session."
      onClose={close}
    >
      <Card style={{ gap: 14 }}>
        <View style={[s.row, { gap: 12, alignItems: "center" }]}>
          <View
            style={{
              width: 48,
              height: 48,
              borderRadius: 24,
              backgroundColor: colors.sky,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ fontSize: 20, fontWeight: "700", color: colors.blueDark }}>
              {sessionUser.username.slice(0, 1).toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: 16, fontWeight: "600", color: colors.text }}>
              @{sessionUser.username}
            </Text>
            <View style={[s.row, { gap: 8, alignItems: "center" }]}>
              <Chip tint={sessionUser.role === "admin" ? colors.blueDark : undefined}>
                {sessionUser.role.toUpperCase()}
              </Chip>
              <Text style={{ fontSize: 12, color: colors.muted }}>Active session</Text>
            </View>
          </View>
        </View>
        <View style={{ height: 1, backgroundColor: colors.line, marginVertical: 4 }} />
        <Button
          icon={LogOut}
          danger
          onPress={() => {
            close();
            void logout();
          }}
        >
          Log out
        </Button>
      </Card>
    </Sheet>
  );
}

export function Details({ detail }: { detail: Detail }) {
  const { close, navigate } = useWorkspace();
  if (detail.type === "account") return <AccountSheet />;
  if (detail.type === "computer") return <ComputerSheet />;
  if (detail.type === "users") return <UsersScreen />;
  if (detail.type === "task") return <TaskDetail taskId={detail.taskId} />;
  if (detail.type === "delegate") return <DelegateSheet />;
  if (detail.type === "notifications") return <NotificationsSheet />;
  if (detail.type === "mail") return <MailDetail mail={detail.mail} />;
  if (detail.type === "email") return <EmailEditor draft={detail.draft} />;
  if (detail.type === "event")
    return <EventEditor event={detail.event} draft={detail.draft} neighbors={detail.neighbors} />;
  if (detail.type === "file") return <FileDetail file={detail.file} />;
  if (detail.type === "review") return <ReviewDetail initial={detail.action} />;
  if (detail.type === "browser") return <BrowserDetail initial={detail.browser} />;
  return (
    <Sheet title="Your workspace" subtitle="A little room for everything." onClose={close}>
      {[
        { section: "mail" as const, title: "Mail", icon: MailIcon },
        { section: "calendar" as const, title: "Calendar", icon: CalendarDays },
        { section: "browser" as const, title: "Browser", icon: Globe2 },
        { section: "files" as const, title: "Files", icon: FileText },
        { section: "activity" as const, title: "Activity", icon: Clock3 },
        { section: "connections" as const, title: "Connections", icon: ShieldCheck },
      ].map((item) => (
        <LinkRow
          key={item.section}
          title={item.title}
          icon={item.icon}
          onPress={() => {
            navigate(item.section);
            close();
          }}
        />
      ))}
    </Sheet>
  );
}
function MailDetail({ mail: m }: { mail: Mail }) {
  const { workspace: w, api, refresh, open, close } = useWorkspace();
  const [error, setError] = useState("");
  const [importing, setImporting] = useState("");
  async function importAttachment(reference: string) {
    setError("");
    setImporting(reference);
    try {
      const file = await api.request<Artifact>("/api/mail/import-attachment", { reference });
      await refresh();
      open({ type: "file", file });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting("");
    }
  }
  const [thread, setThread] = useState<Mail[]>([m]);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void api
      .request<Mail[]>(`/api/mail/threads/${encodeURIComponent(m.threadId)}`)
      .then((items) => {
        if (active) setThread(items.sort((a, b) => a.date.localeCompare(b.date)));
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, m.threadId, retry]);
  return (
    <Sheet
      title={m.subject}
      subtitle={`${thread.length} message${thread.length === 1 ? "" : "s"} in this conversation`}
      onClose={close}
    >
      {loading && (
        <View style={[s.row, { gap: 10, paddingBottom: 20 }]}>
          <ActivityIndicator color={colors.blueDark} />
          <Text style={s.muted}>Loading the conversation…</Text>
        </View>
      )}
      {thread.map((message) => (
        <Card key={message.id} style={{ marginBottom: 16 }}>
          <View style={s.between}>
            <View style={{ gap: 4, flex: 1 }}>
              <Text style={s.heading}>{message.sender}</Text>
              <Text style={s.small}>{message.from}</Text>
              <Text style={s.small}>To: {message.to.join(", ")}</Text>
            </View>
            <Text style={s.small}>
              {dateLabel(message.date)} · {timeLabel(message.date)}
            </Text>
          </View>
          <View style={s.divider} />
          <EmailBody html={message.bodyHtml} text={message.body} />
          {message.attachments.map((id) => {
            const file = w.files.find((f) => f.id === id);
            return file ? (
              <LinkRow
                key={id}
                title={file.name}
                detail={`${file.pageCount} pages · PDF attachment`}
                icon={FileText}
                onPress={() => open({ type: "file", file })}
              />
            ) : (
              <Button
                key={id}
                busy={importing === id}
                icon={FileText}
                onPress={() => void importAttachment(id)}
              >
                {decodeURIComponent(id.split(":").slice(2).join(":")) || "Open attachment"}
              </Button>
            );
          })}
        </Card>
      ))}
      <ErrorNotice error={error} />
      {error && <Button onPress={() => setRetry(retry + 1)}>Reload conversation</Button>}
      <Button
        primary
        icon={Reply}
        style={{ alignSelf: "flex-start" }}
        onPress={() =>
          open({
            type: "email",
            draft: {
              to: [m.from],
              subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
              body: "",
              cc: [],
              bcc: [],
              attachmentIds: [],
              threadId: m.threadId,
              replyToMessageId: m.id,
              // Snapshot of the original so the compose box can ask the
              // server for an AI-drafted reply without another round-trip.
              replyToSnapshot: {
                from: m.from,
                sender: m.sender,
                subject: m.subject,
                body: m.body.slice(0, 4000),
              },
            },
          })
        }
      >
        Write a reply
      </Button>
    </Sheet>
  );
}
/** Draft opened from the mail UI, plus the quoted original for AI replies. */
type ComposeDraft = Partial<EmailDraft> & {
  id?: string;
  replyToSnapshot?: ReplyToSnapshot;
};
function EmailEditor({ draft }: { draft?: ComposeDraft }) {
  const { workspace: w, api, refresh, open, close, notify } = useWorkspace();
  const [to, setTo] = useState(draft?.to?.join(", ") || "");
  const [cc, setCc] = useState(draft?.cc?.join(", ") || "");
  const [bcc, setBcc] = useState(draft?.bcc?.join(", ") || "");
  const [subject, setSubject] = useState(draft?.subject || "");
  const [body, setBody] = useState(draft?.body || "");
  const [attachments, setAttachments] = useState(draft?.attachmentIds || []);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  function fail(e: unknown) {
    setError(e instanceof Error ? e.message : String(e));
  }
  /** Ask the server to draft a reply to the quoted original message. */
  async function aiReply() {
    if (!draft?.replyToSnapshot || busy) return;
    setBusy("ai");
    setError("");
    try {
      const res = await api.request<{ reply: string }>(
        "/api/email-accounts/ai-reply",
        draft.replyToSnapshot,
      );
      setBody(res.reply);
    } catch (e) {
      fail(e);
    } finally {
      setBusy("");
    }
  }
  /** Ask the server to fix the grammar of the typed message. */
  async function fixGrammar() {
    if (!body.trim() || busy) return;
    setBusy("grammar");
    setError("");
    try {
      const res = await api.request<{ text: string }>("/api/email-accounts/fix-grammar", {
        text: body,
      });
      setBody(res.text);
    } catch (e) {
      fail(e);
    } finally {
      setBusy("");
    }
  }
  function emails(value: string) {
    return value
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  async function save(review: boolean) {
    setBusy(review ? "review" : "draft");
    setError("");
    try {
      const parsed = emailDraftSchema.safeParse({
        to: emails(to),
        cc: emails(cc),
        bcc: emails(bcc),
        subject,
        body,
        attachmentIds: attachments,
        threadId: draft?.threadId,
        replyToMessageId: draft?.replyToMessageId,
      });
      if (!parsed.success)
        throw new Error(
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"),
        );
      if (review) {
        const action = await api.request<ActionProposal>("/api/actions", {
          kind: "email.send",
          data: parsed.data,
        });
        await refresh();
        open({ type: "review", action });
      } else {
        await api.request("/api/drafts", {
          ...parsed.data,
          ...(draft?.id ? { id: draft.id } : {}),
        });
        await refresh();
        notify("Draft saved in OpenMuse.");
        close();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <Sheet
      title={draft?.threadId ? "Write a reply" : "A new message"}
      subtitle={`From ${w.profile.email} · saved privately in OpenMuse`}
      onClose={close}
    >
      <Field
        label="To"
        value={to}
        onChangeText={setTo}
        placeholder="person@example.com"
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <View style={{ flexDirection: "row", gap: 16 }}>
        <View style={{ flex: 1 }}>
          <Field
            label="Cc"
            value={cc}
            onChangeText={setCc}
            placeholder="Optional"
            autoCapitalize="none"
          />
        </View>
        <View style={{ flex: 1 }}>
          <Field
            label="Bcc"
            value={bcc}
            onChangeText={setBcc}
            placeholder="Optional"
            autoCapitalize="none"
          />
        </View>
      </View>
      <Field
        label="Subject"
        value={subject}
        onChangeText={setSubject}
        placeholder="What’s on your mind?"
      />
      <Field
        label="Message"
        value={body}
        onChangeText={setBody}
        multiline
        placeholder="Start your message…"
        style={{ minHeight: 210 }}
      />
      <View style={[s.row, { gap: 10, flexWrap: "wrap", marginBottom: 18 }]}>
        {draft?.replyToSnapshot && (
          <Button
            icon={Sparkles}
            busy={busy === "ai"}
            disabled={!!busy}
            onPress={() => void aiReply()}
          >
            AI reply
          </Button>
        )}
        <Button
          icon={Wand2}
          busy={busy === "grammar"}
          disabled={!!busy || !body.trim()}
          onPress={() => void fixGrammar()}
        >
          Fix grammar
        </Button>
      </View>
      {w.files.length > 0 && (
        <Card style={{ padding: 16, marginBottom: 18 }}>
          <Text style={[s.heading, { fontSize: 13, marginBottom: 5 }]}>Attachments</Text>
          {w.files.map((f) => (
            <CheckRow
              key={f.id}
              checked={attachments.includes(f.id)}
              label={`${f.name} · ${Math.max(1, Math.round(f.size / 1024))} KB`}
              onPress={() =>
                setAttachments(
                  attachments.includes(f.id)
                    ? attachments.filter((id) => id !== f.id)
                    : [...attachments, f.id],
                )
              }
            />
          ))}
        </Card>
      )}
      <ErrorNotice error={error} />
      <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
        <Button
          primary
          icon={ShieldCheck}
          busy={busy === "review"}
          disabled={!!busy}
          onPress={() => void save(true)}
        >
          Review email
        </Button>
        <Button
          icon={Save}
          busy={busy === "draft"}
          disabled={!!busy}
          onPress={() => void save(false)}
        >
          Save draft
        </Button>
      </View>
      <Text style={[s.small, { marginTop: 13 }]}>
        You’ll review the exact recipients, message, and attachments before anything is sent.
      </Text>
    </Sheet>
  );
}
function EventEditor({
  event: e,
  draft,
  neighbors,
}: {
  event?: CalendarEvent;
  draft?: EventDraft;
  neighbors?: CalendarEvent[];
}) {
  const seed = e || draft;
  const { workspace: w, api, open, close, refresh } = useWorkspace();
  // "Sending account" options: saved IMAP/SMTP accounts plus the connected
  // Google account. Defaults to the first (default) email account.
  const [accounts, setAccounts] = useState<{ id: string; label: string; emailAddress: string }[]>(
    [],
  );
  useEffect(() => {
    let active = true;
    void api
      .request<{ id: string; label: string; emailAddress: string }[]>("/api/email-accounts")
      .then((items) => {
        if (active) setAccounts(items);
      })
      .catch(() => {
        // Backend unavailable (e.g. sample mode): no account choices.
      });
    return () => {
      active = false;
    };
  }, [api]);
  const [accountId, setAccountId] = useState(seed?.emailAccountId ?? "");
  const googleConn = w.connections.find((c) => c.id === "google");
  const googleInvites = googleConn?.status === "connected" || googleConn?.status === "sample";
  const selectedAccountId = accountId || accounts[0]?.id || (googleInvites ? "google" : "");
  const initialStart = new Date();
  initialStart.setMinutes(0, 0, 0);
  initialStart.setHours(initialStart.getHours() + 1);
  const [title, setTitle] = useState(seed?.title || "");
  const [start, setStart] = useState(seed?.start || initialStart.toISOString());
  const [end, setEnd] = useState(
    seed?.end || new Date(initialStart.getTime() + 3600000).toISOString(),
  );
  const [allDay, setAllDay] = useState(seed?.allDay || false);
  const [zone, setZone] = useState(
    seed?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [location, setLocation] = useState(seed?.location || "");
  const [description, setDescription] = useState(seed?.description || "");
  const [attendees, setAttendees] = useState(seed?.attendees.join(", ") || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const conflicts = (neighbors || w.events).filter(
    (item) =>
      item.id !== e?.id &&
      Date.parse(start) < Date.parse(item.end) &&
      Date.parse(end) > Date.parse(item.start),
  );
  async function propose(remove = false) {
    setBusy(true);
    setError("");
    try {
      let data: ProposalInput;
      if (remove && e) {
        data = {
          kind: "calendar.delete",
          data: { eventId: e.id, calendarId: e.calendarId, title: e.title },
        };
      } else {
        const parsed = eventDraftSchema.safeParse({
          calendarId: e?.calendarId || draft?.calendarId || "primary",
          title,
          start,
          end,
          allDay,
          timeZone: zone,
          location,
          description,
          attendees: attendees
            .split(/[,;\n]/)
            .map((a) => a.trim())
            .filter(Boolean),
          emailAccountId: selectedAccountId || undefined,
        });
        if (!parsed.success)
          throw new Error(
            parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"),
          );
        data = e
          ? { kind: "calendar.update", data: { ...parsed.data, eventId: e.id } }
          : { kind: "calendar.create", data: parsed.data };
      }
      const action = await api.request<ActionProposal>("/api/actions", data);
      await refresh();
      open({ type: "review", action });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={e ? "Make a little time" : "Something to look forward to"}
      subtitle={
        e ? "Edit this event, then review your changes." : "Create an event in your calendar."
      }
      onClose={close}
    >
      <Field
        label="Event title"
        value={title}
        onChangeText={setTitle}
        placeholder="What are you making time for?"
      />
      <CheckRow
        label="All-day event"
        checked={allDay}
        onPress={() => {
          try {
            if (!allDay) {
              const local = localDateTime(start, zone);
              const endDay = new Date(`${local.date}T12:00:00Z`);
              endDay.setUTCDate(endDay.getUTCDate() + 1);
              setStart(local.date);
              setEnd(endDay.toISOString().slice(0, 10));
            } else {
              setStart(zonedInstant(start, "09:00", zone));
              setEnd(zonedInstant(start, "10:00", zone));
            }
            setAllDay(!allDay);
            setError("");
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }}
      />
      <DateTimeEditor
        label="Starts"
        value={start}
        onChange={setStart}
        timeZone={zone}
        allDay={allDay}
      />
      <DateTimeEditor label="Ends" value={end} onChange={setEnd} timeZone={zone} allDay={allDay} />
      {allDay && (
        <Text style={[s.small, { marginBottom: 15 }]}>
          The end date is the day after the last day of your event.
        </Text>
      )}
      <Field
        label="Time zone"
        value={zone}
        onChangeText={setZone}
        placeholder="America/Los_Angeles"
      />
      <Field
        label="Location or meeting link"
        value={location}
        onChangeText={setLocation}
        placeholder="Optional"
      />
      <Field
        label="Attendees"
        value={attendees}
        onChangeText={setAttendees}
        placeholder="Email addresses, separated by commas"
      />
      <View style={{ gap: 9, marginBottom: 15 }}>
        <Text style={s.label}>Sending account</Text>
        {accounts.length > 0 || googleInvites ? (
          <>
            <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
              {googleInvites && (
                <Button
                  small
                  primary={selectedAccountId === "google"}
                  onPress={() => setAccountId("google")}
                >
                  Google
                </Button>
              )}
              {accounts.map((a) => (
                <Button
                  key={a.id}
                  small
                  primary={selectedAccountId === a.id}
                  onPress={() => setAccountId(a.id)}
                >
                  {a.label}
                </Button>
              ))}
            </View>
            <Text style={s.small}>
              Invites for this event&apos;s attendees go out from this account when the event is
              approved.
            </Text>
          </>
        ) : (
          <Text style={s.small}>
            No email accounts connected yet — add one from Connections → Email accounts to send
            invites from it.
          </Text>
        )}
      </View>
      <Field
        label="Notes"
        value={description}
        onChangeText={setDescription}
        multiline
        placeholder="Anything else to keep in mind?"
      />
      {!!conflicts.length && (
        <Card style={{ backgroundColor: colors.orange, padding: 16, marginBottom: 16 }}>
          <Text style={s.heading}>This time overlaps</Text>
          {conflicts.map((c) => (
            <Text key={c.id} style={s.muted}>
              {c.title} · {timeLabel(c.start, c.timeZone)}–{timeLabel(c.end, c.timeZone)}
            </Text>
          ))}
        </Card>
      )}
      <ErrorNotice error={error} />
      <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
        <Button primary icon={ShieldCheck} busy={busy} onPress={() => void propose()}>
          Review {e ? "changes" : "event"}
        </Button>
        {e && (
          <Button icon={Trash2} disabled={busy} danger onPress={() => void propose(true)}>
            Review deletion
          </Button>
        )}
      </View>
    </Sheet>
  );
}
function ReviewDetail({ initial }: { initial: ActionProposal }) {
  const { workspace: w, api, refresh, close, open } = useWorkspace();
  const [local, setLocal] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const action =
    local.status !== initial.status ? local : w.actions.find((a) => a.id === initial.id) || local;
  const d = action.data;
  const pending = action.status === "awaiting_review";
  async function decide(decision: "approve" | "deny") {
    setBusy(true);
    setError("");
    try {
      const result = await api.request<ActionProposal>(`/api/actions/${action.id}/decide`, {
        decision,
        hash: action.hash,
      });
      setLocal(result);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function edit() {
    setBusy(true);
    setError("");
    try {
      let next: Detail;
      if (action.kind === "email.send")
        next = { type: "email", draft: emailDraftSchema.parse(action.data) };
      else {
        const draft = eventDraftSchema.parse(action.data);
        if (action.kind === "calendar.update") {
          const eventId = action.data.eventId;
          if (typeof eventId !== "string" || !eventId)
            throw new Error("The event reference is missing. Open the event in Calendar again.");
          next = { type: "event", event: { ...draft, id: eventId } };
        } else next = { type: "event", draft };
      }
      await api.request(`/api/actions/${action.id}/decide`, {
        decision: "deny",
        hash: action.hash,
      });
      await refresh();
      open(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const email = action.kind === "email.send";
  const whatsapp = action.kind === "whatsapp.send";
  return (
    <Sheet
      title={pending ? "One last look" : action.title}
      subtitle={
        w.mode === "sample"
          ? "This action stays in your local workspace."
          : "Review this exact action before it changes your connected account."
      }
      onClose={close}
    >
      <View style={[s.row, { gap: 13, marginBottom: 21 }]}>
        <View style={[s.iconBox, { backgroundColor: colors.lavender }]}>
          <ShieldCheck size={22} color={colors.text} />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={s.heading}>{action.title}</Text>
          <Text style={s.small}>{action.kind.replace(".", " · ")}</Text>
        </View>
        <Chip tint={pending ? colors.lavender : colors.green}>
          {action.status.replace(/_/g, " ")}
        </Chip>
      </View>
      <Card style={{ gap: 13 }}>
        {action.kind === "workboard.dispatch" ? (
          <WorkboardDispatchReview data={d} />
        ) : whatsapp ? (
          <>
            <ReviewLine label="From" value={action.account || "WhatsApp"} />
            <ReviewLine label="To" value={String(d.toJid || "")} />
            <View style={s.divider} />
            <Text selectable style={[s.text, { lineHeight: 25 }]}>
              {String(d.text || "")}
            </Text>
            <Text style={s.small}>
              The recipient must be on your WhatsApp allow-list, or the send is refused.
            </Text>
          </>
        ) : (
          <>
            <ReviewLine label="Account" value={action.account || w.profile.email} />
            {email ? (
              <>
                <ReviewLine label="To" value={arrayText(d.to)} />
                <ReviewLine label="Cc" value={arrayText(d.cc) || "None"} />
                <ReviewLine label="Bcc" value={arrayText(d.bcc) || "None"} />
                <ReviewLine label="Subject" value={String(d.subject || "")} />
                <View style={s.divider} />
                <Text selectable style={[s.text, { lineHeight: 25 }]}>
                  {String(d.body || "")}
                </Text>
                <View style={s.divider} />
                <Text style={s.label}>Attachments</Text>
                {Array.isArray(d.attachmentIds) && d.attachmentIds.length ? (
                  d.attachmentIds.map((id) => {
                    const file = w.files.find((f) => f.id === id);
                    return (
                      <Text key={String(id)} style={s.text}>
                        {file?.name || String(id)} · version {String(id).slice(-8)}
                      </Text>
                    );
                  })
                ) : (
                  <Text style={s.muted}>No attachments</Text>
                )}
              </>
            ) : (
              <>
                <ReviewLine label="Event" value={String(d.title || "")} />
                {action.kind !== "calendar.delete" && (
                  <>
                    <ReviewLine
                      label="Starts"
                      value={
                        d.allDay
                          ? String(d.start || "")
                          : `${dateLabel(String(d.start || ""), { year: "numeric", month: "short", day: "numeric", timeZone: String(d.timeZone || "UTC") })} · ${timeLabel(String(d.start || ""), String(d.timeZone || "UTC"))}`
                      }
                    />
                    <ReviewLine
                      label="Ends"
                      value={
                        d.allDay
                          ? `${String(d.end || "")} (exclusive)`
                          : `${dateLabel(String(d.end || ""), { year: "numeric", month: "short", day: "numeric", timeZone: String(d.timeZone || "UTC") })} · ${timeLabel(String(d.end || ""), String(d.timeZone || "UTC"))}`
                      }
                    />
                    <ReviewLine label="Time zone" value={String(d.timeZone || "")} />
                    <ReviewLine label="All day" value={d.allDay ? "Yes" : "No"} />
                    <ReviewLine label="Location" value={String(d.location || "None")} />
                    <ReviewLine label="Attendees" value={arrayText(d.attendees) || "Just you"} />
                    <ReviewLine label="Notes" value={String(d.description || "None")} />
                  </>
                )}
                <ReviewLine label="Calendar" value={String(d.calendarId || "primary")} />
                <Text style={s.small}>
                  {action.kind === "calendar.delete"
                    ? "This removes the event and may notify its attendees."
                    : "Attendees may receive an invitation or update from your connected calendar."}
                </Text>
              </>
            )}
          </>
        )}
      </Card>
      <ErrorNotice error={error || action.error} />
      {action.result && (
        <Card style={{ marginTop: 16, backgroundColor: colors.green, padding: 18 }}>
          <Text selectable style={s.text}>
            {resultSummary(action.result)}
          </Text>
        </Card>
      )}
      {pending ? (
        <>
          <Text style={[s.small, { marginVertical: 17 }]}>
            Review expires{" "}
            {new Date(action.expiresAt).toLocaleString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              timeZoneName: "short",
            })}
            . Your approval applies only to the details shown above.
          </Text>
          <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
            <Button primary icon={Check} busy={busy} onPress={() => void decide("approve")}>
              {w.mode === "sample"
                ? "Approve locally"
                : email || whatsapp
                  ? "Approve & send"
                  : action.kind === "workboard.dispatch"
                    ? "Approve dispatch"
                    : "Approve change"}
            </Button>
            {action.kind !== "calendar.delete" &&
              action.kind !== "workboard.dispatch" &&
              action.kind !== "whatsapp.send" && (
                <Button icon={Edit3} disabled={busy} onPress={() => void edit()}>
                  Edit details
                </Button>
              )}
            <Button icon={X} disabled={busy} onPress={() => void decide("deny")}>
              Don’t proceed
            </Button>
          </View>
        </>
      ) : (
        <Button style={{ alignSelf: "flex-start", marginTop: 19 }} onPress={close}>
          Done
        </Button>
      )}
    </Sheet>
  );
}
function arrayText(value: unknown) {
  return Array.isArray(value) ? value.map(String).join(", ") : "";
}
function ReviewLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.label}>{label}</Text>
      <Text selectable style={s.text}>
        {value}
      </Text>
    </View>
  );
}
/**
 * A workboard fan-out dispatch proposed from chat. Not a calendar event or
 * email: show the card, the subagent count, and each subagent's label +
 * prompt in plain text.
 */
function WorkboardDispatchReview({ data }: { data: Record<string, unknown> }) {
  const cardTitle = typeof data.cardTitle === "string" ? data.cardTitle : "";
  const purpose = typeof data.purpose === "string" ? data.purpose : "";
  const subagents = Array.isArray(data.subagents)
    ? data.subagents.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const { label, prompt } = entry as { label?: unknown; prompt?: unknown };
        return typeof label === "string" && typeof prompt === "string" ? [{ label, prompt }] : [];
      })
    : [];
  return (
    <>
      <ReviewLine label="Card" value={cardTitle || "Untitled"} />
      <ReviewLine
        label="Runs"
        value={`Fan out ${subagents.length} subagent${subagents.length === 1 ? "" : "s"} (spends ${subagents.length} model run${subagents.length === 1 ? "" : "s"})`}
      />
      {!!purpose && purpose !== cardTitle && <ReviewLine label="Purpose" value={purpose} />}
      <View style={s.divider} />
      <Text style={s.label}>Subagents</Text>
      {subagents.map((sub, index) => (
        <View key={`subagent:${sub.label}:${sub.prompt.length}`} style={{ gap: 3 }}>
          <Text style={[s.text, { fontWeight: "600" }]}>
            {index + 1}. {sub.label}
          </Text>
          <Text selectable numberOfLines={3} style={s.muted}>
            {sub.prompt}
          </Text>
        </View>
      ))}
      <Text style={s.small}>
        Approving dispatches the subagents and creates one child card per subagent on the workboard.
      </Text>
    </>
  );
}
function FileDetail({ file: f }: { file: Artifact }) {
  const { api, refresh, open, close } = useWorkspace();
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      (f.fields || [])
        .filter((field) => field.type !== "unsupported")
        .map((field) => [
          field.name,
          field.type === "checkbox" ? field.value === "true" || field.value === "Yes" : field.value,
        ]),
    ),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const url = api.url(f.url || `/api/files/${f.id}/content`);
  async function fill() {
    setBusy(true);
    setError("");
    try {
      const file = await api.request<Artifact>(`/api/files/${f.id}/fill`, { fields: values });
      await refresh();
      open({ type: "file", file });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function share() {
    setError("");
    try {
      if (Platform.OS === "web") {
        await Linking.openURL(url);
        return;
      }
      const target = `${FileSystem.cacheDirectory}${f.id}.pdf`;
      await FileSystem.downloadAsync(url, target, {
        headers: { Authorization: `Bearer ${api.token}` },
      });
      if (await Sharing.isAvailableAsync())
        await Sharing.shareAsync(target, { mimeType: "application/pdf", UTI: "com.adobe.pdf" });
      else throw new Error("Sharing is not available on this device.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <Sheet
      title={f.name}
      subtitle={`${f.pageCount} pages · ${Math.max(1, Math.round(f.size / 1024))} KB · ${f.source}`}
      onClose={close}
      wide
    >
      <PdfReader url={url} token={api.token} pageCount={f.pageCount} />
      <View style={[s.row, { gap: 10, marginVertical: 18, flexWrap: "wrap" }]}>
        <Button icon={Download} onPress={() => void share()}>
          {Platform.OS === "web" ? "Open / download" : "Save or share"}
        </Button>
        <Button
          icon={Send}
          onPress={() => open({ type: "email", draft: { attachmentIds: [f.id] } })}
        >
          Attach to email
        </Button>
      </View>
      {f.fields && f.fields.length > 0 && (
        <Card>
          <SectionHeading title="Fill this form" />
          <Text style={[s.muted, { marginBottom: 18 }]}>
            Add your details below. Saving creates a new copy and keeps the original intact.
          </Text>
          {f.fields.map((field) =>
            field.type === "unsupported" ? (
              <Text key={field.name} style={s.muted}>
                {field.name} · this field type is not supported
              </Text>
            ) : field.type === "checkbox" ? (
              <CheckRow
                key={field.name}
                checked={!!values[field.name]}
                label={field.name.replace(/_/g, " ").replace(/^./, (s) => s.toUpperCase())}
                onPress={() => setValues({ ...values, [field.name]: !values[field.name] })}
              />
            ) : (
              <Field
                key={field.name}
                label={field.name.replace(/_/g, " ").replace(/^./, (s) => s.toUpperCase())}
                value={String(values[field.name] || "")}
                onChangeText={(value) => setValues({ ...values, [field.name]: value })}
              />
            ),
          )}
          <Button primary icon={Save} busy={busy} onPress={() => void fill()}>
            Save filled copy
          </Button>
        </Card>
      )}
      <ErrorNotice error={error} />
      <Text style={[s.small, { marginTop: 15 }]}>
        Added {dateLabel(f.createdAt)}
        {f.parentId ? " · filled copy" : ""}
      </Text>
    </Sheet>
  );
}
function BrowserDetail({ initial }: { initial: BrowserSession }) {
  const { workspace: w, api, refresh, close, notify } = useWorkspace();
  const [local, setLocal] = useState(initial);
  const [url, setUrl] = useState(initial.url);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  // Mascot: navigating/importing in the browser reads as "searching".
  useEffect(() => {
    setMascotSource("browser", busy ? "searching" : "idle");
    return () => setMascotSource("browser", "idle");
  }, [busy]);
  const latest = w.browsers.find((b) => b.id === initial.id);
  const browser = {
    ...(latest && latest.updatedAt > local.updatedAt ? latest : local),
    consoleUrl: local.consoleUrl,
    previewUrl: local.previewUrl,
  };
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void api
      .request<BrowserSession>(`/api/browsers/${initial.id}`)
      .then((session) => {
        if (active) {
          setLocal(session);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [api, initial.id, retry]);
  async function importDownloads() {
    setBusy(true);
    setError("");
    try {
      const result = await api.request<{
        files: Artifact[];
        failures: { name: string; message: string }[];
      }>(`/api/browsers/${browser.id}/import-downloads`, {});
      await refresh();
      if (result.failures.length)
        setError(
          result.failures.map((failure) => `${failure.name}: ${failure.message}`).join("\n"),
        );
      const files = result.files;
      notify(
        files.length
          ? `${files.length} PDF download${files.length === 1 ? "" : "s"} added to Files.`
          : "No new PDF downloads in this session.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function mutate(end = false) {
    if (busy || loading) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.request<BrowserSession>(
        `/api/browsers/${browser.id}/${end ? "close" : browser.status === "closed" ? "reopen" : "navigate"}`,
        end ? {} : { url: browserAddress(url) },
      );
      setLocal(result);
      setUrl(result.url);
      await refresh();
      if (end) close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const browserHeader = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: colors.line,
        backgroundColor: "#FAFBFB",
        gap: 8,
      }}
    >
      <View style={[s.row, { gap: 6, alignItems: "center", flexShrink: 0 }]}>
        <Globe2 size={16} color={colors.blueDark} />
        <Text
          numberOfLines={1}
          style={{ fontWeight: "700", fontSize: 13, color: colors.text, maxWidth: 130 }}
        >
          {browserSite(browser.url)}
        </Text>
        <View
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: browser.status === "active" ? "#10B981" : "#94A3B8",
          }}
        />
      </View>

      <View
        style={[
          s.row,
          {
            flex: 1,
            borderWidth: 1,
            borderColor: colors.line,
            borderRadius: 8,
            paddingHorizontal: 8,
            backgroundColor: "#FFF",
            minHeight: 32,
            alignItems: "center",
          },
        ]}
      >
        <TextInput
          accessibilityLabel="Website address"
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          keyboardType="url"
          placeholder="Enter website address..."
          placeholderTextColor={colors.muted}
          onSubmitEditing={() => void mutate()}
          style={
            {
              flex: 1,
              color: colors.text,
              fontSize: 13,
              paddingVertical: 4,
              outlineStyle: "none",
            } as any
          }
        />
        <Button
          small
          primary
          busy={busy}
          disabled={loading || !url.trim()}
          onPress={() => void mutate()}
          style={{ paddingVertical: 2, paddingHorizontal: 8, minHeight: 24, borderRadius: 6 }}
        >
          {browser.status === "closed" ? "Reopen" : browser.status === "error" ? "Reconnect" : "Go"}
        </Button>
      </View>

      <View style={[s.row, { gap: 2, alignItems: "center", flexShrink: 0 }]}>
        {!loading && browser.status === "active" && browser.consoleUrl && (
          <IconButton
            size={34}
            icon={ExternalLink}
            label="Open in new window"
            onPress={() => void Linking.openURL(api.url(browser.consoleUrl || ""))}
          />
        )}
        {!loading && (
          <IconButton
            size={34}
            icon={RotateCw}
            label="Refresh connection"
            onPress={() => setRetry(retry + 1)}
          />
        )}
        {!loading && browser.status !== "closed" && (
          <IconButton
            size={34}
            icon={Download}
            label="Import PDF downloads"
            onPress={() => void importDownloads()}
          />
        )}
        {!loading && browser.status !== "closed" && (
          <IconButton
            size={34}
            danger
            icon={LogOut}
            label="Close session"
            onPress={() => void mutate(true)}
          />
        )}
        <IconButton size={34} icon={X} label="Close view" onPress={close} />
      </View>
    </View>
  );

  return (
    <Sheet customHeader={browserHeader} onClose={close} wide contentStyle={{ padding: 6 }}>
      <ErrorNotice error={error} />
      {loading ? (
        <View style={[s.row, { gap: 10, paddingVertical: 24, justifyContent: "center" }]}>
          {error ? (
            <Button onPress={() => setRetry(retry + 1)}>Retry connection</Button>
          ) : (
            <>
              <ActivityIndicator color={colors.blueDark} />
              <Text style={s.muted}>Connecting to your browser…</Text>
            </>
          )}
        </View>
      ) : browser.status === "active" && browser.consoleUrl ? (
        <BrowserConsole url={api.url(browser.consoleUrl)} />
      ) : browser.status === "active" && browser.previewUrl ? (
        <Image
          source={{ uri: api.url(browser.previewUrl) }}
          style={{ width: "100%", height: 500, backgroundColor: colors.canvas }}
          resizeMode="contain"
        />
      ) : (
        <Empty
          icon={Globe2}
          title={
            browser.status === "closed" ? "This session is closed" : "Preview is not available"
          }
          detail={
            browser.status === "closed"
              ? "Your profile and downloads are saved. Reopen to continue where you left off."
              : "Reconnect to continue with your saved browser profile."
          }
        />
      )}
    </Sheet>
  );
}
