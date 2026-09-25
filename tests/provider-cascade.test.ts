import assert from "node:assert/strict";
import test from "node:test";
import { type ProviderCandidate, ProviderCascade } from "../apps/server/src/engine/cascade.ts";

test("Provider fallback cascade", async (t) => {
  const candidates: ProviderCandidate[] = [
    { id: "claude", provider: "anthropic", model: "claude-3-5-sonnet", priority: 1 },
    { id: "deepseek", provider: "deepseek", model: "deepseek-chat", priority: 2 },
    { id: "ollama", provider: "local", model: "llama3:latest", priority: 3 },
  ];

  await t.test("uses primary provider when healthy", async () => {
    const cascade = new ProviderCascade(candidates);
    const { result, usedCandidate } = await cascade.executeWithFallback(async (cand) => {
      return `Reply from ${cand.id}`;
    });
    assert.equal(usedCandidate.id, "claude");
    assert.equal(result, "Reply from claude");
  });

  await t.test("falls back to secondary when primary throws 429 rate limit", async () => {
    const cascade = new ProviderCascade(candidates);
    const { result, usedCandidate } = await cascade.executeWithFallback(async (cand) => {
      if (cand.id === "claude") {
        throw new Error("HTTP 429 Too Many Requests");
      }
      return `Reply from ${cand.id}`;
    });
    assert.equal(usedCandidate.id, "deepseek");
    assert.equal(result, "Reply from deepseek");
  });

  await t.test("falls back to local ollama when both cloud providers fail", async () => {
    const cascade = new ProviderCascade(candidates);
    const { result, usedCandidate } = await cascade.executeWithFallback(async (cand) => {
      if (cand.id === "claude") throw new Error("HTTP 503 Outage");
      if (cand.id === "deepseek") throw new Error("HTTP 502 Bad Gateway");
      return `Offline response from ${cand.id}`;
    });
    assert.equal(usedCandidate.id, "ollama");
    assert.equal(result, "Offline response from ollama");
  });

  await t.test("fails explicitly when all providers in cascade fail", async () => {
    const cascade = new ProviderCascade(candidates);
    await assert.rejects(async () => {
      await cascade.executeWithFallback(async () => {
        throw new Error("Network unreachable");
      });
    }, /All providers in fallback cascade failed/);
  });
});
