import { createHash, randomUUID } from "node:crypto";
import {
  type JevAction,
  type JevOption,
  type JevPanel,
  type JevToolResult,
  jevActionSchema,
  jevOptionSchema,
  jevPanelSchema,
} from "../../../../packages/domain/src/jev.ts";
import type { Store } from "../db.ts";
import { type JevAdapter, rankJevOptions } from "./adapter.ts";

export type PresentChoicesInput = {
  message: string;
  context: string;
  title: string;
  control: "clarification" | "comparison";
  options: Array<Omit<JevOption, "id"> & { id?: string }>;
  refinementPanelId?: string;
};
type PanelRecord = { id: string; panel: JevPanel; candidates: JevOption[] };
type ThreadRecord = {
  id: string;
  revision: number;
  generation: number;
  currentPanelId?: string | null;
  selectedId?: string | null;
};
export class JevService {
  constructor(
    private readonly deps: { store: Store; adapter: JevAdapter; mode: "sample" | "live" },
  ) {}
  private get store() {
    return this.deps.store;
  }
  private async reserve(
    owner: string,
    threadId: string,
    refinementPanelId?: string,
  ): Promise<ThreadRecord> {
    await this.store.insertIfAbsent(owner, "jev_threads", {
      id: threadId,
      revision: 0,
      generation: 0,
    });
    for (let attempt = 0; attempt < 20; attempt++) {
      const current = await this.store.get<ThreadRecord>(owner, "jev_threads", threadId);
      if (!current) throw new Error("Choices thread is unavailable");
      if (refinementPanelId && current.currentPanelId !== refinementPanelId)
        throw new Error("The earlier choices have been superseded");
      const updated = await this.store.compareAndSwap<ThreadRecord>(
        owner,
        "jev_threads",
        threadId,
        {
          generation: current.generation,
          ...(refinementPanelId ? { currentPanelId: refinementPanelId } : {}),
        },
        { generation: current.generation + 1 },
      );
      if (updated) return updated;
    }
    throw new Error("Choices thread changed too many times; please retry");
  }
  async currentPanel(owner: string, threadId: string): Promise<JevPanel | null> {
    const head = await this.store.get<ThreadRecord>(owner, "jev_threads", threadId);
    if (!head?.currentPanelId) return null;
    const record = await this.store.get<PanelRecord>(owner, "jev_panels", head.currentPanelId);
    return record?.panel ?? null;
  }
  async candidateSources(
    owner: string,
    threadId: string,
    refinementPanelId: string,
  ): Promise<string[]> {
    const head = await this.store.get<ThreadRecord>(owner, "jev_threads", threadId);
    const record = await this.store.get<PanelRecord>(owner, "jev_panels", refinementPanelId);
    if (
      head?.currentPanelId !== refinementPanelId ||
      record?.panel.threadId !== threadId ||
      (this.deps.mode === "live" && record.panel.mode !== "live")
    )
      throw new Error("The earlier choices are unavailable or superseded");
    return [
      ...new Set(record.candidates.flatMap((option) => option.sources.map((source) => source.url))),
    ];
  }
  async createPanel(
    owner: string,
    threadId: string,
    turnId: string,
    input: PresentChoicesInput,
    signal: AbortSignal,
  ): Promise<JevToolResult> {
    signal.throwIfAborted();
    const previous = input.refinementPanelId
      ? await this.store.get<PanelRecord>(owner, "jev_panels", input.refinementPanelId)
      : null;
    const priorHead = input.refinementPanelId
      ? await this.store.get<ThreadRecord>(owner, "jev_threads", threadId)
      : null;
    if (
      input.refinementPanelId &&
      (!previous ||
        previous.panel.threadId !== threadId ||
        priorHead?.currentPanelId !== input.refinementPanelId)
    )
      throw new Error("The earlier choices are unavailable or superseded");
    const candidates = previous
      ? previous.candidates
      : input.options.map((candidate) => {
          const id =
            candidate.id ??
            createHash("sha256")
              .update(
                JSON.stringify({
                  label: candidate.label,
                  details: candidate.details,
                  sources: candidate.sources,
                }),
              )
              .digest("hex")
              .slice(0, 32);
          return jevOptionSchema.parse({ ...candidate, id });
        });
    if (
      candidates.length < 1 ||
      candidates.length > 12 ||
      new Set(candidates.map((o) => o.id)).size !== candidates.length
    )
      throw new Error("Choices need 1–12 distinct options");
    if (input.control === "comparison" && candidates.some((o) => o.sources.length === 0))
      throw new Error("Comparison choices need sources");
    const generation = await this.reserve(owner, threadId, input.refinementPanelId);
    const priorSelectedId = generation.selectedId ?? undefined;
    const decision = await this.deps.adapter.decide(
      {
        message: input.message,
        context: input.context,
        options: candidates,
        allowedControls: [input.control, "agent"],
        selectedId: priorSelectedId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (decision.control === "agent") return { panel: null };
    if (decision.control !== input.control) throw new Error("Jev returned an unexpected control");
    const ranked = rankJevOptions(candidates, decision);
    const visible = decision.control === "comparison" ? ranked.slice(0, 3) : ranked;
    const preferredId =
      previous && priorSelectedId && ranked.some((option) => option.id === priorSelectedId)
        ? priorSelectedId
        : undefined;
    if (preferredId && !visible.some((option) => option.id === preferredId)) {
      const preferred = ranked.find((option) => option.id === preferredId);
      if (preferred) visible[visible.length - 1] = preferred;
    }
    const panel = jevPanelSchema.parse({
      id: randomUUID(),
      threadId,
      turnId,
      candidateSetVersion: generation.generation,
      type: decision.control,
      title: input.title,
      options: visible,
      preferredId,
      mode: this.deps.mode,
    });
    signal.throwIfAborted();
    await this.store.insertIfAbsent(owner, "jev_panels", { id: panel.id, panel, candidates });
    signal.throwIfAborted();
    const head = await this.store.compareAndSwap<ThreadRecord>(
      owner,
      "jev_threads",
      threadId,
      {
        generation: generation.generation,
        revision: generation.revision,
        ...(generation.currentPanelId !== undefined
          ? { currentPanelId: generation.currentPanelId }
          : {}),
        ...(generation.selectedId !== undefined ? { selectedId: generation.selectedId } : {}),
      },
      { revision: generation.generation, currentPanelId: panel.id, selectedId: null },
    );
    if (!head) return { panel: null, error: "These choices were superseded by a newer response." };
    return { panel };
  }
  async select(
    owner: string,
    threadId: string,
    rawAction: JevAction,
  ): Promise<{ continuation: string; panel: JevPanel }> {
    const action = jevActionSchema.parse(rawAction);
    if (action.threadId !== threadId)
      throw new Error("This choice belongs to another conversation");
    const record = await this.store.get<PanelRecord>(owner, "jev_panels", action.panelId);
    if (
      !record ||
      record.panel.threadId !== threadId ||
      record.panel.candidateSetVersion !== action.candidateSetVersion
    )
      throw new Error("This choice is unavailable or out of date");
    const option = record.candidates.find((o) => o.id === action.optionId);
    if (!option || !record.panel.options.some((o) => o.id === action.optionId))
      throw new Error("This option is unavailable");
    const head = await this.store.get<ThreadRecord>(owner, "jev_threads", threadId);
    if (
      !head ||
      head.revision !== action.candidateSetVersion ||
      head.currentPanelId !== action.panelId
    )
      throw new Error("These choices have been superseded");
    if (head.selectedId && head.selectedId !== action.optionId)
      throw new Error("A different choice was already selected");
    if (!head.selectedId) {
      const claimed = await this.store.compareAndSwap<ThreadRecord>(
        owner,
        "jev_threads",
        threadId,
        { revision: head.revision, currentPanelId: action.panelId, selectedId: null },
        { selectedId: action.optionId },
      );
      if (!claimed) {
        const reread = await this.store.get<ThreadRecord>(owner, "jev_threads", threadId);
        if (reread?.selectedId !== action.optionId || reread?.currentPanelId !== action.panelId)
          throw new Error("This choice has changed");
      }
    }
    return {
      continuation: `I choose “${option.label}” from ${record.panel.type} choices. Continue with that preference.`,
      panel: { ...record.panel, selectedId: option.id },
    };
  }
  async noteEvidence(
    owner: string,
    threadId: string,
    runId: string,
    kind: "mail" | "web",
    reference: string,
    text?: string,
  ): Promise<void> {
    const id = `${threadId}:${runId}:${kind}:${createHash("sha256").update(reference).digest("hex")}`;
    if (kind === "web") {
      if (!text?.trim()) return;
      await this.store.put(owner, "jev_evidence", {
        id,
        threadId,
        runId,
        kind,
        reference,
        text: text.slice(0, 30_000),
      });
      return;
    }
    await this.store.insertIfAbsent(owner, "jev_evidence", {
      id,
      threadId,
      runId,
      kind,
      reference,
    });
    await this.store.insertIfAbsent(owner, "jev_mail_evidence", { id: `${threadId}:${runId}` });
  }
  async hasEvidence(
    owner: string,
    threadId: string,
    runId: string,
    kind: "mail" | "web",
    reference: string,
  ): Promise<boolean> {
    const id = `${threadId}:${runId}:${kind}:${createHash("sha256").update(reference).digest("hex")}`;
    return !!(await this.store.get(owner, "jev_evidence", id));
  }
  async hasAnyMailEvidence(owner: string, threadId: string, runId: string): Promise<boolean> {
    return !!(await this.store.get(owner, "jev_mail_evidence", `${threadId}:${runId}`));
  }
  async evidenceText(
    owner: string,
    threadId: string,
    runId: string,
    kind: "web",
    reference: string,
  ): Promise<string | null> {
    const id = `${threadId}:${runId}:${kind}:${createHash("sha256").update(reference).digest("hex")}`;
    const record = await this.store.get<{ text?: string }>(owner, "jev_evidence", id);
    return record?.text?.trim() ? record.text : null;
  }
}
