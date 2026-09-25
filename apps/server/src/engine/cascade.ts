import type { ProviderId } from "./providers.ts";

export interface ProviderCandidate {
  id: string;
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  priority: number;
}

export interface CascadeHealth {
  candidateId: string;
  provider: ProviderId;
  model: string;
  healthy: boolean;
  failures: number;
  lastFailureTime?: number;
  cooldownUntil?: number;
}

export class ProviderCascade {
  private health = new Map<string, CascadeHealth>();

  constructor(public readonly candidates: ProviderCandidate[] = []) {
    for (const c of candidates) {
      this.health.set(c.id, {
        candidateId: c.id,
        provider: c.provider,
        model: c.model,
        healthy: true,
        failures: 0,
      });
    }
  }

  public getCandidatesInPriority(): ProviderCandidate[] {
    const now = Date.now();
    return [...this.candidates].sort((a, b) => {
      const hA = this.health.get(a.id);
      const hB = this.health.get(b.id);
      const coolA = hA?.cooldownUntil && hA.cooldownUntil > now ? 1 : 0;
      const coolB = hB?.cooldownUntil && hB.cooldownUntil > now ? 1 : 0;
      if (coolA !== coolB) return coolA - coolB;
      return a.priority - b.priority;
    });
  }

  public recordSuccess(candidateId: string): void {
    const h = this.health.get(candidateId);
    if (h) {
      h.healthy = true;
      h.failures = 0;
      h.cooldownUntil = undefined;
    }
  }

  public recordFailure(candidateId: string, error: unknown): void {
    const h = this.health.get(candidateId);
    if (h) {
      h.failures++;
      h.lastFailureTime = Date.now();
      // Cooldown for 2 minutes after repeated failures
      if (h.failures >= 2) {
        h.healthy = false;
        h.cooldownUntil = Date.now() + 2 * 60 * 1000;
      }
    }
    console.warn(
      `[cascade:failure] provider candidate ${candidateId} failed:`,
      error instanceof Error ? error.message : error,
    );
  }

  public async executeWithFallback<T>(
    run: (candidate: ProviderCandidate) => Promise<T>,
  ): Promise<{ result: T; usedCandidate: ProviderCandidate }> {
    const ordered = this.getCandidatesInPriority();
    if (ordered.length === 0) {
      throw new Error("No provider candidates configured in cascade");
    }

    let lastError: unknown = null;
    for (const candidate of ordered) {
      try {
        const result = await run(candidate);
        this.recordSuccess(candidate.id);
        return { result, usedCandidate: candidate };
      } catch (err) {
        lastError = err;
        this.recordFailure(candidate.id, err);
        // Continue to next candidate in cascade
      }
    }

    throw new Error(
      `All providers in fallback cascade failed. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  public getHealthSummary(): CascadeHealth[] {
    return Array.from(this.health.values());
  }
}
