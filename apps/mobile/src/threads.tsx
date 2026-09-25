import {
  CalendarDays,
  FileText,
  MessageCircle,
  Monitor,
  Plus,
  Settings2,
} from "lucide-react-native";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { Button, colors, LinkRow, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

function newThreadId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface StoredSideChat {
  id: string;
  name: string;
  createdAt: string;
}

const STORAGE_KEY = "openmuse_side_threads";

function loadStoredThreads(): StoredSideChat[] {
  if (Platform.OS === "web" && typeof window !== "undefined" && window.localStorage) {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // ignore
    }
  }
  return [];
}

function saveStoredThreads(threads: StoredSideChat[]) {
  if (Platform.OS === "web" && typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(threads));
    } catch {
      // ignore
    }
  }
}

export type Selection = { id: string; existing: boolean };

const ThreadContext = createContext<{
  enabled: boolean;
  selection: Selection;
  visited: Selection[];
  sideChats: StoredSideChat[];
  mainId: string;
  loading: boolean;
  error: string;
  retry: () => void;
  select: (selection: Selection) => void;
  start: (customName?: string) => string;
  removeThread: (id: string) => void;
  renameThread: (id: string, name: string) => void;
  claimPrompt: (id: number) => boolean;
} | null>(null);

export function ThreadsProvider({ children }: { children: ReactNode }) {
  const { workspace, navigate, api } = useWorkspace();
  const handledPrompt = useRef(0);
  const enabled = workspace.runtime.richThreads === true;

  const [sideChats, setSideChats] = useState<StoredSideChat[]>(() => loadStoredThreads());
  const [mainId, setMainId] = useState("main");
  const [selection, setSelection] = useState<Selection>({ id: "main", existing: true });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  const visited: Selection[] = [
    { id: mainId, existing: true },
    ...sideChats.filter((s) => s.id !== mainId).map((s) => ({ id: s.id, existing: true })),
    ...(selection.id !== mainId && !sideChats.some((s) => s.id === selection.id)
      ? [selection]
      : []),
  ];

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    setError("");
    void api
      .request<{ threadId: string; existing: boolean }>("/api/main-thread")
      .then((main) => {
        if (!active) return;
        const nextId = main.threadId;
        setMainId(nextId);
        setSelection((curr) =>
          curr.id === "main" ? { id: nextId, existing: main.existing } : curr,
        );
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
    navigate("chat");
  }

  function start(customName?: string): string {
    const id = newThreadId();
    const count = sideChats.length + 1;
    const name = customName || `Side chat ${count}`;
    const newChat: StoredSideChat = {
      id,
      name,
      createdAt: new Date().toISOString(),
    };
    const updated = [newChat, ...sideChats];
    setSideChats(updated);
    saveStoredThreads(updated);
    setSelection({ id, existing: false });
    navigate("chat");
    return id;
  }

  function removeThread(id: string) {
    const updated = sideChats.filter((t) => t.id !== id);
    setSideChats(updated);
    saveStoredThreads(updated);
    if (selection.id === id) {
      setSelection({ id: mainId, existing: true });
    }
  }

  function renameThread(id: string, name: string) {
    const updated = sideChats.map((t) => (t.id === id ? { ...t, name: name.trim() } : t));
    setSideChats(updated);
    saveStoredThreads(updated);
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
        sideChats,
        loading,
        error,
        retry: () => setAttempt((n) => n + 1),
        selection,
        select,
        start,
        removeThread,
        renameThread,
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

export function ThreadsSheet({ onClose }: { onClose: () => void }) {
  const { selection, sideChats, mainId, select, start } = useMuseThread();
  const { workspace, open, navigate } = useWorkspace();

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
        </View>
        {sideChats.length === 0 ? (
          <Text style={s.muted}>
            Keep a separate topic here. Your main chat is always available.
          </Text>
        ) : (
          sideChats.map((thread) => (
            <Pressable
              key={thread.id}
              accessibilityRole="button"
              accessibilityLabel={`Open conversation: ${thread.name}`}
              accessibilityState={{ selected: selection.id === thread.id }}
              onPress={() => {
                select({ id: thread.id, existing: true });
                onClose();
              }}
              style={[
                s.row,
                {
                  paddingVertical: 10,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.line,
                  gap: 10,
                },
              ]}
            >
              <MessageCircle size={19} color={colors.text} />
              <Text style={[s.text, { flex: 1 }]}>{thread.name}</Text>
            </Pressable>
          ))
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
      </View>
    </Sheet>
  );
}
