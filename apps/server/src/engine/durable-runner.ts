import type { BaseEvent, Message } from "@ag-ui/core";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  InMemoryAgentRunner,
  type LocalThreadEndpointRecord,
  type LocalThreadEndpointRunner,
  ɵGLOBAL_STORE,
} from "@copilotkit/runtime/v2";
import { defer, from, mergeAll, type Observable, tap } from "rxjs";
import type { Store } from "../db.ts";
import { backgroundFailure } from "../log.ts";

/**
 * Keeps the runtime's local thread endpoints (/threads list, /threads/:id
 * messages, /state) alive across restarts.
 *
 * The official SSE mode stores threads in a process-level in-memory runner,
 * so a restart loses every conversation. This wraps InMemoryAgentRunner:
 *  - reads are served from our own PGlite store (threads/messages/events/state);
 *  - writes snapshot before each run starts and again when it completes, so a
 *    crash mid-run still leaves the previous run intact.
 *
 * Rows are stored under a fixed owner: the app is a single-user deployment and
 * the runtime's runner interface carries no owner.
 */
const OWNER = "local-user";
const THREADS = "chat-threads";
const MESSAGES = "chat-messages";
const EVENTS = "chat-events";
const STATE = "chat-state";

type StoredMessages = { id: string; messages: Message[] };
type StoredEvents = { id: string; events: BaseEvent[] };
type StoredState = { id: string; state: Record<string, unknown> | null };

export class DurableAgentRunner extends AgentRunner implements LocalThreadEndpointRunner {
  readonly ɵsupportsLocalThreadEndpoints = true as const;
  private readonly inner = new InMemoryAgentRunner();
  private readonly threads = new Map<string, LocalThreadEndpointRecord>();
  private readonly messages = new Map<string, Message[]>();
  private readonly events = new Map<string, BaseEvent[]>();
  private readonly states = new Map<string, Record<string, unknown> | null>();
  private readonly hydrating: Promise<void>;

  constructor(private readonly store: Store) {
    super();
    this.hydrating = this.hydrate();
  }

  /** Read persisted threads back into the in-memory cache at boot. Reads are synchronous, so writes wait on `hydrating`. */
  private async hydrate(): Promise<void> {
    try {
      for (const thread of await this.store.list<LocalThreadEndpointRecord>(OWNER, THREADS))
        this.threads.set(thread.id, thread);
      for (const row of await this.store.list<StoredMessages>(OWNER, MESSAGES))
        this.messages.set(row.id, row.messages ?? []);
      for (const row of await this.store.list<StoredEvents>(OWNER, EVENTS))
        this.events.set(row.id, row.events ?? []);
      for (const row of await this.store.list<StoredState>(OWNER, STATE))
        this.states.set(row.id, row.state ?? null);
    } catch (error) {
      backgroundFailure("durable-runner-hydrate", error);
    }
  }

  /** Merge event streams by runId: stored history first, same-runId runs resolved to the live (newest) copy. */
  private mergeEvents(stored: BaseEvent[], live: BaseEvent[]): BaseEvent[] {
    if (!stored.length) return live;
    if (!live.length) return stored;
    const group = (events: BaseEvent[], tag: string) => {
      const groups = new Map<string, BaseEvent[]>();
      let current = "";
      for (const [index, event] of events.entries()) {
        const runId = (event as { runId?: string }).runId;
        if ((event as { type?: string }).type === "RUN_STARTED" || !current)
          current = runId ?? `${tag}:${index}`;
        const bucket = groups.get(current) ?? [];
        bucket.push(event);
        groups.set(current, bucket);
      }
      return groups;
    };
    const storedGroups = group(stored, "stored");
    const liveGroups = group(live, "live");
    const merged: BaseEvent[] = [];
    for (const key of new Set([...storedGroups.keys(), ...liveGroups.keys()])) {
      const events = liveGroups.get(key) ?? storedGroups.get(key);
      if (events?.length) merged.push(...events);
    }
    return merged;
  }

  /** Merge messages by id: first-seen order wins, same id resolved to the live copy. */
  private mergeMessages(stored: Message[], live: Message[]): Message[] {
    if (!stored.length) return live;
    if (!live.length) return stored;
    const byId = new Map<string, Message>();
    for (const message of stored) byId.set(message.id, message);
    for (const message of live) byId.set(message.id, message);
    return [...byId.values()];
  }

