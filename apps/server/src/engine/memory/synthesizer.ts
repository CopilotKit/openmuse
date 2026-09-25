import { tokenize } from "./recall.ts";

export interface SynthesizedFact {
  id: string;
  category: "preference" | "fact" | "entity" | "system";
  text: string;
  tags: string[];
  importance: number; // 1 to 5
  timestamp: string;
}

export class MemorySynthesizer {
  private readonly preferenceRegex =
    /(?:prefer|like|always|never|do not|don't|want|style is)\s+([^.!?\n]+)/i;
  private readonly entityRegex =
    /(?:production\s+)?(?:server|ip|domain|url|database|repo|bot|token)(?:\s+(?:is|at|on|for)){1,3}\s*[:=]?\s*([^\s,;]+)/i;
  private readonly factRegex =
    /(?:my\s+(?:name|role|company|project|email|team)|we\s+(?:are|work|use|build))\s+([^.!?\n]+)/i;

  public extractFacts(messages: Array<{ role: string; content: string }>): SynthesizedFact[] {
    const facts: SynthesizedFact[] = [];
    const now = new Date().toISOString();

    for (const msg of messages) {
      if (msg.role !== "user" && msg.role !== "human") continue;
      const text = msg.content;
      if (!text || text.length < 10) continue;

      // Extract preference
      const prefMatch = text.match(this.preferenceRegex);
      if (prefMatch?.[1] && prefMatch[1].trim().length > 4) {
        const prefText = prefMatch[0].trim();
        facts.push({
          id: `fact_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          category: "preference",
          text: `User preference: ${prefText}`,
          tags: tokenize(prefText).slice(0, 5),
          importance: 4,
          timestamp: now,
        });
      }

      // Extract technical entity / configuration
      const entityMatch = text.match(this.entityRegex);
      if (entityMatch?.[0] && entityMatch[0].trim().length > 5) {
        const entityText = entityMatch[0].trim();
        facts.push({
          id: `fact_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          category: "entity",
          text: `Configuration/Entity: ${entityText}`,
          tags: tokenize(entityText).slice(0, 5),
          importance: 5,
          timestamp: now,
        });
      }

      // Extract general user facts
      const factMatch = text.match(this.factRegex);
      if (factMatch?.[1] && factMatch[1].trim().length > 4) {
        const fText = factMatch[0].trim();
        facts.push({
          id: `fact_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          category: "fact",
          text: `User fact: ${fText}`,
          tags: tokenize(fText).slice(0, 5),
          importance: 3,
          timestamp: now,
        });
      }
    }

    return facts;
  }

  public scoreAssociative(
    fact: SynthesizedFact,
    query: string,
    nowMs: number = Date.now(),
  ): number {
    const queryTokens = new Set(tokenize(query));
    if (queryTokens.size === 0) return 0;

    let matchCount = 0;
    const factTokens = tokenize(fact.text);
    for (const t of factTokens) {
      if (queryTokens.has(t)) matchCount++;
    }
    for (const tag of fact.tags) {
      if (queryTokens.has(tag)) matchCount += 1.5;
    }

    if (matchCount === 0) return 0;

    const ageDays = (nowMs - new Date(fact.timestamp).getTime()) / (1000 * 60 * 60 * 24);
    const recencyMultiplier = Math.max(0.7, 1 - ageDays * 0.01);
    const importanceMultiplier = 1 + fact.importance * 0.2;

    return matchCount * recencyMultiplier * importanceMultiplier;
  }
}
