import { type BaseEvent, EventType } from "@ag-ui/client";
import type { AgentRunnerConnectRequest, AgentRunnerRunRequest } from "@copilotkit/runtime/v2";
import { InMemoryAgentRunner, ɵGLOBAL_STORE } from "@copilotkit/runtime/v2";
import { type AnySummarizeAdapter, summarize } from "@tanstack/ai";
import { anthropicSummarize } from "@tanstack/ai-anthropic";
import { geminiSummarize } from "@tanstack/ai-gemini";
import { openaiSummarize } from "@tanstack/ai-openai";
import { Observable, ReplaySubject } from "rxjs";
import type { Store } from "../db.ts";
import { backgroundFailure } from "../log.ts";

export const THREADS_CONTRACT_REF = "@copilotkit/runtime 1.70.1";

export const CHAT_THREADS_KIND = "chat-threads";

const TITLE_MAX_LENGTH = 60;

/** Turns a user's opening message into a conversation title, or null to skip. */
export type TitleGenerator = (text: string) => Promise<string | null>;

/**
 * Single-line title text capped at TITLE_MAX_LENGTH chars. Newlines collapse
 * to spaces so a message never breaks the one-line thread list layout.
 */
export function fallbackTitle(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.slice(0, TITLE_MAX_LENGTH);
}

function cleanTitle(summary: string): string | null {
  const title = summary
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return title ? fallbackTitle(title) : null;
}

/**
 * Default title chain: ask the configured model for a short title (mirroring
 * the Intelligence backend's generateThreadNames), and fall back to a plain
 * truncation of the first user message when the model is unconfigured or the
 * call fails.
 */
export function defaultTitleGenerator(model: string | undefined): TitleGenerator {
  return async (text) => {
    const clip = fallbackTitle(text);
    if (!clip) return null;
    const [, provider = "", modelId = ""] = model?.trim().match(/^([^/:]*)[/:](.*)$/) ?? [];
    if (!provider || !modelId.trim()) return clip;
    try {
      const id = modelId.trim();
      const adapter = (
        provider.toLowerCase() === "openai"
          ? openaiSummarize(id as never, { baseURL: process.env.OPENAI_BASE_URL } as never)
          : provider.toLowerCase() === "anthropic"
            ? anthropicSummarize(id as never, { baseURL: process.env.ANTHROPIC_BASE_URL } as never)
            : provider.toLowerCase() === "google"
              ? geminiSummarize(
                  id as never,
                  {
                    baseURL: process.env.GOOGLE_GENERATIVE_AI_BASE_URL,
                  } as never,
                )
              : null
      ) as AnySummarizeAdapter | null;
      if (!adapter) return clip;
      const result = await summarize({ adapter, text: clip, maxLength: 10, style: "concise" });
      return cleanTitle(result.summary) ?? clip;
    } catch {
      // A title must never surface as a chat error; the truncated message is
      // a perfectly good stand-in.
      return clip;
    }
  };
}

/** One persisted run: its compacted events, keyed for merge-on-write. */
export interface LocalThreadRun {
  runId: string;
  createdAt: string;
  events: unknown[];
}

/**
 * Durable per-thread record stored in the server's own database. `runs` grows
 * incrementally: memory eviction in the base runner may drop old runs from
 * the in-memory store, so a persist must merge new runs into the stored set
 * instead of overwriting it. `events` is the v1 shape, read for migration.
 */
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
  runs: LocalThreadRun[];
  /** v1 records stored all events at thread level; migrated on read. */
  events?: unknown[];
}

type OwnerLookup = (agent: unknown) => string | undefined;

type MessageLike = { role?: unknown; content?: unknown };

