import { type BaseEvent, EventType } from "@ag-ui/client";
import type { AgentRunnerConnectRequest, AgentRunnerRunRequest } from "@copilotkit/runtime/v2";
import { InMemoryAgentRunner, ɵGLOBAL_STORE } from "@copilotkit/runtime/v2";
import { Observable, ReplaySubject } from "rxjs";
import type { Store } from "../db.ts";
import { backgroundFailure } from "../log.ts";

/**
 * Pinned against the @copilotkit/runtime store contract (1.70.1). The only
 * internal-API (ɵ) surface this module touches is ɵGLOBAL_STORE, used to
 * rehydrate a thread after a server restart and to snapshot it for saving; a
 * runtime upgrade that moves it breaks compilation here, in one place,
 * rather than silently dropping persistence.
 */
export const THREADS_CONTRACT_REF = "@copilotkit/runtime 1.70.1";

export const CHAT_THREADS_KIND = "chat-threads";

/** Durable per-thread record stored in the server's own database. */
export interface LocalThreadRecord {
  id: string;
  owner: string;
  agentId: string;
  name: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  /** Thread-level message snapshot (AG-UI Message[]) replayed on connect. */
  messages: unknown[];
  /** Compacted AG-UI events across all runs of the thread, replayed on connect. */
  events: unknown[];
}

type OwnerLookup = (agent: unknown) => string | undefined;

/**
 * InMemoryAgentRunner durably backed by the OpenMuse store. The base runner
 * keeps everything in a process-global store that dies with the process; this
 * subclass rehydrates threads from the database before run/connect and saves
 * the snapshot once a run finalizes.
 *
 * Durability boundary: the terminal RUN_FINISHED event is held until the
 * snapshot write completes, so a client never sees a completed run that a
 * restart would lose. A failed write is reported as a visible RUN_ERROR
 * instead of being swallowed.
 */
export class PersistentAgentRunner extends InMemoryAgentRunner {
  /** threadId -> record, so owner/name survive restarts without a scan. */
  private readonly index = new Map<string, LocalThreadRecord>();
  private readonly scanIndex = new Map<string, LocalThreadRecord>();

  constructor(
    private readonly db: Store,
    private readonly ownerOf: OwnerLookup,
  ) {
    super();
  }

