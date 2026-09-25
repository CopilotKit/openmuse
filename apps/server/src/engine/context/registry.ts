/**
 * Deterministic context-resource registry (phase 1: selection + fallbacks).
 *
 * A ContextResource is one named prompt section with a priority, a cheap
 * size estimate, an async materializer, and an optional static fallback.
 * ContextRegistry.assemble() picks sections by priority within a character
 * budget, substitutes the fallback when a section does not fit, drops
 * sections without a fallback, and quarantines sections whose estimate or
 * materializer throws.
 *
 * Security properties:
 * - estimateChars() must be cheap and honest (capped pre-read for DB
 *   resources); assemble() truncates a materialized section that exceeds
 *   its estimate by more than 2x (lying/mutated resource defense).
 * - Fallbacks are static author-authored strings, never derived from
 *   user/tool data.
 * - Only resource ids are ever logged; section contents are never logged.
 * - Selection order is priority descending with an id tiebreak, pinned by
 *   test, so safety sections cannot be reordered below attacker-influenced
 *   content.
 */

export interface ContextResource {
  /** Stable id, safe to log/expose: lowercase letters, digits, dashes. */
  id: string;
  /** Higher wins. Ties break by id ascending (deterministic). */
  priority: number;
  /** Cheap honest size estimate in chars; must not do expensive I/O. */
  estimateChars: () => number;
  /** Render the section body. May be async. Throwing quarantines the resource. */
  materialize: () => string | Promise<string>;
  /** Static author-authored substitute used when over budget or quarantined. */
  fallback?: string;
}

export interface ContextPlan {
  budgetChars: number;
  usedChars: number;
  /** Resource ids included at full length, in prompt order. */
  included: string[];
  /** Resource ids substituted with their static fallback, in prompt order. */
  fellBack: string[];
  /** Resource ids excluded (over budget without usable fallback, or empty). */
  dropped: string[];
  /** Resource ids whose estimate/materialize threw; never silently ignored. */
  quarantined: string[];
}

export interface AssembledPrompt {
  prompt: string;
  plan: ContextPlan;
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function warn(event: string, resourceId: string, detail?: string): void {
  // Structured log; only the resource id is ever emitted, never contents.
  console.warn({
    timestamp: new Date().toISOString(),
    context: "context-registry",
    event,
    resourceId,
    ...(detail ? { detail } : {}),
  });
}

/** Build a one-off resource without a dedicated factory (skills index, briefs). */
export function inlineResource(args: {
  id: string;
  priority: number;
  text: string;
  fallback?: string;
}): ContextResource {
  const text = args.text;
  return {
    id: args.id,
    priority: args.priority,
    estimateChars: () => text.length,
    materialize: () => text,
    fallback: args.fallback,
  };
}

export class ContextRegistry {
  private readonly resources: ContextResource[] = [];

  register(resource: ContextResource): this {
    if (!ID_PATTERN.test(resource.id))
      throw new Error(`ContextResource id "${resource.id}" is not a safe loggable id`);
    if (!Number.isFinite(resource.priority))
      throw new Error(`ContextResource "${resource.id}" has a non-finite priority`);
    if (this.resources.some((r) => r.id === resource.id))
      throw new Error(`Duplicate ContextResource id "${resource.id}"`);
    if (
      resource.fallback !== undefined &&
      (typeof resource.fallback !== "string" || /\$\{/.test(resource.fallback))
    )
      throw new Error(`ContextResource "${resource.id}" fallback must be a static string`);
    this.resources.push(resource);
    return this;
  }

  async assemble(budgetChars: number): Promise<AssembledPrompt> {
    if (!Number.isFinite(budgetChars) || budgetChars < 0)
      throw new Error("assemble() requires a finite budgetChars >= 0");
    const plan: ContextPlan = {
      budgetChars,
      usedChars: 0,
      included: [],
      fellBack: [],
      dropped: [],
      quarantined: [],
    };
    // Priority descending, id ascending tiebreak (Array.sort is stable).
    const ordered = [...this.resources].sort(
      (a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    let prompt = "";
    const appendSection = (id: string, body: string): boolean => {
      const section = `## ${id}\n${body}`;
      const addition = prompt ? `\n\n${section}` : section;
      if (prompt.length + addition.length > budgetChars) return false;
      prompt += addition;
      return true;
    };
    for (const resource of ordered) {
      let body: string;
      try {
        const estimate = resource.estimateChars();
        if (!Number.isFinite(estimate) || estimate < 0)
          throw new Error(`dishonest estimateChars() returned ${String(estimate)}`);
        const materialized = (await resource.materialize()) ?? "";
        body = String(materialized);
        if (!body.trim()) continue; // Empty section: omit, like the old conditionals did.
        // Lying/mutated resource defense: a section far beyond its honest
        // estimate is truncated to the budgeted amount (a 2MB memory dump
        // cannot blow the context window).
        const cap = estimate > 0 ? estimate : body.length;
        if (body.length > cap * 2) {
          warn("truncated", resource.id, `materialized=${body.length} estimate=${estimate}`);
          body = body.slice(0, cap);
        }
      } catch {
        plan.quarantined.push(resource.id);
        // Only the id is ever logged — never contents, and never the error
        // text either, since a failing materializer could echo data.
        warn("quarantined", resource.id);
        // Quarantined safety resources keep their directive via the static
        // fallback one-liner; anything else is dropped.
        if (resource.fallback !== undefined && appendSection(resource.id, resource.fallback))
          plan.fellBack.push(resource.id);
        else plan.dropped.push(resource.id);
        continue;
      }
      if (appendSection(resource.id, body)) {
        plan.included.push(resource.id);
      } else if (resource.fallback !== undefined && appendSection(resource.id, resource.fallback)) {
        plan.fellBack.push(resource.id);
      } else {
        plan.dropped.push(resource.id);
      }
    }
    plan.usedChars = prompt.length;
    return { prompt, plan };
  }
}
