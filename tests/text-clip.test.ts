import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { describePageDiff, pageLines } from "../apps/server/src/engine/page-diff.ts";
import type { JevAdapter } from "../apps/server/src/jev/adapter.ts";
import { JevService } from "../apps/server/src/jev/service.ts";
import { SearchService } from "../apps/server/src/search.ts";
import { clip, wellFormed } from "../packages/domain/src/text.ts";
import { browserFixture } from "./helpers/browser.ts";
import { modelFixture } from "./helpers/model.ts";
import { searchFixture } from "./helpers/search.ts";

// One non-BMP character: two UTF-16 units, so a bound can land between them.
const pair = String.fromCodePoint(0x1f600);
const replacement = "\uFFFD";
// Independent of the implementation: text only survives a UTF-8 round trip when it is well
// formed, which is exactly what the jsonb driver needs. Encoding a lone surrogate emits U+FFFD.
const survivesUtf8 = (value: string) => Buffer.from(value, "utf8").toString("utf8") === value;

test("a bound landing inside a surrogate pair keeps the pair whole", () => {
  const page = `${"x".repeat(499)}${pair}tail`;
  assert.equal(page.slice(0, 500).endsWith("\uD83D"), true, "the naive bound splits the pair");
  const excerpt = clip(page, 500);
  assert.equal(excerpt, "x".repeat(499));
  assert.equal(survivesUtf8(excerpt), true);
});

test("clipping leaves well-formed text unchanged and within the bound", () => {
  assert.equal(clip("plain copy", 20), "plain copy");
  assert.equal(clip("plain copy", 5), "plain");
  assert.equal(clip(`${pair}${pair}`, 1), "");
  assert.equal(clip("", 100), "");
});

test("an unpaired surrogate the source supplied is replaced, not persisted", () => {
  const hostile = `report \uD83D end`;
  assert.equal(survivesUtf8(hostile), false);
  assert.equal(wellFormed(hostile), `report ${replacement} end`);
  assert.equal(clip(hostile, hostile.length), `report ${replacement} end`);
  assert.equal(survivesUtf8(clip(hostile, hostile.length)), true);
});

test("watched page lines never end inside a surrogate pair", () => {
  const [line] = pageLines(`${"y".repeat(299)}${pair} more`);
  assert.equal(line.length, 299);
  assert.equal(survivesUtf8(line), true);
});

test("a page whose evidence bound splits a surrogate pair still saves its evidence", async (t) => {
  const text = `${"x".repeat(499)}${pair}tail`;
  const browser = await browserFixture(t, (path, body) => {
    if (path === "/sessions") {
      return {
        data: {
          id: String(body.id),
          title: "https://example.org/",
          url: "https://example.org/",
          status: "active",
          updatedAt: new Date().toISOString(),
        },
      };
    }
    if (path.endsWith("/read"))
      return {
        data: { url: "https://example.org/", title: "Emoji page", text, truncated: false },
      };
    throw new Error(`Unexpected browser path: ${path}`);
  });
  const calls = [
    { name: "read_web", arguments: { url: "https://example.org/" } },
    { name: "finish_task", arguments: { summary: "Read the page with an emoji." } },
  ];
  await modelFixture(t, (index) => calls[index]);
  const app = await createApp(browser.db, {
    ...browser.config,
    agentBackend: "model",
    model: "openai/fixture",
  });
  try {
    const task = await app.agent.createTask("clip-owner", { prompt: "Read the emoji page" });
    await app.agent.worker.tick();
    const saved = await app.agent.getTask("clip-owner", task.id);
    assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
    const [evidence] = saved.evidence;
    assert.equal(evidence?.url, "https://example.org/");
    assert.equal(evidence?.excerpt, "x".repeat(499));
    assert.equal(survivesUtf8(evidence?.excerpt ?? ""), true);
  } finally {
    await app.agent.stop();
  }
});

