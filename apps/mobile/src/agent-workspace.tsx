import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppState, Platform } from "react-native";
import type {
  AgentTask,
  AgentWorkspace,
  CreateTaskInput,
} from "../../../packages/domain/src/agent";
import { setMascotSource } from "./mascot-state";
import { useWorkspace } from "./workspace";

interface AgentContextValue {
  data?: AgentWorkspace;
  error: string;
  refresh: () => Promise<void>;
  mutate: <T>(path: string, body: unknown) => Promise<T>;
  delegate: (input: CreateTaskInput) => Promise<AgentTask>;
}
const AgentContext = createContext<AgentContextValue | null>(null);
export function AgentWorkspaceProvider({ children }: { children: ReactNode }) {
  const { api } = useWorkspace();
  const [data, setData] = useState<AgentWorkspace>();
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const next = await api.request<AgentWorkspace>("/api/agent");
      if (version === requestVersion.current) {
        setData(next);
        setError("");
      }
    } catch (e) {
      if (version === requestVersion.current) setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, [api]);
  useEffect(() => {
    const visible = () =>
      AppState.currentState !== "background" &&
      AppState.currentState !== "inactive" &&
      (Platform.OS !== "web" || typeof document === "undefined" || !document.hidden);
    let polling = false;
    const poll = () => {
      if (!visible() || polling) return;
      polling = true;
      void refresh()
        .catch(() => {})
        .finally(() => {
          polling = false;
        });
    };
    poll();
    const timer = setInterval(poll, 3000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") poll();
    });
    if (Platform.OS === "web" && typeof document !== "undefined")
      document.addEventListener("visibilitychange", poll);
    return () => {
      clearInterval(timer);
      subscription.remove();
      requestVersion.current++;
      if (Platform.OS === "web" && typeof document !== "undefined")
        document.removeEventListener("visibilitychange", poll);
    };
  }, [refresh]);
  const mutate = useCallback(
    async <T,>(path: string, body: unknown): Promise<T> => {
      const result = await api.request<T>(`/api/agent${path}`, body);
      // The successful mutation stays successful even if the following read fails.
      await refresh().catch(() => {});
      return result;
    },
    [api, refresh],
  );
  // Mascot: reflect genuine agent activity — a delegation in flight, a task
  // running on the server (the team is dispatched), or a task waiting on the
  // user's approval. Single writer for the "agent" source.
  const pendingDelegations = useRef(0);
  const reportAgentActivity = useCallback(() => {
    if (pendingDelegations.current > 0) {
      setMascotSource("agent", "delegating");
      return;
    }
    const tasks = data?.tasks ?? [];
    if (tasks.some((task) => task.status === "waiting_approval")) {
      setMascotSource("agent", "awaiting_approval");
      return;
    }
    if (tasks.some((task) => task.status === "running")) {
      setMascotSource("agent", "dispatching");
      return;
    }
    setMascotSource("agent", "idle");
  }, [data]);
  const delegate = useCallback(
    async (input: CreateTaskInput) => {
      // Real work: the task is being handed to the server right now.
      pendingDelegations.current += 1;
      setMascotSource("agent", "delegating");
      try {
        return await mutate<AgentTask>("/tasks", input);
      } finally {
        pendingDelegations.current -= 1;
        reportAgentActivity();
      }
    },
    [mutate, reportAgentActivity],
  );
  useEffect(() => {
    reportAgentActivity();
    return () => setMascotSource("agent", "idle");
  }, [reportAgentActivity]);
  return (
    <AgentContext.Provider value={{ data, error, refresh, mutate, delegate }}>
      {children}
    </AgentContext.Provider>
  );
}
export function useAgentWorkspace() {
  const context = useContext(AgentContext);
  if (!context) throw new Error("Agent workspace is unavailable");
  return context;
}
