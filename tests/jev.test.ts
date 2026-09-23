import assert from "node:assert/strict";
import test from "node:test";
import { LiveJevAdapter, rankJevOptions } from "../apps/server/src/jev/adapter.ts";
import { encodeJevAction, jevPanelSchema, parseJevAction } from "../packages/domain/src/jev.ts";

const option = (id: string) => ({
  id,
  label: id,
  details: [],
  sources: [{ title: "Source", url: "https://example.org" }],
});
const panel = () => ({
  id: "p",
  threadId: "t",
  turnId: "r",
  candidateSetVersion: 1,
  type: "comparison",
  title: "Choose",
  mode: "sample",
  options: [option("a")],
});

test("panel validation rejects empty, duplicate and unsourced comparison options", () => {
  assert.throws(() => jevPanelSchema.parse({ ...panel(), options: [] }));
  assert.throws(() => jevPanelSchema.parse({ ...panel(), options: [option("a"), option("a")] }));
  assert.throws(() =>
    jevPanelSchema.parse({ ...panel(), options: [{ ...option("a"), sources: [] }] }),
  );
  assert.throws(() =>
    jevPanelSchema.parse({
      ...panel(),
      options: [{ ...option("a"), sources: [{ title: "bad", url: "file:///x" }] }],
    }),
  );
  assert.throws(() => jevPanelSchema.parse({ ...panel(), candidateSetVersion: 0 }));
});
test("actions round trip and malformed prefixed actions reject", () => {
  const action = { panelId: "p", threadId: "t", candidateSetVersion: 1, optionId: "a" };
  assert.deepEqual(parseJevAction(encodeJevAction(action)), action);
  assert.equal(parseJevAction("ordinary message"), null);
  assert.throws(() => parseJevAction("[OpenMuse choice] bad-json"));
  assert.throws(() =>
    parseJevAction(
      '[OpenMuse choice] {"panelId":"p","threadId":"t","candidateSetVersion":1,"optionId":"a","label":"untrusted"}',
    ),
  );
});
test("ranking uses stable ties and rejects missing, unknown or nonfinite scores", () => {
  const options = [option("a"), option("b")];
  assert.deepEqual(
    rankJevOptions(options, { control: "comparison", scores: { a: 1, b: 1 } }).map((x) => x.id),
    ["a", "b"],
  );
  assert.deepEqual(
    rankJevOptions(options, { control: "comparison", scores: { a: 0, b: 2 } }).map((x) => x.id),
    ["b", "a"],
  );
  assert.throws(() => rankJevOptions(options, { control: "comparison", scores: { a: 1 } }));
  assert.throws(() =>
    rankJevOptions(options, { control: "comparison", scores: { a: 1, b: 2, x: 3 } }),
  );
  assert.throws(() =>
    rankJevOptions(options, { control: "comparison", scores: { a: 1, b: Number.NaN } }),
  );
});
test("live adapter passes signal and validates answers", async () => {
  const signal = new AbortController().signal;
  let seenSignal: AbortSignal | undefined;
  const adapter = new LiveJevAdapter(
    {
      systemOne: async (_request: unknown, opts?: { signal?: AbortSignal }) => {
        seenSignal = opts?.signal;
        return {
          answers: {
            control: { type: "choice", choice: "comparison" },
            fit_0: { type: "score", score: 2 },
          },
        };
      },
    } as never,
    "jev-1.13.0",
  );
  const result = await adapter.decide(
    {
      message: "hands-on",
      context: "source",
      options: [option("a")],
      allowedControls: ["comparison", "agent"],
    },
    signal,
  );
  assert.equal(seenSignal, signal);
  assert.deepEqual(result, { control: "comparison", scores: { a: 2 } });
});

test("live adapter rejects controls outside allowed choices", async () => {
  const adapter = new LiveJevAdapter({
    systemOne: async () => ({
      answers: {
        control: { type: "choice", choice: "clarification" },
        fit_0: { type: "score", score: 2 },
      },
    }),
  } as never);
  await assert.rejects(
    adapter.decide(
      {
        message: "compare",
        context: "source",
        options: [option("a")],
        allowedControls: ["comparison", "agent"],
      },
      new AbortController().signal,
    ),
    /invalid control/,
  );
});
test("live adapter reports network failure without exposing provider detail", async () => {
  const adapter = new LiveJevAdapter({
    systemOne: async () => {
      throw new Error("secret transport details");
    },
  } as never);
  await assert.rejects(
    adapter.decide(
      {
        message: "compare",
        context: "source",
        options: [option("a")],
        allowedControls: ["comparison"],
      },
      new AbortController().signal,
    ),
    (error: Error) =>
      !error.message.includes("secret") && /Jev could not evaluate/.test(error.message),
  );
});

test("preferred refinement option must be visible in the panel", () => {
  assert.equal(jevPanelSchema.parse({ ...panel(), preferredId: "a" }).preferredId, "a");
  assert.throws(() => jevPanelSchema.parse({ ...panel(), preferredId: "not-visible" }));
});

test("live adapter returns controlled error for malformed answers", async () => {
  for (const malformed of [null, undefined, [], "invalid"]) {
    const adapter = new LiveJevAdapter({
      systemOne: async () => ({ answers: malformed }),
    } as never);
    await assert.rejects(
      adapter.decide(
        {
          message: "compare",
          context: "source",
          options: [option("a")],
          allowedControls: ["comparison"],
        },
        new AbortController().signal,
      ),
      /invalid answers/,
    );
  }
});
