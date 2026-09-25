import assert from "node:assert/strict";
import test from "node:test";
import { MemorySynthesizer } from "../apps/server/src/engine/memory/synthesizer.ts";

test("Associative memory synthesizer (Hermes-Agent style)", async (t) => {
  const synthesizer = new MemorySynthesizer();

  await t.test("extracts facts, preferences, and configurations from conversation turns", () => {
    const messages = [
      { role: "user", content: "Hi! I prefer dark mode and concise summaries in my reports." },
      {
        role: "assistant",
        content: "Understood, I will keep reports concise with dark mode formatting.",
      },
      { role: "user", content: "Our production server is at 10.10.0.20 running Ubuntu." },
      { role: "user", content: "My role is engineering lead for the OpenMuse project." },
    ];

    const facts = synthesizer.extractFacts(messages);
    assert.equal(facts.length >= 3, true);

    const pref = facts.find((f) => f.category === "preference");
    assert.ok(pref);
    assert.match(pref.text, /prefer dark mode/i);

    const entity = facts.find((f) => f.category === "entity");
    assert.ok(entity);
    assert.match(entity.text, /server is at 10.10.0.20/i);

    const userFact = facts.find((f) => f.category === "fact");
    assert.ok(userFact);
    assert.match(userFact.text, /engineering lead/i);
  });

  await t.test("associative scoring ranks relevant facts higher", () => {
    const facts = [
      {
        id: "f1",
        category: "entity" as const,
        text: "Configuration/Entity: server is at 10.10.0.20",
        tags: ["server", "10", "10", "0", "20"],
        importance: 5,
        timestamp: new Date().toISOString(),
      },
      {
        id: "f2",
        category: "preference" as const,
        text: "User preference: prefer dark mode and concise summaries",
        tags: ["prefer", "dark", "mode", "concise", "summaries"],
        importance: 4,
        timestamp: new Date().toISOString(),
      },
    ];

    const scoreServer = synthesizer.scoreAssociative(facts[0], "deploy to server 10.10.0.20");
    const scorePref = synthesizer.scoreAssociative(facts[1], "deploy to server 10.10.0.20");

    assert.ok(scoreServer > 0);
    assert.equal(scorePref, 0); // No overlap with server query
  });
});