test("a worker session title that ends inside a surrogate pair is stored well formed", async (t) => {
  // 300 units is exactly the worker's own bound, so its code-unit slice keeps the high
  // surrogate of the final emoji and the session record still has to be saved.
  const title = `${"t".repeat(299)}${pair}`;
  const browser = await browserFixture(t, (path, body) => {
    if (path === "/sessions")
      return {
        data: {
          id: String(body.id),
          title: title.slice(0, 300),
          url: String(body.url),
          status: "active",
          updatedAt: new Date().toISOString(),
        },
      };
    throw new Error(`Unexpected browser path: ${path}`);
  });
  const created = await browser.service.create("clip-owner", "https://example.org/");
  assert.equal(created.title, "t".repeat(299));
  const saved = await browser.db.get<{ title: string }>("clip-owner", "browsers", created.id);
  assert.equal(saved?.title, "t".repeat(299));
  assert.equal(survivesUtf8(saved?.title ?? ""), true);
});

test("a page read repairs the title and text bounds before evidence can use them", async (t) => {
  const raw = `${"x".repeat(99_999)}${pair}tail`;
  const browser = await browserFixture(t, (path, body) => {
    if (path === "/sessions")
      return {
        data: {
          id: String(body.id),
          title: "Session",
          url: String(body.url),
          status: "active",
          updatedAt: new Date().toISOString(),
        },
      };
    if (path.endsWith("/read"))
      return {
        data: {
          url: "https://example.org/",
          title: `${"t".repeat(299)}${pair}tail`.slice(0, 300),
          text: raw.slice(0, 100_000),
          truncated: true,
        },
      };
    throw new Error(`Unexpected browser path: ${path}`);
  });
  const created = await browser.service.create("clip-owner", "https://example.org/");
  const page = await browser.service.read("clip-owner", created.id);
  assert.equal(page.title, "t".repeat(299));
  assert.equal(page.text, "x".repeat(99_999));
  assert.equal(survivesUtf8(page.title), true);
  assert.equal(survivesUtf8(page.text), true);
});

test("jev page evidence is stored well formed when its bound splits a surrogate pair", async (t) => {
  const store = await createStore();
  t.after(() => store.close());
  const adapter: JevAdapter = { decide: async () => ({ control: "agent", scores: {} }) };
  const jev = new JevService({ store, adapter, mode: "sample" });
  const reference = "https://example.org/";
  await jev.noteEvidence(
    "clip-owner",
    "thread",
    "run",
    "web",
    reference,
    `${"x".repeat(29_999)}${pair}tail`,
  );
  const id = `thread:run:web:${createHash("sha256").update(reference).digest("hex")}`;
  const record = await store.get<{ text: string }>("clip-owner", "jev_evidence", id);
  assert.equal(record?.text, "x".repeat(29_999));
  assert.equal(survivesUtf8(record?.text ?? ""), true);
});

test("search results are clipped to well-formed titles and excerpts", async (t) => {
  const source = {
    url: "https://example.org/emoji",
    title: `${"t".repeat(299)}${pair}tail`,
    excerpts: [`${"x".repeat(29_999)}${pair}tail`],
  };
  await searchFixture(t, (rpc) =>
    rpc.method === "tools/call"
      ? { result: { content: [], structuredContent: { results: [source] } } }
      : {},
  );
  const store = await createStore();
  t.after(() => store.close());
  const result = await new SearchService(store).search("clip-owner", "chat:clip", {
    objective: "Find public sources",
    search_queries: ["public sources"],
  });
  const [first] = result.results;
  assert.equal(first?.title, "t".repeat(299));
  assert.equal(first?.excerpts[0], "x".repeat(29_999));
  assert.equal(survivesUtf8(first?.title ?? ""), true);
  assert.equal(survivesUtf8(first?.excerpts.join("") ?? ""), true);
  assert.equal(result.truncated, true);
});

test("a task title clipped from a long prompt keeps the pair whole", async (t) => {
  const browser = await browserFixture(t, () => {
    throw new Error("task creation must not contact the worker");
  });
  const app = await createApp(browser.db, browser.config);
  try {
    const prompt = `${"a".repeat(89)}${pair} and a request`;
    const task = await app.agent.createTask("clip-owner", { prompt });
    assert.equal(task.title, "a".repeat(89));
    assert.equal(survivesUtf8(task.title), true);
  } finally {
    await app.agent.stop();
  }
});
test("a trailing high surrogate at the bound is dropped, not replaced", () => {
  // The browser worker hands over text it already clipped at the same limit, so the dangling
  // unit is a real cut. Replacing it would keep a U+FFFD the source never contained.
  assert.equal(clip(`abc\uD800`, 100), "abc");
  assert.equal(clip(`abc\uD800 tail`, 100), `abc${replacement} tail`);
  assert.equal(clip(`abc\uDC00`, 100), `abc${replacement}`);
});

