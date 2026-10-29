import { useThreads } from "@copilotkit/react-native/headless";
import {
  Archive,
  ArchiveRestore,
  CalendarDays,
  FileText,
  MessageCircle,
  Monitor,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react-native";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Button, colors, ErrorNotice, Field, LinkRow, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

function newThreadId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export type Selection = { id: string; existing: boolean };
const ThreadContext = createContext<{
  enabled: boolean;
  selection: Selection;
  visited: Selection[];
  mainId: string;
  loading: boolean;
  error: string;
  retry: () => void;
  select: (selection: Selection) => void;
  start: () => void;
  removeVisited: (id: string) => void;
  claimPrompt: (id: number) => boolean;
} | null>(null);
export function ThreadsProvider({ children }: { children: ReactNode }) {
  const { workspace, navigate, api } = useWorkspace();
  const handledPrompt = useRef(0);
  const enabled = workspace.runtime.richThreads === true;
  const [selection, setSelection] = useState<Selection>({ id: "local", existing: false });
  const [visited, setVisited] = useState<Selection[]>([]);
  const [mainId, setMainId] = useState("local");
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    setError("");
    void api
      .request<{ threadId: string; existing: boolean }>("/api/main-thread")
      .then((main) => {
        if (!active) return;
        const next = { id: main.threadId, existing: main.existing };
        setMainId(next.id);
        setSelection(next);
        setVisited([next]);
        setLoading(false);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [api, enabled, attempt]);
  function select(next: Selection) {
    setSelection(next);
    setVisited((items) => (items.some((item) => item.id === next.id) ? items : [...items, next]));
    navigate("chat");
  }
  return (
    <ThreadContext.Provider
      value={{
        claimPrompt: (id) => {
          if (handledPrompt.current === id) return false;
          handledPrompt.current = id;
          return true;
        },
        enabled,
        mainId,
        visited,
        loading,
        error,
        retry: () => setAttempt((n) => n + 1),
        selection,
        select,
        start: () => select({ id: newThreadId(), existing: false }),
        removeVisited: (id) => {
          setVisited((items) => items.filter((item) => item.id !== id));
          if (selection.id === id) select({ id: mainId, existing: true });
        },
      }}
    >
      {children}
    </ThreadContext.Provider>
  );
}
export function useMuseThread() {
  const context = useContext(ThreadContext);
  if (!context) throw new Error("Threads provider is unavailable");
  return context;
}

type ThreadSummary = { id: string; name: string | null; archived: boolean };

/**
 * One saved conversation row. The layout matches the Intelligence backend:
 * the title sits on its own line, and a row of small labeled buttons
 * (Rename / Archive|Restore / Delete) sits beneath it.
 */
function ThreadRow({
  thread,
  selected,
  editing,
  busy,
  draft,
  onDraft,
  onOpen,
  onSave,
  onArchive,
  onDelete,
}: {
  thread: ThreadSummary;
  selected: boolean;
  editing: boolean;
  busy: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onOpen: () => void;
  onSave: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const title = thread.name || "Untitled conversation";
  return (
    <View
      style={{
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.line,
        gap: 10,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open conversation: ${title}`}
        accessibilityState={{ selected }}
        onPress={onOpen}
        style={[s.row, { gap: 10 }]}
      >
        <MessageCircle size={19} color={colors.text} />
        <Text style={[s.text, { flex: 1 }]} numberOfLines={1} ellipsizeMode="tail">
          {title}
        </Text>
      </Pressable>
      {editing && (
        <Field label="Conversation name" value={draft} onChangeText={onDraft} autoFocus />
      )}
      <View style={[s.row, { gap: 8 }]}>
        <Button small disabled={busy || (editing && !draft.trim())} onPress={onSave}>
          {editing ? "Save name" : "Rename"}
        </Button>
        <Button
          small
          icon={thread.archived ? ArchiveRestore : Archive}
          disabled={busy}
          onPress={onArchive}
        >
          {thread.archived ? "Restore" : "Archive"}
        </Button>
        <Button small icon={Trash2} danger disabled={busy} onPress={onDelete}>
          Delete
        </Button>
      </View>
    </View>
  );
}
export function ThreadsSheet({ onClose }: { onClose: () => void }) {
  const {
    enabled,
    selection,
    visited,
    mainId,
    loading,
    error: mainError,
    retry,
    select,
    start,
    removeVisited,
  } = useMuseThread();
  const { workspace, open, navigate, refresh } = useWorkspace();
  const threads = useThreads({ agentId: "default", enabled, includeArchived: true, limit: 20 });
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [archived, setArchived] = useState(false);
  async function mutate(action: () => Promise<void>) {
    setError("");
    try {
      await action();
      setEditing(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  function go(section: "calendar" | "files" | "apps") {
    onClose();
    navigate(section);
  }
  return (
    <Sheet
      title="OpenMuse"
      subtitle={workspace.mode === "sample" ? "Your workspace" : workspace.profile.name}
      onClose={onClose}
    >
      <View style={{ gap: 14 }}>
        {enabled && loading ? (
          <>
            <ErrorNotice error={mainError} />
            {mainError ? (
              <Button onPress={retry}>Retry main chat</Button>
            ) : (
              <ActivityIndicator color={colors.blueDark} />
            )}
          </>
        ) : enabled ? (
          <>
            <LinkRow
              icon={MessageCircle}
              title="Main chat"
              detail="Your ongoing conversation"
              onPress={() => {
                select({ id: mainId, existing: true });
                onClose();
              }}
            />
            <Button
              primary
              icon={Plus}
              onPress={() => {
                start();
                onClose();
              }}
            >
              New side chat
            </Button>
            <View style={[s.between, { marginTop: 12 }]}>
              <Text style={s.heading}>Side chats</Text>
              <Button small onPress={() => setArchived(!archived)}>
                {archived ? "Show active" : "Archived"}
              </Button>
            </View>
            {threads.isLoading && <ActivityIndicator color={colors.blueDark} />}
            <ErrorNotice error={error || threads.error?.message} />
            {threads.error && (
              <Button small onPress={threads.refetchThreads}>
                Retry conversations
              </Button>
            )}
            {!archived &&
              visited
                .filter(
                  (item) =>
                    item.id !== mainId && !threads.threads.some((saved) => saved.id === item.id),
                )
                .map((item, index) => (
                  <LinkRow
                    key={item.id}
                    icon={MessageCircle}
                    title={`Side chat ${index + 1}`}
                    detail="Open in this app"
                    onPress={() => {
                      select(item);
                      onClose();
                    }}
                  />
                ))}
            {threads.threads
              .filter((thread) => thread.id !== mainId && thread.archived === archived)
              .map((thread) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  selected={selection.id === thread.id}
                  editing={editing === thread.id}
                  busy={threads.isMutating}
                  draft={name}
                  onDraft={setName}
                  onOpen={() => {
                    select({ id: thread.id, existing: true });
                    onClose();
                  }}
                  onSave={() => {
                    if (editing === thread.id)
                      void mutate(() => threads.renameThread(thread.id, name.trim()));
                    else {
                      setEditing(thread.id);
                      setName(thread.name || "");
                    }
                  }}
                  onArchive={() =>
                    void mutate(() =>
                      thread.archived
                        ? threads.unarchiveThread(thread.id)
                        : threads.archiveThread(thread.id),
                    )
                  }
                  onDelete={() =>
                    void mutate(async () => {
                      await threads.deleteThread(thread.id);
                      removeVisited(thread.id);
                    })
                  }
                />
              ))}
            {!threads.isLoading &&
              !threads.error &&
              !threads.threads.some(
                (thread) => thread.id !== mainId && thread.archived === archived,
              ) && (
                <Text style={s.muted}>
                  {archived
                    ? "No archived conversations."
                    : "Keep a separate topic here. Your main chat is always available."}
                </Text>
              )}
            <ErrorNotice error={threads.fetchMoreError?.message} />
            {threads.hasMoreThreads && (
              <Button small busy={threads.isFetchingMoreThreads} onPress={threads.fetchMoreThreads}>
                Load more conversations
              </Button>
            )}
            <Text style={s.small}>
              Side chats keep their own conversation context. Your agent’s saved memory is shared.
            </Text>
          </>
        ) : (
          <>
            <LinkRow
              icon={MessageCircle}
              title="Main chat"
              detail="Saved in this workspace"
              onPress={() => {
                navigate("chat");
                onClose();
              }}
            />
            <Text style={s.muted}>
              Your conversation is saved in this workspace. You can manage connections in Apps.
            </Text>
          </>
        )}
        <View style={s.divider} />
        <LinkRow
          icon={Plus}
          title="Delegate task"
          detail="A plan, document, or spending summary"
          onPress={() => {
            onClose();
            open({ type: "delegate" });
          }}
        />
        <LinkRow
          icon={Monitor}
          title="Agent computer"
          detail="Browser, sessions and documents"
          onPress={() => {
            onClose();
            open({ type: "computer" });
          }}
        />
        <LinkRow icon={CalendarDays} title="Calendar" onPress={() => go("calendar")} />
        <LinkRow icon={FileText} title="Files" onPress={() => go("files")} />
        <LinkRow icon={Settings2} title="Apps & settings" onPress={() => go("apps")} />
        <Button small icon={RefreshCw} onPress={() => void mutate(refresh)}>
          Refresh workspace
        </Button>
      </View>
    </Sheet>
  );
}