/** Plain text of the first user message in a snapshot, for titling. */
function firstUserText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (const raw of messages) {
    const message = raw as MessageLike;
    if (message?.role !== "user") continue;
    if (typeof message.content === "string" && message.content.trim())
      return message.content.trim();
    if (Array.isArray(message.content)) {
      for (const part of message.content as { type?: unknown; text?: unknown }[]) {
        if (part && part.type === "text" && typeof part.text === "string" && part.text.trim())
          return part.text.trim();
      }
    }
  }
  return null;
}

/** The historic-run fields this class reads, decoupled from runtime internals. */
type HistoricRun = {
  runId?: unknown;
  createdAt?: unknown;
  events?: unknown;
};

/**
 * InMemoryAgentRunner durably backed by the OpenMuse store. The base runner
 * keeps everything in a process-global store that dies with the process; this
 * subclass rehydrates threads from the database before run/connect and merges
 * each finalized run into the durable record.
 *
 * Durability boundary: the terminal RUN_FINISHED event is held until the
 * snapshot write completes, so a client never sees a completed run that a
 * restart would lose. A failed write on a successful run is reported as a
 * visible RUN_ERROR; a failed run always terminates the stream cleanly.
 */
export class PersistentAgentRunner extends InMemoryAgentRunner {
  /** threadId -> record, so owner/name survive restarts without a scan. */
  private readonly index = new Map<string, LocalThreadRecord>();
  private readonly scanIndex = new Map<string, LocalThreadRecord>();

  constructor(
    private readonly db: Store,
    private readonly ownerOf: OwnerLookup,
    private readonly titleGenerator: TitleGenerator = () => Promise.resolve(null),
  ) {
    super();
  }