  private async persist(threadId: string): Promise<void> {
    try {
      const live = this.inner.listThreads().find((thread) => thread.id === threadId);
      const previous = this.threads.get(threadId);
      // After a restart the in-memory runner starts empty; overwriting directly
      // would erase history — merge by runId/message id instead.
      const messages = this.mergeMessages(
        this.messages.get(threadId) ?? [],
        this.inner.getThreadMessages(threadId),
      );
      const events = this.mergeEvents(
        this.events.get(threadId) ?? [],
        this.inner.getThreadEvents(threadId),
      );
      const state = this.inner.getThreadState(threadId) ?? this.states.get(threadId) ?? null;
      const now = new Date().toISOString();
      const thread: LocalThreadEndpointRecord = {
        id: threadId,
        name: live?.name ?? previous?.name ?? null,
        agentId: live?.agentId ?? previous?.agentId ?? "default",
        organizationId: "",
        createdById: "",
        archived: false,
        createdAt: previous?.createdAt ?? live?.createdAt ?? now,
        updatedAt: now,
      };
      this.threads.set(threadId, thread);
      this.messages.set(threadId, messages);
      this.events.set(threadId, events);
      this.states.set(threadId, state);
      await this.store.put(OWNER, THREADS, thread);
      await this.store.put(OWNER, MESSAGES, { id: threadId, messages } satisfies StoredMessages);
      await this.store.put(OWNER, EVENTS, { id: threadId, events } satisfies StoredEvents);
      await this.store.put(OWNER, STATE, { id: threadId, state } satisfies StoredState);
    } catch (error) {
      // Persistence failures must never break the conversation itself.
      backgroundFailure("durable-runner-persist", error);
    }
  }

  /**
   * After a restart the in-memory runner is empty: replay persisted events and
   * messages as one "historical run" so connect can rehydrate the conversation
   * and the next run carries full context. Idempotent — skipped when the
   * in-memory store already has events for the thread.
   */
  private seed(threadId: string): void {
    if (this.inner.getThreadEvents(threadId).length) return;
    const events = this.events.get(threadId) ?? [];
    const messages = this.messages.get(threadId) ?? [];
    if (!events.length && !messages.length) return;
    // appendRun silently drops unknown threads, so getOrCreate first.
    ɵGLOBAL_STORE.getOrCreate(threadId);
    ɵGLOBAL_STORE.appendRun(threadId, {
      threadId,
      runId: `seed:${threadId}`,
      agentId: this.threads.get(threadId)?.agentId ?? "default",
      parentRunId: null,
      events,
      messages,
      createdAt: Date.now(),
    });
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    return defer(() =>
      from(
        (async () => {
          await this.hydrating;
          this.seed(request.threadId);
          void this.persist(request.threadId);
          return this.inner
            .run(request)
            .pipe(tap({ complete: () => void this.persist(request.threadId) }));
        })(),
      ).pipe(mergeAll()),
    );
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    return defer(() =>
      from(
        (async () => {
          await this.hydrating;
          if (request.threadId) this.seed(request.threadId);
          return this.inner.connect(request);
        })(),
      ).pipe(mergeAll()),
    );
  }

  isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    return this.inner.isRunning(request);
  }

  async stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    const stopped = await this.inner.stop(request);
    await this.persist(request.threadId);
    return stopped;
  }

  listThreads(): LocalThreadEndpointRecord[] {
    return [...this.threads.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  getThreadMessages(threadId: string): Message[] {
    return this.messages.get(threadId) ?? [];
  }

  getThreadEvents(threadId: string): BaseEvent[] {
    return this.events.get(threadId) ?? [];
  }

  getThreadState(threadId: string): Record<string, unknown> | null {
    return this.states.get(threadId) ?? null;
  }

  clearThreads(): void {
    this.inner.clearThreads();
    this.threads.clear();
    this.messages.clear();
    this.events.clear();
    this.states.clear();
    void (async () => {
      try {
        for (const kind of [THREADS, MESSAGES, EVENTS, STATE]) {
          for (const row of await this.store.list<{ id: string }>(OWNER, kind))
            await this.store.remove(OWNER, kind, row.id);
        }
      } catch (error) {
        backgroundFailure("durable-runner-clear", error);
      }
    })();
  }
}