  override run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    this.hydrate(request.threadId).then(
      () =>
        this.gatePersistence(super.run(request), request.threadId, request.agent).subscribe(
          subject,
        ),
      (error: unknown) => subject.error(error),
    );
    return subject.asObservable();
  }

  override connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    this.hydrate(request.threadId).then(
      () => void super.connect(request).subscribe(subject),
      // A failed hydration must not break the connection: replay continues
      // from memory (empty for a fresh thread), the failure is logged.
      (error: unknown) => {
        backgroundFailure("chat thread hydration", error);
        super.connect(request).subscribe(subject);
      },
    );
    return subject.asObservable();
  }

  /** Clears in-memory history and every durable record. The runtime handler
   * does not await the returned promise; failures are logged, not thrown. */
  override clearThreads(): Promise<void> {
    super.clearThreads();
    return this.db
      .scan<LocalThreadRecord>(CHAT_THREADS_KIND)
      .then((records) =>
        Promise.all(
          records.map(({ owner, value }) =>
            this.db.remove(value.owner ?? owner, CHAT_THREADS_KIND, value.id),
          ),
        ),
      )
      .then(() => {
        this.index.clear();
        this.scanIndex.clear();
      })
      .catch((error: unknown) => backgroundFailure("chat thread clear", error));
  }

  /**
   * Forward every event except the terminal RUN_FINISHED, which is held until
   * the durable snapshot write settles. The base runner finalizes (appendRun)
   * synchronously after emitting RUN_FINISHED, so the persist defers one
   * macrotask and reads the finalized store.
   */
  private gatePersistence(
    source: Observable<BaseEvent>,
    threadId: string,
    agent: AgentRunnerRunRequest["agent"],
  ): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let finishEvent: BaseEvent | undefined;
      let persisted: Promise<void> | undefined;
      let sourceComplete = false;
      const flush = () => {
        if (!sourceComplete || !persisted) return;
        void persisted.then(
          () => {
            if (!subscriber.closed) {
              if (finishEvent) subscriber.next(finishEvent);
              subscriber.complete();
            }
          },
          (error: unknown) => {
            backgroundFailure("chat thread persistence", error);
            if (!subscriber.closed) {
              subscriber.next({
                type: EventType.RUN_ERROR,
                message:
                  "The run completed but the conversation could not be saved. " +
                  "Check the server database and try again.",
              } as BaseEvent);
              subscriber.complete();
            }
          },
        );
      };
      const subscription = source.subscribe({
        next: (event) => {
          if (event.type === EventType.RUN_FINISHED) {
            finishEvent = event;
            persisted = new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
              this.persist(threadId, agent),
            );
          } else if (!subscriber.closed) {
            subscriber.next(event);
          }
        },
        error: (error: unknown) => {
          if (!subscriber.closed) subscriber.error(error);
        },
        complete: () => {
          sourceComplete = true;
          flush();
        },
      });
      return () => subscription.unsubscribe();
    });
  }

  /** Load a thread's record into the process-global store unless it is already there. */
  private async hydrate(threadId: string): Promise<void> {
    if (ɵGLOBAL_STORE.peek(threadId)) return;
    const record = await this.findRecord(threadId);
    if (!record || ɵGLOBAL_STORE.peek(threadId)) return; // a concurrent run hydrated first
    const store = ɵGLOBAL_STORE.getOrCreate(threadId);
    store.createdAt = Date.parse(record.createdAt);
    store.messagesSnapshot = record.messages as never;
    // One synthetic run holding the persisted events is the canonical
    // post-appendRun shape the base runner itself produces.
    store.historicRuns = [
      {
        threadId,
        runId: "persisted",
        agentId: record.agentId,
        parentRunId: null,
        events: record.events,
        messages: [],
        createdAt: Date.parse(record.createdAt),
      } as never,
    ];
  }

  /** Write the finalized thread snapshot back to the database. */
  private async persist(threadId: string, agent: unknown): Promise<void> {
    const store = ɵGLOBAL_STORE.peek(threadId);
    if (!store) return;
    const prior = await this.findRecord(threadId);
    const owner = this.ownerOf(agent) ?? prior?.owner;
    if (!owner) throw new Error("No owner is associated with the running agent");
    const createdAt = store.createdAt ?? Date.now();
    const record: LocalThreadRecord = {
      id: threadId,
      owner,
      agentId: prior?.agentId ?? "default",
      name: prior?.name ?? null,
      archived: prior?.archived ?? false,
      createdAt: prior?.createdAt ?? new Date(createdAt).toISOString(),
      updatedAt: new Date().toISOString(),
      messages: store.messagesSnapshot as unknown[],
      events: store.historicRuns.flatMap((run) => run.events) as unknown[],
    };
    await this.db.put(owner, CHAT_THREADS_KIND, record);
    this.index.set(threadId, record);
    this.scanIndex.set(threadId, record);
  }

  /** Resolve a record by thread id; owners are not knowable from a thread id alone. */
  private async findRecord(threadId: string): Promise<LocalThreadRecord | null> {
    const cached = this.index.get(threadId) ?? this.scanIndex.get(threadId);
    if (cached) return cached;
    for (const { owner, value } of await this.db.scan<LocalThreadRecord>(CHAT_THREADS_KIND)) {
      this.scanIndex.set(value.id, { ...value, owner: value.owner ?? owner });
      if (value.id === threadId) return this.scanIndex.get(threadId) ?? null;
    }
    return null;
  }
}