  override run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    this.hydrate(request.threadId).then(
      () => {
        // A concurrent run on the thread throws synchronously; deliver it as
        // an observable error instead of an unhandled rejection or a hang.
        let source: Observable<BaseEvent>;
        try {
          source = super.run(request);
        } catch (error) {
          subject.error(error);
          return;
        }
        this.gatePersistence(source, request.threadId, request.agent).subscribe(subject);
      },
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

  /** Memory-only clear for the app route: durable rows are deleted per owner there. */
  clearMemory(): void {
    super.clearThreads();
    this.index.clear();
    this.scanIndex.clear();
  }

  /** Forget one thread in memory; the app route deletes the durable row per owner. */
  deleteThread(threadId: string): void {
    const store = ɵGLOBAL_STORE.peek(threadId);
    if (store) {
      // removeThread exists at runtime (in-memory.mjs:222) but is typed private;
      // the runner has no single-thread delete, so reach the one store primitive.
      (ɵGLOBAL_STORE as unknown as { removeThread(id: string, store: unknown): void }).removeThread(
        threadId,
        store,
      );
    }
    this.index.delete(threadId);
    this.scanIndex.delete(threadId);
  }

  /** Keep the runner's caches in step after the app layer renames/archives a thread. */
  syncRecord(record: LocalThreadRecord): void {
    this.index.set(record.id, record);
    this.scanIndex.set(record.id, record);
  }

  /**
   * Forward every event except the terminal RUN_FINISHED, which is held until
   * the durable write settles. The base runner finalizes (appendRun)
   * synchronously after emitting RUN_FINISHED, so the persist defers one
   * macrotask and reads the finalized store. A run that ends without
   * RUN_FINISHED (internal failure) still persists what ran and completes.
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
      const close = (errorEvent: BaseEvent | undefined) => {
        if (subscriber.closed) return;
        if (errorEvent) subscriber.next(errorEvent);
        subscriber.complete();
      };
      const flush = () => {
        if (!sourceComplete) return;
        if (persisted) {
          void persisted.then(
            () => close(finishEvent),
            (error: unknown) => {
              backgroundFailure("chat thread persistence", error);
              close({
                type: EventType.RUN_ERROR,
                message:
                  "The run completed but the conversation could not be saved. " +
                  "Check the server database and try again.",
              } as BaseEvent);
            },
          );
        } else {
          // No RUN_FINISHED means the run already failed; the runner appended
          // a RUN_ERROR. Save what exists (best effort) and close the stream.
          void new Promise<void>((resolve) => setImmediate(resolve))
            .then(() => this.persist(threadId, agent))
            .catch((error: unknown) => backgroundFailure("chat thread persistence", error))
            .finally(() => close(undefined));
        }
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
    // Rebuild historic runs exactly as appendRun would have produced them, so
    // connect/replay and further appends work unchanged.
    store.historicRuns = this.recordRuns(record).map(
      (run) =>
        ({
          threadId,
          runId: run.runId,
          agentId: record.agentId,
          parentRunId: null,
          events: run.events,
          messages: [],
          createdAt: Date.parse(run.createdAt),
        }) as never,
    );
  }

  /** Write the finalized thread snapshot back, merging runs already stored. */
  private async persist(threadId: string, agent: unknown): Promise<void> {
    const store = ɵGLOBAL_STORE.peek(threadId);
    if (!store) return;
    const prior = await this.findRecord(threadId);
    const owner = this.ownerOf(agent) ?? prior?.owner;
    if (!owner) throw new Error("No owner is associated with the running agent");
    const priorRuns = prior ? this.recordRuns(prior) : [];
    const known = new Set(priorRuns.map((run) => run.runId));
    const freshRuns = (store.historicRuns as HistoricRun[])
      .filter(
        (run) =>
          typeof run.runId === "string" &&
          run.runId !== "persisted" &&
          !known.has(run.runId) &&
          Array.isArray(run.events),
      )
      .map((run) => ({
        runId: run.runId as string,
        createdAt: new Date(Number(run.createdAt) || Date.now()).toISOString(),
        events: run.events as unknown[],
      }));
    // A run that produced no events (immediate failure) must not create an
    // empty or clobbering record; the prior durable state is authoritative.
    if (freshRuns.length === 0) return;
    const record: LocalThreadRecord = {
      id: threadId,
      owner,
      agentId: prior?.agentId ?? "default",
      name: prior?.name ?? null,
      archived: prior?.archived ?? false,
      createdAt: prior?.createdAt ?? new Date(store.createdAt ?? Date.now()).toISOString(),
      updatedAt: new Date().toISOString(),
      messages: store.messagesSnapshot as unknown[],
      runs: [...priorRuns, ...freshRuns],
    };
    await this.db.put(owner, CHAT_THREADS_KIND, record);
    this.index.set(threadId, record);
    this.scanIndex.set(threadId, record);
    if (record.name === null) this.titleThread(record);
  }

  /**
   * Name an untitled thread after its first run. Fire-and-forget: a title is
   * cosmetic and must never delay RUN_FINISHED or surface as a chat error.
   * An untitled record is retried on the next persist, so a transient model
   * failure self-heals.
   */
  private titleThread(record: LocalThreadRecord): void {
    const text = firstUserText(record.messages);
    if (!text) return;
    void this.titleGenerator(text)
      .then((title) => {
        if (!title) return;
        const current = this.index.get(record.id) ?? this.scanIndex.get(record.id);
        // The thread may have been renamed or deleted while the title call was in flight.
        if (!current || current.name !== null) return;
        const named = { ...current, name: title };
        return this.db.put(current.owner, CHAT_THREADS_KIND, named).then(() => {
          this.index.set(record.id, named);
          this.scanIndex.set(record.id, named);
        });
      })
      .catch((error: unknown) => backgroundFailure("chat thread titling", error));
  }

  /** Runs of a record, migrating the v1 thread-level `events` shape on read. */
  private recordRuns(record: LocalThreadRecord): LocalThreadRun[] {
    if (Array.isArray(record.runs) && record.runs.length > 0) return record.runs;
    if (Array.isArray(record.events) && record.events.length > 0)
      return [{ runId: "migrated", createdAt: record.createdAt, events: record.events }];
    return [];
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