test("a page line bounded again for the change summary stays well formed", () => {
  const line = `${"z".repeat(159)}${pair}tail`;
  assert.equal(pageLines(line)[0], line, "the 300-unit page bound keeps the line intact");
  assert.equal(line.slice(0, 160).endsWith("\uD83D"), true, "a naive 160 bound would split it");
  assert.equal(
    describePageDiff({ added: [line], updated: [], removed: [] }),
    `New:\n\u2022 ${"z".repeat(159)}`,
  );
});

test("a record write repairs nested strings and keys no call site bounded", async (t) => {
  const store = await createStore();
  t.after(() => store.close());
  await store.put("clip-owner", "records", {
    id: "nested",
    title: `client \uD800 title`,
    input: { deep: [`x\uDC00`], "k\uD800": "v" },
  });
  const saved = await store.get<{ title: string; input: Record<string, unknown> }>(
    "clip-owner",
    "records",
    "nested",
  );
  assert.equal(saved?.title, `client ${replacement} title`);
  assert.deepEqual(saved?.input, { deep: [`x${replacement}`], [`k${replacement}`]: "v" });
});

test("two keys that collapse under repair keep the later value, deterministically", async (t) => {
  // wellFormed() maps a lone surrogate and U+FFFD onto the same U+FFFD, so two distinct keys can
  // become one. A jsonb key cannot hold the surrogate, so one value cannot be stored at all;
  // insertion order decides which survives, matching how JSON.parse resolves a duplicate key.
  const store = await createStore();
  t.after(() => store.close());
  const loneSurrogate = `a\uD800x`;
  const repaired = `a${replacement}x`;
  const record = { id: "collapse", [loneSurrogate]: "first", [repaired]: "second" };
  await store.put("clip-owner", "records", record);
  const saved = await store.get<Record<string, string>>("clip-owner", "records", "collapse");
  assert.deepEqual(Object.keys(saved ?? {}).sort(), [repaired, "id"]);
  assert.equal(saved?.[repaired], "second");
});

test("a client title, prompt or nested input cannot fail the task write", async (t) => {
  const browser = await browserFixture(t, () => {
    throw new Error("task creation must not contact the worker");
  });
  const app = await createApp(browser.db, browser.config);
  try {
    const task = await app.agent.createTask("clip-owner", {
      prompt: `summarise \uD800 this`,
      title: `client \uDC00 title`,
      input: { nested: `deep \uD800 value` },
    });
    assert.equal(task.title, `client ${replacement} title`);
    const saved = await app.agent.getTask("clip-owner", task.id);
    assert.equal(survivesUtf8(saved.prompt), true);
    assert.equal(survivesUtf8(JSON.stringify(saved.input)), true);
  } finally {
    await app.agent.stop();
  }
});

test("search does not report truncation for a repaired excerpt inside its budget", async (t) => {
  const source = { url: "https://example.org/short", title: "Short", excerpts: [`a\uD800`] };
  await searchFixture(t, (rpc) =>
    rpc.method === "tools/call"
      ? { result: { content: [], structuredContent: { results: [source] } } }
      : {},
  );
  const store = await createStore();
  t.after(() => store.close());
  const result = await new SearchService(store).search("clip-owner", "chat:clip", {
    objective: "Find public sources",
    search_queries: ["public sources"],
  });
  assert.equal(result.results[0]?.excerpts[0], "a");
  assert.equal(result.truncated, false);
});

test("a value referenced twice is repaired everywhere it appears", async (t) => {
  const store = await createStore();
  t.after(() => store.close());
  const shared = { keep: `shared \uD800 value` };
  await store.put("clip-owner", "records", { id: "shared", first: shared, second: shared });
  const saved = await store.get<{ first: { keep: string }; second: { keep: string } }>(
    "clip-owner",
    "records",
    "shared",
  );
  assert.equal(saved?.first.keep, `shared ${replacement} value`);
  assert.equal(saved?.second.keep, `shared ${replacement} value`);
});
